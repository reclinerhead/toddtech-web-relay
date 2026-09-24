// URL and host policy (guide § 5 rules 3 and 4). Pure; no I/O.

export type PolicyBlocked = "bad-url" | "port-not-allowed" | "host-not-allowed";

export type PolicyResult =
  | { ok: true; url: URL; host: string }
  | { ok: false; blocked: PolicyBlocked; host: string | null };

/** Lowercase and strip one trailing dot. */
export function normalizeHost(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

const HOSTNAME = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;

/**
 * Validate one tenant's allowed_hosts as loaded from config. Returns the
 * normalized set, or throws with a message that names the problem.
 */
export function parseAllowedHosts(raw: unknown): ReadonlySet<string> {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("allowed_hosts must be a non-empty list");
  }
  const hosts = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error("allowed_hosts entries must be non-empty strings");
    }
    const host = normalizeHost(entry.trim());
    if (host.includes("*")) {
      throw new Error(`allowed_hosts entry "${entry}" contains a wildcard; list each host exactly`);
    }
    if (!HOSTNAME.test(host)) {
      throw new Error(`allowed_hosts entry "${entry}" is not a bare hostname`);
    }
    hosts.add(host);
  }
  return hosts;
}

/**
 * Check a target URL against the scheme, port, userinfo, and allowlist rules.
 * On success the returned URL has its hostname normalized, so the fetch and
 * the log see the same name the allowlist matched.
 */
export function validateTarget(
  raw: string | null | undefined,
  allowedHosts: ReadonlySet<string>,
): PolicyResult {
  if (typeof raw !== "string" || raw === "") {
    return { ok: false, blocked: "bad-url", host: null };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, blocked: "bad-url", host: null };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, blocked: "bad-url", host: null };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, blocked: "bad-url", host: null };
  }
  if (url.hostname === "") {
    return { ok: false, blocked: "bad-url", host: null };
  }
  const host = normalizeHost(url.hostname);
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (port !== 80 && port !== 443) {
    return { ok: false, blocked: "port-not-allowed", host };
  }
  if (!allowedHosts.has(host)) {
    return { ok: false, blocked: "host-not-allowed", host };
  }
  url.hostname = host;
  return { ok: true, url, host };
}
