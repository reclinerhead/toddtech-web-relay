import { describe, expect, it, vi } from "vitest";
import { hashKey, type Tenant } from "./auth.ts";
import {
  fetchUpstream,
  type PinnedDispatcher,
  type UpstreamDeps,
  type UpstreamFetchInit,
  type UpstreamLimits,
  type UpstreamResponse,
} from "./upstream.ts";

const tenant: Tenant = {
  name: "hearth",
  keyHash: hashKey("k"),
  allowedHosts: new Set(["www.kalamazoocity.org", "kalamazoocity.org", "cdn.example"]),
  perMinute: 10,
  notes: undefined,
};

const limits: UpstreamLimits = { timeoutMs: 20_000, maxBodyBytes: 64, maxRedirects: 5 };

function stream(bytes: Uint8Array | Uint8Array[]): ReadableStream<Uint8Array> {
  const chunks = Array.isArray(bytes) ? bytes : [bytes];
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function response(
  status: number,
  headers: Record<string, string> = {},
  body: ReadableStream<Uint8Array> | string | null = null,
): UpstreamResponse {
  return {
    status,
    headers: new Headers(headers),
    body: typeof body === "string" ? stream(new TextEncoder().encode(body)) : body,
  };
}

interface Harness {
  deps: UpstreamDeps;
  fetches: { url: string; init: UpstreamFetchInit }[];
  pinned: { address: string; family: 4 | 6 }[];
  destroyed: number;
}

function harness(
  dns: Record<string, string[] | Error>,
  routes: Record<string, UpstreamResponse | (() => Promise<UpstreamResponse>)>,
): Harness {
  const h: Harness = { fetches: [], pinned: [], destroyed: 0, deps: undefined as unknown as UpstreamDeps };
  h.deps = {
    resolve: async (hostname) => {
      const answer = dns[hostname];
      if (answer === undefined) throw new Error(`no fixture for ${hostname}`);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    fetch: async (url, init) => {
      h.fetches.push({ url, init });
      const route = routes[url];
      if (route === undefined) throw new Error(`no route for ${url}`);
      return typeof route === "function" ? route() : route;
    },
    dispatcherFor: (address, family) => {
      h.pinned.push({ address, family });
      return {
        destroy: async () => {
          h.destroyed += 1;
        },
      } as unknown as PinnedDispatcher;
    },
    now: () => performance.now(),
  };
  return h;
}

const PUBLIC = ["93.184.216.34"];

describe("fetchUpstream", () => {
  it("returns the origin's body, status, allowlisted headers, and server, pinned to the first IPv4", async () => {
    const h = harness(
      { "www.kalamazoocity.org": ["2606:4700::1", "93.184.216.34", "93.184.216.35"] },
      {
        "https://www.kalamazoocity.org/page": response(
          200,
          {
            "content-type": "text/html",
            etag: '"e"',
            "set-cookie": "a=b",
            server: "AkamaiGHost",
            "content-length": "5",
          },
          "hello",
        ),
      },
    );
    const outcome = await fetchUpstream(new URL("https://www.kalamazoocity.org/page"), tenant, {}, h.deps, limits);
    expect(outcome.kind).toBe("response");
    if (outcome.kind !== "response") return;
    expect(outcome.status).toBe(200);
    expect(outcome.body.toString()).toBe("hello");
    expect(outcome.passthrough).toEqual({ "content-type": "text/html", etag: '"e"' });
    expect(outcome.server).toBe("AkamaiGHost");
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(h.pinned).toEqual([{ address: "93.184.216.34", family: 4 }]);
    expect(h.destroyed).toBe(1);
    expect(h.fetches[0]?.init.redirect).toBe("manual");
    expect(h.fetches[0]?.init.headers["accept-encoding"]).toBe("identity");
  });

  it("forwards the caller's conditional headers and nothing else", async () => {
    const h = harness({ "www.kalamazoocity.org": PUBLIC }, { "https://www.kalamazoocity.org/": response(304) });
    const outcome = await fetchUpstream(
      new URL("https://www.kalamazoocity.org/"),
      tenant,
      { "if-none-match": '"e"', cookie: "x=y" },
      h.deps,
      limits,
    );
    expect(outcome.kind).toBe("response");
    if (outcome.kind !== "response") return;
    expect(outcome.status).toBe(304);
    expect(outcome.body.byteLength).toBe(0);
    expect(h.fetches[0]?.init.headers["if-none-match"]).toBe('"e"');
    expect(h.fetches[0]?.init.headers).not.toHaveProperty("cookie");
  });

  it("passes an upstream 403 or 429 through without retrying", async () => {
    const h = harness(
      { "www.kalamazoocity.org": PUBLIC },
      { "https://www.kalamazoocity.org/": response(403, { server: "AkamaiGHost" }, "Access Denied") },
    );
    const outcome = await fetchUpstream(new URL("https://www.kalamazoocity.org/"), tenant, {}, h.deps, limits);
    expect(outcome.kind).toBe("response");
    if (outcome.kind !== "response") return;
    expect(outcome.status).toBe(403);
    expect(h.fetches).toHaveLength(1);
  });

  it("refuses a first hop that resolves to a private address without fetching", async () => {
    const h = harness({ "www.kalamazoocity.org": ["93.184.216.34", "192.168.1.1"] }, {});
    const outcome = await fetchUpstream(new URL("https://www.kalamazoocity.org/"), tenant, {}, h.deps, limits);
    expect(outcome).toEqual({
      kind: "blocked",
      status: 403,
      blocked: "private-address",
      elapsedMs: 0,
      upstreamStatus: null,
    });
    expect(h.fetches).toHaveLength(0);
    expect(h.pinned).toHaveLength(0);
  });

  it("returns 502 dns-failed when the name does not resolve", async () => {
    const h = harness({ "www.kalamazoocity.org": new Error("ENOTFOUND") }, {});
    const outcome = await fetchUpstream(new URL("https://www.kalamazoocity.org/"), tenant, {}, h.deps, limits);
    expect(outcome).toMatchObject({ kind: "blocked", status: 502, blocked: "dns-failed", elapsedMs: 0 });
  });

  it("returns 502 upstream-unreachable when the connection fails", async () => {
    const h = harness(
      { "www.kalamazoocity.org": PUBLIC },
      {
        "https://www.kalamazoocity.org/": async () => {
          throw new Error("ECONNREFUSED");
        },
      },
    );
    const outcome = await fetchUpstream(new URL("https://www.kalamazoocity.org/"), tenant, {}, h.deps, limits);
    expect(outcome).toMatchObject({ kind: "blocked", status: 502, blocked: "upstream-unreachable" });
  });

  it("follows an allowlisted redirect, re-resolving and re-pinning each hop", async () => {
    const h = harness(
      { "kalamazoocity.org": ["93.184.216.1"], "www.kalamazoocity.org": ["93.184.216.2"] },
      {
        "https://kalamazoocity.org/": response(301, { location: "https://www.kalamazoocity.org/home" }),
        "https://www.kalamazoocity.org/home": response(302, { location: "/final?x=1" }),
        "https://www.kalamazoocity.org/final?x=1": response(200, { "content-type": "text/html" }, "done"),
      },
    );
    const outcome = await fetchUpstream(new URL("https://kalamazoocity.org/"), tenant, {}, h.deps, limits);
    expect(outcome.kind).toBe("response");
    if (outcome.kind !== "response") return;
    expect(outcome.body.toString()).toBe("done");
    expect(h.fetches.map((f) => f.url)).toEqual([
      "https://kalamazoocity.org/",
      "https://www.kalamazoocity.org/home",
      "https://www.kalamazoocity.org/final?x=1",
    ]);
    expect(h.pinned.map((p) => p.address)).toEqual(["93.184.216.1", "93.184.216.2", "93.184.216.2"]);
    expect(h.destroyed).toBe(3);
  });

  it("refuses a redirect to a host that is not on the allowlist", async () => {
    const h = harness(
      { "www.kalamazoocity.org": PUBLIC, "evil.example": PUBLIC },
      { "https://www.kalamazoocity.org/": response(302, { location: "https://evil.example/" }) },
    );
    const outcome = await fetchUpstream(new URL("https://www.kalamazoocity.org/"), tenant, {}, h.deps, limits);
    expect(outcome).toMatchObject({ kind: "blocked", status: 403, blocked: "host-not-allowed", upstreamStatus: 302 });
    expect(h.fetches).toHaveLength(1);
  });

  it("refuses a redirect to a private address", async () => {
    const h = harness(
      { "www.kalamazoocity.org": PUBLIC, "cdn.example": ["10.0.0.5"] },
      { "https://www.kalamazoocity.org/": response(307, { location: "https://cdn.example/asset" }) },
    );
    const outcome = await fetchUpstream(new URL("https://www.kalamazoocity.org/"), tenant, {}, h.deps, limits);
    expect(outcome).toMatchObject({ kind: "blocked", status: 403, blocked: "private-address", upstreamStatus: 307 });
    expect(h.fetches).toHaveLength(1);
  });

  it("refuses a redirect to a disallowed port or scheme", async () => {
    const h = harness(
      { "www.kalamazoocity.org": PUBLIC },
      {
        "https://www.kalamazoocity.org/p": response(302, { location: "https://www.kalamazoocity.org:8443/" }),
        "https://www.kalamazoocity.org/s": response(302, { location: "ftp://www.kalamazoocity.org/" }),
      },
    );
    expect(await fetchUpstream(new URL("https://www.kalamazoocity.org/p"), tenant, {}, h.deps, limits)).toMatchObject({
      blocked: "port-not-allowed",
      status: 403,
    });
    expect(await fetchUpstream(new URL("https://www.kalamazoocity.org/s"), tenant, {}, h.deps, limits)).toMatchObject({
      blocked: "bad-url",
      status: 403,
    });
  });

  it("stops at the sixth hop with 502 redirect-limit", async () => {
    const routes: Record<string, UpstreamResponse> = {};
    for (let i = 0; i < 7; i++) {
      routes[`https://www.kalamazoocity.org/${i}`] = response(301, {
        location: `https://www.kalamazoocity.org/${i + 1}`,
      });
    }
    const h = harness({ "www.kalamazoocity.org": PUBLIC }, routes);
    const outcome = await fetchUpstream(new URL("https://www.kalamazoocity.org/0"), tenant, {}, h.deps, limits);
    expect(outcome).toMatchObject({ kind: "blocked", status: 502, blocked: "redirect-limit", upstreamStatus: 301 });
    expect(h.fetches).toHaveLength(6); // the original plus five redirects
  });

  it("does not treat 3xx statuses outside the list, or a 3xx without Location, as redirects", async () => {
    const h = harness(
      { "www.kalamazoocity.org": PUBLIC },
      {
        "https://www.kalamazoocity.org/a": response(304, { etag: '"e"' }),
        "https://www.kalamazoocity.org/b": response(302, {}, "no location"),
        "https://www.kalamazoocity.org/c": response(300, { location: "https://evil.example/" }, "choices"),
      },
    );
    for (const [path, status] of [
      ["a", 304],
      ["b", 302],
      ["c", 300],
    ] as const) {
      const outcome = await fetchUpstream(new URL(`https://www.kalamazoocity.org/${path}`), tenant, {}, h.deps, limits);
      expect(outcome).toMatchObject({ kind: "response", status });
    }
    expect(h.fetches).toHaveLength(3);
  });

  it("returns 413 body-too-large from a declared content-length and cancels the body unread", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65));
      },
      cancel,
    });
    const h = harness(
      { "www.kalamazoocity.org": PUBLIC },
      { "https://www.kalamazoocity.org/": response(200, { "content-length": "65" }, body) },
    );
    const outcome = await fetchUpstream(new URL("https://www.kalamazoocity.org/"), tenant, {}, h.deps, limits);
    expect(outcome).toMatchObject({ kind: "blocked", status: 413, blocked: "body-too-large", upstreamStatus: 200 });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it("returns 413 body-too-large with no partial body when a streamed body exceeds the cap", async () => {
    const chunk = new Uint8Array(30).fill(65);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const h = harness(
      { "www.kalamazoocity.org": PUBLIC },
      { "https://www.kalamazoocity.org/": response(200, {}, body) },
    );
    const outcome = await fetchUpstream(new URL("https://www.kalamazoocity.org/"), tenant, {}, h.deps, limits);
    expect(outcome).toMatchObject({ kind: "blocked", status: 413, blocked: "body-too-large" });
    expect(cancelled).toBe(true);
  });

  it("accepts a body exactly at the cap", async () => {
    const h = harness(
      { "www.kalamazoocity.org": PUBLIC },
      { "https://www.kalamazoocity.org/": response(200, {}, stream(new Uint8Array(64))) },
    );
    const outcome = await fetchUpstream(new URL("https://www.kalamazoocity.org/"), tenant, {}, h.deps, limits);
    expect(outcome.kind).toBe("response");
    if (outcome.kind !== "response") return;
    expect(outcome.body.byteLength).toBe(64);
  });

  it("returns 504 upstream-timeout when the deadline passes", async () => {
    const h = harness(
      { "www.kalamazoocity.org": PUBLIC },
      {
        "https://www.kalamazoocity.org/": () =>
          new Promise<UpstreamResponse>((_resolve, reject) => {
            const signal = h.fetches.at(-1)!.init.signal;
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      },
    );
    const outcome = await fetchUpstream(new URL("https://www.kalamazoocity.org/"), tenant, {}, h.deps, {
      ...limits,
      timeoutMs: 10,
    });
    expect(outcome).toMatchObject({ kind: "blocked", status: 504, blocked: "upstream-timeout" });
    expect(h.destroyed).toBe(1);
  });

  it("returns 504 upstream-timeout when the body stalls past the deadline", async () => {
    const h = harness(
      { "www.kalamazoocity.org": PUBLIC },
      {
        "https://www.kalamazoocity.org/": () => {
          const signal = h.fetches.at(-1)!.init.signal;
          const body = new ReadableStream<Uint8Array>({
            pull() {
              return new Promise((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(new Error("aborted")));
              });
            },
          });
          return Promise.resolve(response(200, {}, body));
        },
      },
    );
    const outcome = await fetchUpstream(new URL("https://www.kalamazoocity.org/"), tenant, {}, h.deps, {
      ...limits,
      timeoutMs: 10,
    });
    expect(outcome).toMatchObject({ kind: "blocked", status: 504, blocked: "upstream-timeout" });
  });

  it("uses an IP-literal target directly and strips IPv6 brackets before the range check", async () => {
    const literalTenant: Tenant = { ...tenant, allowedHosts: new Set(["[::1]", "93.184.216.34"]) };
    const h = harness({ "93.184.216.34": ["93.184.216.34"] }, { "http://93.184.216.34/": response(200, {}, "ip") });
    const outcome = await fetchUpstream(new URL("http://93.184.216.34/"), literalTenant, {}, h.deps, limits);
    expect(outcome).toMatchObject({ kind: "response", status: 200 });
    expect(h.pinned).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });
});
