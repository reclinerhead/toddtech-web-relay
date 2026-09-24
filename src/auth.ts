import { createHash, timingSafeEqual } from "node:crypto";

export interface Tenant {
  readonly name: string;
  /** SHA-256 of the plaintext key, 32 bytes. The plaintext never reaches the relay's disk. */
  readonly keyHash: Buffer;
  readonly allowedHosts: ReadonlySet<string>;
  readonly perMinute: number;
  readonly notes: string | undefined;
}

/**
 * The key the caller presented: `Authorization: Bearer <key>` wins; the `key`
 * query param is used only when the header is absent. A header that is
 * present but not a Bearer token is a failed authentication, not a fallback.
 */
export function presentedKey(
  authorization: string | undefined,
  queryKey: string | null,
): string | null {
  if (authorization !== undefined) {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
    return match?.[1] ?? null;
  }
  return queryKey !== null && queryKey !== "" ? queryKey : null;
}

export function hashKey(key: string): Buffer {
  return createHash("sha256").update(key, "utf8").digest();
}

export type Compare = (a: Uint8Array, b: Uint8Array) => boolean;

/** The comparison the relay uses: constant time in the length of the digests. */
export const constantTimeCompare: Compare = timingSafeEqual;

/**
 * Resolve a presented key to a tenant. Every tenant's hash is compared, with
 * no early exit, so the time taken does not depend on which tenant matched.
 */
export function authenticate(
  key: string | null,
  tenants: readonly Tenant[],
  compare: Compare = constantTimeCompare,
): Tenant | null {
  if (key === null) return null;
  const digest = hashKey(key);
  let match: Tenant | null = null;
  for (const tenant of tenants) {
    if (compare(digest, tenant.keyHash)) match = tenant;
  }
  return match;
}
