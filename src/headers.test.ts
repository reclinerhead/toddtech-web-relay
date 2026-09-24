import { describe, expect, it } from "vitest";
import { filterUpstreamHeaders, outboundHeaders, USER_AGENT } from "./headers.ts";

describe("outboundHeaders", () => {
  it("sends the fixed browser-like set with identity encoding", () => {
    const headers = outboundHeaders({});
    expect(headers["user-agent"]).toBe(USER_AGENT);
    expect(headers["accept-encoding"]).toBe("identity");
    expect(headers.accept).toMatch(/text\/html/);
    expect(headers["accept-language"]).toBeDefined();
  });

  it("forwards only If-None-Match and If-Modified-Since from the caller", () => {
    const headers = outboundHeaders({
      "if-none-match": '"abc"',
      "if-modified-since": "Wed, 21 Oct 2015 07:28:00 GMT",
      cookie: "session=1",
      authorization: "Bearer tenant-key",
      "x-forwarded-for": "203.0.113.1",
      "user-agent": "curl/8.0",
      referer: "https://example.com/",
      host: "relay.example",
    });
    expect(headers["if-none-match"]).toBe('"abc"');
    expect(headers["if-modified-since"]).toBe("Wed, 21 Oct 2015 07:28:00 GMT");
    expect(headers).not.toHaveProperty("cookie");
    expect(headers).not.toHaveProperty("authorization");
    expect(headers).not.toHaveProperty("x-forwarded-for");
    expect(headers).not.toHaveProperty("referer");
    expect(headers).not.toHaveProperty("host");
    expect(headers["user-agent"]).toBe(USER_AGENT);
  });

  it("ignores empty conditional headers", () => {
    expect(outboundHeaders({ "if-none-match": "" })).not.toHaveProperty("if-none-match");
  });
});

describe("filterUpstreamHeaders", () => {
  it("passes content-type, etag, and last-modified and drops everything else", () => {
    const upstream = new Headers({
      "content-type": "text/html; charset=utf-8",
      etag: '"v1"',
      "last-modified": "Tue, 23 Sep 2026 12:00:00 GMT",
      "set-cookie": "ak_bmsc=abc; Path=/",
      server: "AkamaiGHost",
      "content-encoding": "gzip",
      "content-length": "1234",
      "cache-control": "max-age=60",
      "x-frame-options": "DENY",
      location: "https://example.com/",
    });
    expect(filterUpstreamHeaders(upstream)).toEqual({
      "content-type": "text/html; charset=utf-8",
      etag: '"v1"',
      "last-modified": "Tue, 23 Sep 2026 12:00:00 GMT",
    });
  });

  it("omits allowlisted headers the origin did not send", () => {
    expect(filterUpstreamHeaders(new Headers({ "content-type": "text/plain" }))).toEqual({
      "content-type": "text/plain",
    });
    expect(filterUpstreamHeaders(new Headers())).toEqual({});
  });
});
