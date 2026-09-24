import { promises as dns } from "node:dns";
import type { IncomingHttpHeaders } from "node:http";
import { isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";
import type { Tenant } from "./auth.ts";
import { MAX_BODY_BYTES, MAX_REDIRECTS, UPSTREAM_TIMEOUT_MS } from "./config.ts";
import { filterUpstreamHeaders, outboundHeaders } from "./headers.ts";
import { validateTarget } from "./policy.ts";
import { pickAddress } from "./private-ranges.ts";

export type UpstreamBlocked =
  | "bad-url"
  | "port-not-allowed"
  | "host-not-allowed"
  | "private-address"
  | "redirect-limit"
  | "dns-failed"
  | "upstream-unreachable"
  | "upstream-timeout"
  | "body-too-large";

export type UpstreamOutcome =
  | {
      kind: "response";
      status: number;
      /** Only the allowlisted upstream headers. */
      passthrough: Record<string, string>;
      /** The origin's `server` header, if it sent one. */
      server: string | null;
      body: Buffer;
      elapsedMs: number;
    }
  | {
      kind: "blocked";
      status: number;
      blocked: UpstreamBlocked;
      elapsedMs: number;
      /** Status of the last origin response seen before the refusal, if any. */
      upstreamStatus: number | null;
    };

/** Every address a name resolves to (A and AAAA). Throws when it resolves to nothing. */
export type Resolver = (hostname: string) => Promise<string[]>;

export interface UpstreamResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: ReadableStream<Uint8Array> | null;
}

export interface UpstreamFetchInit {
  readonly headers: Record<string, string>;
  readonly redirect: "manual";
  readonly signal: AbortSignal;
  readonly dispatcher: Dispatcher;
}

export type FetchLike = (url: string, init: UpstreamFetchInit) => Promise<UpstreamResponse>;

export interface PinnedDispatcher extends Dispatcher {
  destroy(): Promise<void>;
}

export interface UpstreamDeps {
  readonly resolve: Resolver;
  readonly fetch: FetchLike;
  readonly dispatcherFor: (address: string, family: 4 | 6) => PinnedDispatcher;
  readonly now: () => number;
}

export interface UpstreamLimits {
  readonly timeoutMs: number;
  readonly maxBodyBytes: number;
  readonly maxRedirects: number;
}

export const DEFAULT_LIMITS: UpstreamLimits = {
  timeoutMs: UPSTREAM_TIMEOUT_MS,
  maxBodyBytes: MAX_BODY_BYTES,
  maxRedirects: MAX_REDIRECTS,
};

/**
 * Resolve through the system resolver (in the container, the explicit public
 * DNS from compose), not getaddrinfo, so /etc/hosts cannot steer a name.
 */
export const defaultResolver: Resolver = async (hostname) => {
  if (isIP(hostname) !== 0) return [hostname];
  const [a, aaaa] = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)]);
  const addresses = [
    ...(a.status === "fulfilled" ? a.value : []),
    ...(aaaa.status === "fulfilled" ? aaaa.value : []),
  ];
  if (addresses.length === 0) {
    const reason = a.status === "rejected" ? a.reason : aaaa.status === "rejected" ? aaaa.reason : null;
    throw new Error(`DNS resolution failed for ${hostname}: ${(reason as Error | null)?.message ?? "no addresses"}`);
  }
  return addresses;
};

/**
 * A dispatcher whose socket connects to exactly the address the relay
 * validated, while the URL's hostname still drives SNI, certificate
 * verification, and the Host header. Node calls `lookup` with `all: true`
 * when it can select a family itself, and without it otherwise.
 */
export function pinnedDispatcher(address: string, family: 4 | 6): PinnedDispatcher {
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
  return new Agent({ connect: { lookup } });
}

export const defaultDeps: UpstreamDeps = {
  resolve: defaultResolver,
  fetch: undiciFetch as unknown as FetchLike,
  dispatcherFor: pinnedDispatcher,
  now: () => performance.now(),
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Read at most `max` bytes; null when the origin sent more. */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Buffer | null> {
  if (body === null) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch an already-validated target on behalf of a tenant: resolve, refuse
 * private addresses, pin the connection, follow redirects by hand with every
 * hop re-validated, and buffer the body under the cap. One deadline covers
 * the whole thing.
 */
export async function fetchUpstream(
  target: URL,
  tenant: Tenant,
  incoming: IncomingHttpHeaders,
  deps: UpstreamDeps = defaultDeps,
  limits: UpstreamLimits = DEFAULT_LIMITS,
): Promise<UpstreamOutcome> {
  const started = deps.now();
  let fetched = false;
  let lastStatus: number | null = null;
  const elapsed = (): number => (fetched ? Math.max(0, Math.round(deps.now() - started)) : 0);
  const blocked = (status: number, code: UpstreamBlocked): UpstreamOutcome => ({
    kind: "blocked",
    status,
    blocked: code,
    elapsedMs: elapsed(),
    upstreamStatus: lastStatus,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  const headers = outboundHeaders(incoming);
  let url = target;

  try {
    for (let hop = 0; ; hop++) {
      if (hop > limits.maxRedirects) return blocked(502, "redirect-limit");
      if (hop > 0) {
        const policy = validateTarget(url.href, tenant.allowedHosts);
        if (!policy.ok) return blocked(403, policy.blocked);
        url = policy.url;
      }

      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      let addresses: string[];
      try {
        addresses = await deps.resolve(hostname);
      } catch {
        return blocked(502, "dns-failed");
      }
      const pick = pickAddress(addresses);
      if (!pick.ok) return blocked(403, pick.blocked);

      const dispatcher = deps.dispatcherFor(pick.address, pick.family);
      try {
        fetched = true;
        let response: UpstreamResponse;
        try {
          response = await deps.fetch(url.href, {
            headers,
            redirect: "manual",
            signal: controller.signal,
            dispatcher,
          });
        } catch {
          return controller.signal.aborted
            ? blocked(504, "upstream-timeout")
            : blocked(502, "upstream-unreachable");
        }
        lastStatus = response.status;

        if (REDIRECT_STATUSES.has(response.status)) {
          const location = response.headers.get("location");
          if (location !== null) {
            await response.body?.cancel().catch(() => undefined);
            let next: URL;
            try {
              next = new URL(location, url);
            } catch {
              return blocked(403, "bad-url");
            }
            url = next;
            continue;
          }
        }

        const declared = Number(response.headers.get("content-length") ?? "0");
        if (Number.isFinite(declared) && declared > limits.maxBodyBytes) {
          await response.body?.cancel().catch(() => undefined);
          return blocked(413, "body-too-large");
        }

        let body: Buffer | null;
        try {
          body = await readCapped(response.body, limits.maxBodyBytes);
        } catch {
          return controller.signal.aborted
            ? blocked(504, "upstream-timeout")
            : blocked(502, "upstream-unreachable");
        }
        if (body === null) return blocked(413, "body-too-large");

        return {
          kind: "response",
          status: response.status,
          passthrough: filterUpstreamHeaders(response.headers),
          server: response.headers.get("server"),
          body,
          elapsedMs: elapsed(),
        };
      } finally {
        void dispatcher.destroy().catch(() => undefined);
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
