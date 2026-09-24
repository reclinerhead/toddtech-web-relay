import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { authenticate, presentedKey, type Tenant } from "./auth.ts";
import { loadEnv, loadTenants, type RelayConfig } from "./config.ts";
import { writeRequestLog } from "./log.ts";
import { validateTarget } from "./policy.ts";
import { HostGate, Lockout, TenantRateLimiter } from "./rate-limit.ts";
import { fetchUpstream } from "./upstream.ts";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};
export const VERSION: string = pkg.version;

export interface RelayState {
  readonly config: RelayConfig;
  readonly tenants: readonly Tenant[];
  readonly tenantLimiter: TenantRateLimiter;
  readonly hostGate: HostGate;
  readonly lockout: Lockout;
  readonly startedAt: number;
}

const JSON_TYPE = "application/json";

/**
 * The request pipeline, in the order the contract fixes it: method, route,
 * auth (with lockout), URL policy, tenant bucket, host gate, upstream. Every
 * exit writes exactly one log line.
 */
export function createHandler(state: RelayState) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const t = {
      tenant: null as string | null,
      host: null as string | null,
      upstreamStatus: null as number | null,
      elapsedMs: 0,
      bytes: 0,
      blocked: null as string | null,
    };

    const send = (status: number, headers: Record<string, string>, body: Buffer | string): void => {
      res.writeHead(status, headers);
      res.end(body);
      writeRequestLog({
        ts: new Date().toISOString(),
        tenant: t.tenant,
        host: t.host,
        relayStatus: status,
        upstreamStatus: t.upstreamStatus,
        elapsedMs: t.elapsedMs,
        bytes: t.bytes,
        blocked: t.blocked,
      });
    };

    const refuse = (status: number, code: string): void => {
      t.blocked = code;
      const headers: Record<string, string> = {
        "content-type": JSON_TYPE,
        "x-relay-blocked": code,
        "x-relay-elapsed-ms": String(t.elapsedMs),
      };
      if (t.tenant !== null) headers["x-relay-tenant"] = t.tenant;
      if (t.upstreamStatus !== null) headers["x-relay-upstream-status"] = String(t.upstreamStatus);
      send(status, headers, JSON.stringify({ error: code }));
    };

    try {
      if (req.method !== "GET") return refuse(405, "method-not-allowed");

      // The base is a placeholder: only the path and query are used, and the
      // raw request line is never logged.
      const requestUrl = new URL(req.url ?? "/", "http://relay.invalid");

      if (requestUrl.pathname === "/healthz") {
        const body = JSON.stringify({
          ok: true,
          version: VERSION,
          uptimeSeconds: Math.round((Date.now() - state.startedAt) / 1000),
          tenants: state.tenants.length,
        });
        return send(200, { "content-type": JSON_TYPE, "cache-control": "no-store" }, body);
      }
      if (requestUrl.pathname !== "/fetch") return refuse(404, "not-found");

      const source = req.socket.remoteAddress ?? "unknown";
      const key = presentedKey(req.headers.authorization, requestUrl.searchParams.get("key"));
      const tenant = authenticate(key, state.tenants);
      if (tenant === null) {
        if (state.lockout.isLocked(source)) return refuse(401, "locked-out");
        state.lockout.recordFailure(source);
        return refuse(401, "auth-failed");
      }
      t.tenant = tenant.name;

      const policy = validateTarget(requestUrl.searchParams.get("url"), tenant.allowedHosts);
      t.host = policy.host;
      if (!policy.ok) return refuse(403, policy.blocked);

      if (!state.tenantLimiter.take(tenant.name, tenant.perMinute)) return refuse(429, "rate-limited");
      if (!state.hostGate.admit(policy.host)) return refuse(429, "host-throttled");

      const outcome = await fetchUpstream(policy.url, tenant, req.headers);
      t.elapsedMs = outcome.elapsedMs;
      if (outcome.kind === "blocked") {
        t.upstreamStatus = outcome.upstreamStatus;
        return refuse(outcome.status, outcome.blocked);
      }

      t.upstreamStatus = outcome.status;
      t.bytes = outcome.body.byteLength;
      const headers: Record<string, string> = {
        ...outcome.passthrough,
        "content-length": String(outcome.body.byteLength),
        "x-relay-upstream-status": String(outcome.status),
        "x-relay-elapsed-ms": String(outcome.elapsedMs),
        "x-relay-tenant": tenant.name,
      };
      if (outcome.server !== null) headers["x-relay-upstream-server"] = outcome.server;
      return send(outcome.status, headers, outcome.body);
    } catch (error) {
      process.stderr.write(`relay: unhandled error: ${(error as Error).message}\n`);
      if (res.headersSent) res.destroy();
      else refuse(500, "internal-error");
    }
  };
}

export function main(): void {
  let config: RelayConfig;
  let tenants: Tenant[];
  try {
    config = loadEnv();
    tenants = loadTenants(config.tenantsFile);
  } catch (error) {
    process.stderr.write(`relay: refusing to start: ${(error as Error).message}\n`);
    process.exit(1);
  }

  const state: RelayState = {
    config,
    tenants,
    tenantLimiter: new TenantRateLimiter(),
    hostGate: new HostGate(config.hostMinIntervalMs),
    lockout: new Lockout({
      failures: config.lockoutFailures,
      windowMs: config.lockoutWindowMs,
      cooldownMs: config.lockoutCooldownMs,
    }),
    startedAt: Date.now(),
  };

  const server = createServer(createHandler(state));
  server.listen(config.port, config.bind, () => {
    process.stdout.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        event: "listening",
        version: VERSION,
        bind: config.bind,
        port: config.port,
        tenants: tenants.length,
      })}\n`,
    );
  });

  const shutdown = (): void => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
