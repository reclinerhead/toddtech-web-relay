import { describe, expect, it } from "vitest";
import { loadEnv, parseTenants } from "./config.ts";

const HASH = "3f0c1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7";

function yamlWith(block: string): string {
  return `tenants:\n  hearth:\n${block}`;
}

const valid = yamlWith(`    key_sha256: "${HASH}"
    allowed_hosts:
      - www.kalamazoocity.org
      - kalamazoocity.org
    rate_limit:
      per_minute: 10
    notes: "Water advisory watcher"
`);

function errorMessage(text: string): string {
  try {
    parseTenants(text);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected parseTenants to throw");
}

describe("parseTenants", () => {
  it("parses a valid file", () => {
    const [tenant] = parseTenants(valid);
    expect(tenant?.name).toBe("hearth");
    expect(tenant?.keyHash.toString("hex")).toBe(HASH);
    expect([...tenant!.allowedHosts]).toEqual(["www.kalamazoocity.org", "kalamazoocity.org"]);
    expect(tenant?.perMinute).toBe(10);
    expect(tenant?.notes).toBe("Water advisory watcher");
  });

  it("accepts an uppercase hash and stores it lowercased", () => {
    const [tenant] = parseTenants(valid.replace(HASH, HASH.toUpperCase()));
    expect(tenant?.keyHash.toString("hex")).toBe(HASH);
  });

  it("treats notes as optional", () => {
    const [tenant] = parseTenants(valid.replace(/    notes:.*\n/, ""));
    expect(tenant?.notes).toBeUndefined();
  });

  it("requires a top-level tenants map", () => {
    expect(errorMessage("")).toMatch(/top-level `tenants` map/);
    expect(errorMessage("tenants: []")).toMatch(/top-level `tenants` map/);
    expect(errorMessage("hearth:\n  key_sha256: x")).toMatch(/top-level `tenants` map/);
  });

  it("requires key_sha256 to be 64 hex characters, and never echoes it", () => {
    const short = "abc123";
    const message = errorMessage(valid.replace(HASH, short));
    expect(message).toMatch(/tenant "hearth": key_sha256 must be 64 hex characters/);
    expect(message).not.toContain(short);
    const nonHex = "z".repeat(64);
    expect(errorMessage(valid.replace(HASH, nonHex))).not.toContain(nonHex);
    expect(errorMessage(valid.replace(`key_sha256: "${HASH}"`, "key_sha256: 12345"))).toMatch(/key_sha256/);
  });

  it("rejects two tenants sharing a hash", () => {
    const text = `${valid}  other:\n    key_sha256: "${HASH}"\n    allowed_hosts: [example.com]\n    rate_limit: { per_minute: 1 }\n`;
    expect(errorMessage(text)).toMatch(/tenant "other": key_sha256 duplicates/);
  });

  it("rejects an empty, missing, or wildcard allowlist", () => {
    expect(errorMessage(valid.replace(/    allowed_hosts:\n(      - .*\n)+/, "    allowed_hosts: []\n"))).toMatch(
      /tenant "hearth": allowed_hosts must be a non-empty list/,
    );
    expect(errorMessage(valid.replace(/    allowed_hosts:\n(      - .*\n)+/, ""))).toMatch(
      /tenant "hearth": allowed_hosts must be a non-empty list/,
    );
    expect(errorMessage(valid.replace("- kalamazoocity.org", '- "*.kalamazoocity.org"'))).toMatch(/wildcard/);
  });

  it("requires rate_limit.per_minute to be a positive integer", () => {
    expect(errorMessage(valid.replace("per_minute: 10", "per_minute: 0"))).toMatch(/per_minute must be a positive integer/);
    expect(errorMessage(valid.replace("per_minute: 10", "per_minute: 2.5"))).toMatch(/per_minute/);
    expect(errorMessage(valid.replace("per_minute: 10", 'per_minute: "10"'))).toMatch(/per_minute/);
    expect(errorMessage(valid.replace(/    rate_limit:\n      per_minute: 10\n/, ""))).toMatch(/per_minute/);
  });

  it("rejects unknown fields so a typo cannot silently widen a tenant", () => {
    expect(errorMessage(valid.replace("allowed_hosts:", "allowed_host:"))).toMatch(/unknown field "allowed_host"/);
  });

  it("rejects tenant names that are not safe header tokens", () => {
    expect(errorMessage(valid.replace("hearth:", '"he arth":'))).toMatch(/tenant name/);
    expect(errorMessage(valid.replace("hearth:", '"":'))).toMatch(/tenant name/);
  });

  it("allows a file with zero tenants", () => {
    expect(parseTenants("tenants: {}")).toEqual([]);
  });
});

describe("loadEnv", () => {
  it("applies the documented defaults", () => {
    expect(loadEnv({})).toEqual({
      port: 8787,
      bind: "127.0.0.1",
      tenantsFile: "./tenants.yml",
      hostMinIntervalMs: 3000,
      lockoutFailures: 10,
      lockoutWindowMs: 300_000,
      lockoutCooldownMs: 900_000,
    });
  });

  it("reads overrides", () => {
    expect(
      loadEnv({
        RELAY_PORT: "9000",
        RELAY_BIND: "0.0.0.0",
        RELAY_TENANTS_FILE: "/config/tenants.yml",
        RELAY_HOST_MIN_INTERVAL_MS: "5000",
        RELAY_LOCKOUT_FAILURES: "3",
        RELAY_LOCKOUT_WINDOW_MS: "1000",
        RELAY_LOCKOUT_COOLDOWN_MS: "2000",
      }),
    ).toEqual({
      port: 9000,
      bind: "0.0.0.0",
      tenantsFile: "/config/tenants.yml",
      hostMinIntervalMs: 5000,
      lockoutFailures: 3,
      lockoutWindowMs: 1000,
      lockoutCooldownMs: 2000,
    });
  });

  it("refuses a non-positive or non-integer knob", () => {
    expect(() => loadEnv({ RELAY_PORT: "0" })).toThrow(/RELAY_PORT/);
    expect(() => loadEnv({ RELAY_LOCKOUT_FAILURES: "ten" })).toThrow(/RELAY_LOCKOUT_FAILURES/);
    expect(() => loadEnv({ RELAY_HOST_MIN_INTERVAL_MS: "1.5" })).toThrow(/RELAY_HOST_MIN_INTERVAL_MS/);
  });
});
