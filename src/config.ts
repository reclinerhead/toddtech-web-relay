import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { Tenant } from "./auth.ts";
import { parseAllowedHosts } from "./policy.ts";

export interface RelayConfig {
  readonly port: number;
  readonly bind: string;
  readonly tenantsFile: string;
  readonly hostMinIntervalMs: number;
  readonly lockoutFailures: number;
  readonly lockoutWindowMs: number;
  readonly lockoutCooldownMs: number;
}

// Fixed by the contract, not tunable: guide § 5 rule 6.
export const UPSTREAM_TIMEOUT_MS = 20_000;
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
export const MAX_REDIRECTS = 5;

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  return {
    port: positiveInt(env, "RELAY_PORT", 8787),
    bind: env.RELAY_BIND && env.RELAY_BIND !== "" ? env.RELAY_BIND : "127.0.0.1",
    tenantsFile: env.RELAY_TENANTS_FILE && env.RELAY_TENANTS_FILE !== "" ? env.RELAY_TENANTS_FILE : "./tenants.yml",
    hostMinIntervalMs: positiveInt(env, "RELAY_HOST_MIN_INTERVAL_MS", 3000),
    lockoutFailures: positiveInt(env, "RELAY_LOCKOUT_FAILURES", 10),
    lockoutWindowMs: positiveInt(env, "RELAY_LOCKOUT_WINDOW_MS", 300_000),
    lockoutCooldownMs: positiveInt(env, "RELAY_LOCKOUT_COOLDOWN_MS", 900_000),
  };
}

const TENANT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;
const TENANT_KEYS = new Set(["key_sha256", "allowed_hosts", "rate_limit", "notes"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse the tenants YAML. Every error message names the tenant and the
 * field; none ever includes the value of `key_sha256`.
 */
export function parseTenants(text: string): Tenant[] {
  const doc: unknown = parseYaml(text);
  if (!isRecord(doc) || !isRecord(doc.tenants)) {
    throw new Error("tenants file must have a top-level `tenants` map");
  }
  const tenants: Tenant[] = [];
  const seenHashes = new Set<string>();
  for (const [name, block] of Object.entries(doc.tenants)) {
    if (!TENANT_NAME.test(name)) {
      throw new Error(`tenant name "${name}" must be 1-64 characters of letters, digits, ".", "_", or "-"`);
    }
    if (!isRecord(block)) throw new Error(`tenant "${name}" must be a map`);
    for (const key of Object.keys(block)) {
      if (!TENANT_KEYS.has(key)) throw new Error(`tenant "${name}": unknown field "${key}"`);
    }
    const { key_sha256: hash, allowed_hosts: hosts, rate_limit: rate, notes } = block;
    if (typeof hash !== "string" || !SHA256_HEX.test(hash)) {
      throw new Error(`tenant "${name}": key_sha256 must be 64 hex characters`);
    }
    const hashLower = hash.toLowerCase();
    if (seenHashes.has(hashLower)) throw new Error(`tenant "${name}": key_sha256 duplicates another tenant's`);
    seenHashes.add(hashLower);
    let allowedHosts: ReadonlySet<string>;
    try {
      allowedHosts = parseAllowedHosts(hosts);
    } catch (error) {
      throw new Error(`tenant "${name}": ${(error as Error).message}`);
    }
    if (!isRecord(rate) || !Number.isInteger(rate.per_minute) || (rate.per_minute as number) <= 0) {
      throw new Error(`tenant "${name}": rate_limit.per_minute must be a positive integer`);
    }
    if (notes !== undefined && typeof notes !== "string") {
      throw new Error(`tenant "${name}": notes must be a string`);
    }
    tenants.push({
      name,
      keyHash: Buffer.from(hashLower, "hex"),
      allowedHosts,
      perMinute: rate.per_minute as number,
      notes,
    });
  }
  return tenants;
}

export function loadTenants(path: string): Tenant[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read tenants file ${path}: ${(error as Error).message}`);
  }
  return parseTenants(text);
}
