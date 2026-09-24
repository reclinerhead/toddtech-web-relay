import { describe, expect, it } from "vitest";
import { normalizeHost, parseAllowedHosts, validateTarget } from "./policy.ts";

const allowed = new Set(["www.kalamazoocity.org", "kalamazoocity.org", "93.184.216.34"]);

describe("normalizeHost", () => {
  it("lowercases and strips one trailing dot", () => {
    expect(normalizeHost("WWW.Example.COM.")).toBe("www.example.com");
    expect(normalizeHost("example.com..")).toBe("example.com.");
  });
});

describe("parseAllowedHosts", () => {
  it("normalizes case and trailing dots and de-duplicates", () => {
    expect([...parseAllowedHosts(["WWW.Example.com.", "www.example.com", "Other.org"])]).toEqual([
      "www.example.com",
      "other.org",
    ]);
  });

  it("rejects an empty list", () => {
    expect(() => parseAllowedHosts([])).toThrow(/non-empty/);
  });

  it("rejects a missing or non-list value", () => {
    expect(() => parseAllowedHosts(undefined)).toThrow(/non-empty list/);
    expect(() => parseAllowedHosts("example.com")).toThrow(/non-empty list/);
  });

  it("rejects wildcards", () => {
    expect(() => parseAllowedHosts(["*.example.com"])).toThrow(/wildcard/);
    expect(() => parseAllowedHosts(["*"])).toThrow(/wildcard/);
  });

  it("rejects empty strings, schemes, ports, and paths", () => {
    expect(() => parseAllowedHosts([""])).toThrow(/non-empty strings/);
    expect(() => parseAllowedHosts(["   "])).toThrow(/non-empty strings/);
    expect(() => parseAllowedHosts(["https://example.com"])).toThrow(/bare hostname/);
    expect(() => parseAllowedHosts(["example.com:8080"])).toThrow(/bare hostname/);
    expect(() => parseAllowedHosts(["example.com/path"])).toThrow(/bare hostname/);
  });
});

describe("validateTarget", () => {
  it("accepts an allowlisted https URL and keeps its path and query", () => {
    const result = validateTarget("https://www.kalamazoocity.org/Residents/Water?x=1&y=2", allowed);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.host).toBe("www.kalamazoocity.org");
    expect(result.url.href).toBe("https://www.kalamazoocity.org/Residents/Water?x=1&y=2");
  });

  it("accepts http as well as https", () => {
    expect(validateTarget("http://kalamazoocity.org/", allowed).ok).toBe(true);
  });

  it("matches the host case-insensitively and ignores one trailing dot", () => {
    const result = validateTarget("https://WWW.KalamazooCity.ORG./page", allowed);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.host).toBe("www.kalamazoocity.org");
    expect(result.url.hostname).toBe("www.kalamazoocity.org");
  });

  it("refuses a missing, empty, relative, or unparseable target as bad-url", () => {
    for (const raw of [null, undefined, "", "/relative", "www.kalamazoocity.org/page", "not a url", "https://"]) {
      expect(validateTarget(raw, allowed)).toEqual({ ok: false, blocked: "bad-url", host: null });
    }
  });

  it("refuses non-http schemes as bad-url", () => {
    for (const raw of ["ftp://www.kalamazoocity.org/", "file:///etc/passwd", "gopher://kalamazoocity.org/"]) {
      expect(validateTarget(raw, allowed)).toEqual({ ok: false, blocked: "bad-url", host: null });
    }
  });

  it("refuses userinfo as bad-url", () => {
    expect(validateTarget("https://user:pw@www.kalamazoocity.org/", allowed)).toEqual({
      ok: false,
      blocked: "bad-url",
      host: null,
    });
    expect(validateTarget("https://user@www.kalamazoocity.org/", allowed)).toEqual({
      ok: false,
      blocked: "bad-url",
      host: null,
    });
  });

  it("allows only ports 80 and 443, explicit or default", () => {
    expect(validateTarget("https://www.kalamazoocity.org:443/", allowed).ok).toBe(true);
    expect(validateTarget("http://www.kalamazoocity.org:80/", allowed).ok).toBe(true);
    expect(validateTarget("http://www.kalamazoocity.org:443/", allowed).ok).toBe(true);
    expect(validateTarget("https://www.kalamazoocity.org:8443/", allowed)).toEqual({
      ok: false,
      blocked: "port-not-allowed",
      host: "www.kalamazoocity.org",
    });
    expect(validateTarget("http://www.kalamazoocity.org:8080/", allowed)).toEqual({
      ok: false,
      blocked: "port-not-allowed",
      host: "www.kalamazoocity.org",
    });
  });

  it("refuses a host that is not on the tenant's allowlist and reports the host", () => {
    expect(validateTarget("https://example.com/", allowed)).toEqual({
      ok: false,
      blocked: "host-not-allowed",
      host: "example.com",
    });
    expect(validateTarget("https://sub.kalamazoocity.org/", allowed)).toEqual({
      ok: false,
      blocked: "host-not-allowed",
      host: "sub.kalamazoocity.org",
    });
    expect(validateTarget("https://10.0.0.1/", allowed)).toEqual({
      ok: false,
      blocked: "host-not-allowed",
      host: "10.0.0.1",
    });
  });

  it("accepts an IP literal only when the tenant allowlisted it exactly", () => {
    expect(validateTarget("http://93.184.216.34/", allowed).ok).toBe(true);
  });

  it("checks the port before the allowlist", () => {
    expect(validateTarget("https://example.com:8443/", allowed).ok).toBe(false);
    const result = validateTarget("https://example.com:8443/", allowed);
    if (result.ok) return;
    expect(result.blocked).toBe("port-not-allowed");
  });
});
