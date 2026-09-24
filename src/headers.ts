import type { IncomingHttpHeaders } from "node:http";

/** One stable browser-like identity. No rotation: guide § 6. */
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/** The only caller headers forwarded upstream. */
export const FORWARDED_REQUEST_HEADERS = ["if-none-match", "if-modified-since"] as const;

/** The only upstream headers returned to the caller. Everything else, including set-cookie, is dropped. */
export const PASSTHROUGH_RESPONSE_HEADERS = ["content-type", "etag", "last-modified"] as const;

/**
 * Headers sent to the origin: a fixed browser-like set, plus the two
 * conditional-request headers when the caller supplied them. Accept-Encoding
 * is identity so the body the relay buffers and returns is uncompressed.
 */
export function outboundHeaders(incoming: IncomingHttpHeaders): Record<string, string> {
  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "accept-encoding": "identity",
    "upgrade-insecure-requests": "1",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
  };
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = incoming[name];
    if (typeof value === "string" && value !== "") headers[name] = value;
  }
  return headers;
}

/** Keep only the allowlisted upstream response headers. */
export function filterUpstreamHeaders(upstream: { get(name: string): string | null }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
    const value = upstream.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}
