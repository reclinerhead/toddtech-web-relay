import { describe, expect, it } from "vitest";
import { isDeniedAddress, pickAddress } from "./private-ranges.ts";

describe("isDeniedAddress", () => {
  it.each([
    ["0.0.0.1", "this network"],
    ["10.0.0.1", "10/8"],
    ["10.255.255.255", "10/8 top"],
    ["100.64.0.1", "CGNAT / tailnet bottom"],
    ["100.100.100.100", "CGNAT / tailnet"],
    ["100.127.255.255", "CGNAT / tailnet top"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback top"],
    ["169.254.169.254", "link-local / cloud metadata"],
    ["172.16.0.1", "172.16/12 bottom"],
    ["172.31.255.255", "172.16/12 top"],
    ["192.168.0.1", "192.168/16"],
    ["192.168.255.255", "192.168/16 top"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.255", "multicast top"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "broadcast"],
  ])("refuses IPv4 %s (%s)", (address) => {
    expect(isDeniedAddress(address)).toBe(true);
  });

  it.each([
    ["8.8.8.8"],
    ["1.1.1.1"],
    ["100.63.255.255"],
    ["100.128.0.0"],
    ["172.15.255.255"],
    ["172.32.0.0"],
    ["192.167.255.255"],
    ["192.169.0.0"],
    ["223.255.255.255"],
  ])("allows public IPv4 %s", (address) => {
    expect(isDeniedAddress(address)).toBe(false);
  });

  it.each([
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["fc00::1", "unique local bottom"],
    ["fd12:3456:789a::1", "unique local"],
    ["fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "unique local top"],
    ["fe80::1", "link-local"],
    ["fe80::1%eth0", "link-local with zone id"],
    ["febf::1", "link-local top"],
    ["ff02::1", "multicast"],
  ])("refuses IPv6 %s (%s)", (address) => {
    expect(isDeniedAddress(address)).toBe(true);
  });

  it.each([
    ["::ffff:127.0.0.1", "mapped loopback"],
    ["::ffff:10.0.0.1", "mapped 10/8"],
    ["::ffff:172.16.5.5", "mapped 172.16/12"],
    ["::ffff:192.168.1.1", "mapped 192.168/16"],
    ["::ffff:c0a8:101", "mapped 192.168/16, hex form"],
    ["::ffff:169.254.169.254", "mapped link-local"],
    ["::ffff:100.64.0.1", "mapped tailnet"],
    ["::ffff:0.0.0.0", "mapped unspecified"],
  ])("refuses IPv4-mapped %s (%s)", (address) => {
    expect(isDeniedAddress(address)).toBe(true);
  });

  it.each([["2606:4700::1111"], ["2001:4860:4860::8888"], ["::ffff:8.8.8.8"], ["fe00::1"], ["fec0::1"]])(
    "allows public IPv6 %s",
    (address) => {
      expect(isDeniedAddress(address)).toBe(false);
    },
  );

  it("refuses anything that is not an IP address", () => {
    expect(isDeniedAddress("localhost")).toBe(true);
    expect(isDeniedAddress("")).toBe(true);
    expect(isDeniedAddress("example.com")).toBe(true);
  });
});

describe("pickAddress", () => {
  it("refuses an empty answer", () => {
    expect(pickAddress([])).toEqual({ ok: false, blocked: "private-address" });
  });

  it("refuses a name with one public and one private address", () => {
    expect(pickAddress(["93.184.216.34", "10.0.0.1"])).toEqual({ ok: false, blocked: "private-address" });
    expect(pickAddress(["2606:4700::1111", "::ffff:192.168.1.1"])).toEqual({
      ok: false,
      blocked: "private-address",
    });
  });

  it("pins to the first IPv4 address when one exists", () => {
    expect(pickAddress(["2606:4700::1111", "1.1.1.1", "1.0.0.1"])).toEqual({
      ok: true,
      address: "1.1.1.1",
      family: 4,
    });
  });

  it("pins to the first IPv6 address when there is no IPv4", () => {
    expect(pickAddress(["2606:4700::1111", "2606:4700::1001"])).toEqual({
      ok: true,
      address: "2606:4700::1111",
      family: 6,
    });
  });
});
