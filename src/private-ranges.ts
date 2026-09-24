import { BlockList, isIP } from "node:net";

// Guide § 5 rule 5. The relay can reach every house machine over the LAN and
// the tailnet; this list is the only reason it is safe to expose to the
// internet. Never loosen it, never add a bypass for a "trusted" caller.
const denied = new BlockList();

// IPv4
denied.addSubnet("0.0.0.0", 8, "ipv4"); // "this" network
denied.addSubnet("10.0.0.0", 8, "ipv4"); // private
denied.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT: the tailnet lives here
denied.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
denied.addSubnet("169.254.0.0", 16, "ipv4"); // link-local, cloud metadata
denied.addSubnet("172.16.0.0", 12, "ipv4"); // private; Docker bridges
denied.addSubnet("192.168.0.0", 16, "ipv4"); // private; the LAN
denied.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
denied.addSubnet("240.0.0.0", 4, "ipv4"); // reserved, broadcast

// IPv6. IPv4-mapped addresses (::ffff:a.b.c.d) are checked by BlockList
// against the IPv4 rules above, so a mapped private address is refused too.
denied.addAddress("::", "ipv6"); // unspecified
denied.addAddress("::1", "ipv6"); // loopback
denied.addSubnet("fc00::", 7, "ipv6"); // unique local
denied.addSubnet("fe80::", 10, "ipv6"); // link-local
denied.addSubnet("ff00::", 8, "ipv6"); // multicast

/** True when the address must never be connected to. Non-IP input is refused. */
export function isDeniedAddress(address: string): boolean {
  const bare = address.split("%")[0] ?? address; // drop an IPv6 zone id
  const family = isIP(bare);
  if (family === 4) return denied.check(bare, "ipv4");
  if (family === 6) return denied.check(bare, "ipv6");
  return true;
}

export type AddressPick =
  | { ok: true; address: string; family: 4 | 6 }
  | { ok: false; blocked: "private-address" };

/**
 * Given every address a name resolved to, refuse if any is denied; otherwise
 * choose the one address the connection will be pinned to: the first IPv4,
 * else the first IPv6.
 */
export function pickAddress(addresses: readonly string[]): AddressPick {
  if (addresses.length === 0 || addresses.some(isDeniedAddress)) {
    return { ok: false, blocked: "private-address" };
  }
  const v4 = addresses.find((a) => isIP(a) === 4);
  const address = v4 ?? addresses[0]!;
  return { ok: true, address, family: v4 ? 4 : 6 };
}
