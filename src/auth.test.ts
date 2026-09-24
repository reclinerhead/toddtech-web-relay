import { timingSafeEqual } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { authenticate, constantTimeCompare, hashKey, presentedKey, type Tenant } from "./auth.ts";

function tenant(name: string, key: string): Tenant {
  return {
    name,
    keyHash: hashKey(key),
    allowedHosts: new Set(["example.com"]),
    perMinute: 10,
    notes: undefined,
  };
}

const tenants = [tenant("hearth", "hearth-secret"), tenant("other", "other-secret")];

describe("presentedKey", () => {
  it("takes the Bearer token from the Authorization header", () => {
    expect(presentedKey("Bearer abc123", null)).toBe("abc123");
    expect(presentedKey("bearer abc123", null)).toBe("abc123");
    expect(presentedKey("Bearer   abc123  ", null)).toBe("abc123");
  });

  it("prefers the header over the query param", () => {
    expect(presentedKey("Bearer from-header", "from-query")).toBe("from-header");
  });

  it("falls back to the query param only when the header is absent", () => {
    expect(presentedKey(undefined, "from-query")).toBe("from-query");
    expect(presentedKey(undefined, null)).toBeNull();
    expect(presentedKey(undefined, "")).toBeNull();
  });

  it("treats a malformed header as no key, without falling back to the query", () => {
    expect(presentedKey("Basic dXNlcjpwdw==", "from-query")).toBeNull();
    expect(presentedKey("Bearer", "from-query")).toBeNull();
    expect(presentedKey("", "from-query")).toBeNull();
  });
});

describe("authenticate", () => {
  it("resolves a correct key to its tenant", () => {
    expect(authenticate("hearth-secret", tenants)?.name).toBe("hearth");
    expect(authenticate("other-secret", tenants)?.name).toBe("other");
  });

  it("rejects a wrong, empty, or missing key", () => {
    expect(authenticate("hearth-secret ", tenants)).toBeNull();
    expect(authenticate("HEARTH-SECRET", tenants)).toBeNull();
    expect(authenticate("", tenants)).toBeNull();
    expect(authenticate(null, tenants)).toBeNull();
  });

  it("rejects everything when there are no tenants", () => {
    expect(authenticate("hearth-secret", [])).toBeNull();
  });

  it("uses crypto.timingSafeEqual as the comparison", () => {
    expect(constantTimeCompare).toBe(timingSafeEqual);
  });

  it("compares 32-byte digests against every tenant with no early exit", () => {
    const compare = vi.fn((a: Uint8Array, b: Uint8Array) => timingSafeEqual(a, b));
    expect(authenticate("hearth-secret", tenants, compare)?.name).toBe("hearth");
    expect(compare).toHaveBeenCalledTimes(tenants.length);
    for (const [a, b] of compare.mock.calls) {
      expect(a.byteLength).toBe(32);
      expect(b.byteLength).toBe(32);
    }
  });
});

describe("hashKey", () => {
  it("is SHA-256 of the UTF-8 key", () => {
    expect(hashKey("abc").toString("hex")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
