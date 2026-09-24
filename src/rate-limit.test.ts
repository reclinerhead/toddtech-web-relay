import { describe, expect, it } from "vitest";
import { HostGate, Lockout, TenantRateLimiter } from "./rate-limit.ts";

function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("TenantRateLimiter", () => {
  it("admits per_minute requests then refuses", () => {
    const clock = fakeClock();
    const limiter = new TenantRateLimiter(clock.now);
    for (let i = 0; i < 10; i++) expect(limiter.take("hearth", 10)).toBe(true);
    expect(limiter.take("hearth", 10)).toBe(false);
  });

  it("refills at per_minute per minute", () => {
    const clock = fakeClock();
    const limiter = new TenantRateLimiter(clock.now);
    for (let i = 0; i < 10; i++) limiter.take("hearth", 10);
    expect(limiter.take("hearth", 10)).toBe(false);
    clock.advance(6_000); // one token
    expect(limiter.take("hearth", 10)).toBe(true);
    expect(limiter.take("hearth", 10)).toBe(false);
    clock.advance(60_000); // full again, capped at capacity
    for (let i = 0; i < 10; i++) expect(limiter.take("hearth", 10)).toBe(true);
    expect(limiter.take("hearth", 10)).toBe(false);
  });

  it("keeps tenants independent", () => {
    const clock = fakeClock();
    const limiter = new TenantRateLimiter(clock.now);
    for (let i = 0; i < 2; i++) limiter.take("small", 2);
    expect(limiter.take("small", 2)).toBe(false);
    expect(limiter.take("big", 100)).toBe(true);
  });
});

describe("HostGate", () => {
  it("admits one fetch per host per interval, across callers", () => {
    const clock = fakeClock();
    const gate = new HostGate(3000, clock.now);
    expect(gate.admit("www.kalamazoocity.org")).toBe(true);
    expect(gate.admit("www.kalamazoocity.org")).toBe(false);
    clock.advance(2999);
    expect(gate.admit("www.kalamazoocity.org")).toBe(false);
    clock.advance(1);
    expect(gate.admit("www.kalamazoocity.org")).toBe(true);
  });

  it("reserves the slot at admission", () => {
    const clock = fakeClock();
    const gate = new HostGate(3000, clock.now);
    gate.admit("example.com");
    clock.advance(1000);
    expect(gate.admit("example.com")).toBe(false);
    clock.advance(2000); // 3000 since the admitted one, not since the refused one
    expect(gate.admit("example.com")).toBe(true);
  });

  it("keeps hosts independent", () => {
    const clock = fakeClock();
    const gate = new HostGate(3000, clock.now);
    expect(gate.admit("a.example")).toBe(true);
    expect(gate.admit("b.example")).toBe(true);
    expect(gate.admit("a.example")).toBe(false);
  });
});

describe("Lockout", () => {
  const options = { failures: 3, windowMs: 1000, cooldownMs: 5000 };

  it("is not locked before the threshold", () => {
    const clock = fakeClock();
    const lockout = new Lockout(options, clock.now);
    expect(lockout.isLocked("peer")).toBe(false);
    lockout.recordFailure("peer");
    lockout.recordFailure("peer");
    expect(lockout.isLocked("peer")).toBe(false);
  });

  it("locks at the threshold and releases after the cooldown", () => {
    const clock = fakeClock();
    const lockout = new Lockout(options, clock.now);
    for (let i = 0; i < 3; i++) lockout.recordFailure("peer");
    expect(lockout.isLocked("peer")).toBe(true);
    clock.advance(4999);
    expect(lockout.isLocked("peer")).toBe(true);
    clock.advance(1);
    expect(lockout.isLocked("peer")).toBe(false);
    // The counter restarts after release.
    lockout.recordFailure("peer");
    expect(lockout.isLocked("peer")).toBe(false);
  });

  it("only counts failures inside the window", () => {
    const clock = fakeClock();
    const lockout = new Lockout(options, clock.now);
    lockout.recordFailure("peer");
    lockout.recordFailure("peer");
    clock.advance(1000);
    lockout.recordFailure("peer");
    expect(lockout.isLocked("peer")).toBe(false);
    lockout.recordFailure("peer");
    lockout.recordFailure("peer");
    expect(lockout.isLocked("peer")).toBe(true);
  });

  it("keeps sources independent", () => {
    const clock = fakeClock();
    const lockout = new Lockout(options, clock.now);
    for (let i = 0; i < 3; i++) lockout.recordFailure("scanner");
    expect(lockout.isLocked("scanner")).toBe(true);
    expect(lockout.isLocked("peer")).toBe(false);
  });

  it("never blocks a caller that does not fail: lockout is consulted only after a failed key", () => {
    // The relay authenticates first and asks isLocked only on failure, so a
    // valid key from a locked source still passes. This pins the API shape:
    // there is no "is this source allowed to try" call.
    const clock = fakeClock();
    const lockout = new Lockout(options, clock.now);
    for (let i = 0; i < 3; i++) lockout.recordFailure("funnel-peer");
    expect(lockout.isLocked("funnel-peer")).toBe(true);
    expect(Object.getOwnPropertyNames(Lockout.prototype).sort()).toEqual(
      ["constructor", "isLocked", "recordFailure"].sort(),
    );
  });
});
