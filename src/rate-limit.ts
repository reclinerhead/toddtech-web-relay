// Guide § 5 rules 7 and 8. All three limiters take an injectable clock so the
// tests can move time without waiting.

export type Clock = () => number;

/**
 * Per-tenant token bucket. Capacity and refill rate are both the tenant's
 * `rate_limit.per_minute`: a full minute of quiet restores a full bucket.
 */
export class TenantRateLimiter {
  readonly #buckets = new Map<string, { tokens: number; last: number }>();
  readonly #clock: Clock;

  constructor(clock: Clock = Date.now) {
    this.#clock = clock;
  }

  take(tenant: string, perMinute: number): boolean {
    const now = this.#clock();
    let bucket = this.#buckets.get(tenant);
    if (bucket === undefined) {
      bucket = { tokens: perMinute, last: now };
      this.#buckets.set(tenant, bucket);
    } else {
      const refill = ((now - bucket.last) / 60_000) * perMinute;
      bucket.tokens = Math.min(perMinute, bucket.tokens + refill);
      bucket.last = now;
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }
}

/**
 * Global per-upstream-host gate: at most one admitted fetch per hostname per
 * interval, across every tenant. The slot is taken at admission, so a fetch
 * that is later refused still counts against the host.
 */
export class HostGate {
  readonly #last = new Map<string, number>();
  readonly #intervalMs: number;
  readonly #clock: Clock;

  constructor(intervalMs: number, clock: Clock = Date.now) {
    this.#intervalMs = intervalMs;
    this.#clock = clock;
  }

  admit(host: string): boolean {
    const now = this.#clock();
    const previous = this.#last.get(host);
    if (previous !== undefined && now - previous < this.#intervalMs) return false;
    this.#last.set(host, now);
    return true;
  }
}

export interface LockoutOptions {
  /** Failed authentications inside the window that trigger a cooldown. */
  readonly failures: number;
  readonly windowMs: number;
  readonly cooldownMs: number;
}

/**
 * Bad-key lockout keyed by source. The relay consults `isLocked` only after
 * a key has failed to authenticate, so a valid key is never locked out; see
 * the Phase 1 issue for why that matters behind Funnel.
 */
export class Lockout {
  readonly #failures = new Map<string, number[]>();
  readonly #cooldownUntil = new Map<string, number>();
  readonly #options: LockoutOptions;
  readonly #clock: Clock;

  constructor(options: LockoutOptions, clock: Clock = Date.now) {
    this.#options = options;
    this.#clock = clock;
  }

  isLocked(source: string): boolean {
    const until = this.#cooldownUntil.get(source);
    if (until === undefined) return false;
    if (this.#clock() >= until) {
      this.#cooldownUntil.delete(source);
      this.#failures.delete(source);
      return false;
    }
    return true;
  }

  recordFailure(source: string): void {
    const now = this.#clock();
    const { failures, windowMs, cooldownMs } = this.#options;
    const recent = (this.#failures.get(source) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    if (recent.length >= failures) {
      this.#cooldownUntil.set(source, now + cooldownMs);
      this.#failures.delete(source);
    } else {
      this.#failures.set(source, recent);
    }
    if (this.#failures.size > 10_000) this.#sweep(now, windowMs);
  }

  #sweep(now: number, windowMs: number): void {
    for (const [source, times] of this.#failures) {
      if (times.every((t) => now - t >= windowMs)) this.#failures.delete(source);
    }
  }
}
