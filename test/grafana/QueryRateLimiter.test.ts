import { describe, expect, it } from 'vitest';
import { QueryRateLimiter } from '../../src/grafana/QueryRateLimiter';

/**
 * A clock the tests advance by hand, so nothing here sleeps and the refill
 * behaviour is asserted at exact instants rather than approximately.
 */
function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    }
  };
}

function acquireOrThrow(limiter: QueryRateLimiter, instanceId: string): { release(): void } {
  const decision = limiter.tryAcquire(instanceId);
  if (!decision.allowed) {
    throw new Error(`expected the limiter to admit ${instanceId}, got ${decision.rejection.reason}`);
  }
  return decision.lease;
}

describe('QueryRateLimiter token bucket', () => {
  it('admits a full burst and then sheds', () => {
    const clock = fakeClock();
    const limiter = new QueryRateLimiter({ maxRequestsPerWindow: 3, windowMs: 60_000, maxConcurrent: 10, now: clock.now });

    for (let i = 0; i < 3; i++) {
      acquireOrThrow(limiter, 'inst-a').release();
    }
    const fourth = limiter.tryAcquire('inst-a');

    expect(fourth.allowed).toBe(false);
    expect(fourth.allowed === false && fourth.rejection.reason).toBe('rate');
  });

  it('refills gradually rather than only at window boundaries', () => {
    const clock = fakeClock();
    const limiter = new QueryRateLimiter({ maxRequestsPerWindow: 60, windowMs: 60_000, maxConcurrent: 10, now: clock.now });

    for (let i = 0; i < 60; i++) {
      acquireOrThrow(limiter, 'inst-a').release();
    }
    expect(limiter.tryAcquire('inst-a').allowed).toBe(false);

    // One token per second at this rate.
    clock.advance(1_000);
    expect(limiter.tryAcquire('inst-a').allowed).toBe(true);
    expect(limiter.tryAcquire('inst-a').allowed).toBe(false);
  });

  it('never accumulates more than a full bucket while idle', () => {
    const clock = fakeClock();
    const limiter = new QueryRateLimiter({ maxRequestsPerWindow: 2, windowMs: 1_000, maxConcurrent: 10, now: clock.now });

    clock.advance(3_600_000);

    acquireOrThrow(limiter, 'inst-a').release();
    acquireOrThrow(limiter, 'inst-a').release();
    expect(limiter.tryAcquire('inst-a').allowed).toBe(false);
  });

  it('meters each instance separately, so a busy instance cannot starve a quiet one', () => {
    const clock = fakeClock();
    const limiter = new QueryRateLimiter({ maxRequestsPerWindow: 2, windowMs: 60_000, maxConcurrent: 10, now: clock.now });

    acquireOrThrow(limiter, 'inst-a').release();
    acquireOrThrow(limiter, 'inst-a').release();
    expect(limiter.tryAcquire('inst-a').allowed).toBe(false);

    expect(limiter.tryAcquire('inst-b').allowed).toBe(true);
  });

  it('reports a retry delay that actually becomes true', () => {
    const clock = fakeClock();
    const limiter = new QueryRateLimiter({ maxRequestsPerWindow: 4, windowMs: 60_000, maxConcurrent: 10, now: clock.now });

    for (let i = 0; i < 4; i++) {
      acquireOrThrow(limiter, 'inst-a').release();
    }
    const rejected = limiter.tryAcquire('inst-a');
    if (rejected.allowed) {
      throw new Error('expected the limiter to shed the fifth request');
    }

    expect(rejected.rejection.retryAfterMs).toBeGreaterThan(0);
    clock.advance(rejected.rejection.retryAfterMs);
    expect(limiter.tryAcquire('inst-a').allowed).toBe(true);
  });
});

describe('QueryRateLimiter concurrency', () => {
  it('sheds once too many queries are in flight at the same time', () => {
    const clock = fakeClock();
    const limiter = new QueryRateLimiter({ maxRequestsPerWindow: 100, windowMs: 60_000, maxConcurrent: 2, now: clock.now });

    const first = acquireOrThrow(limiter, 'inst-a');
    const second = acquireOrThrow(limiter, 'inst-a');
    const third = limiter.tryAcquire('inst-a');

    expect(third.allowed).toBe(false);
    expect(third.allowed === false && third.rejection.reason).toBe('concurrency');

    first.release();
    second.release();
  });

  it('frees the slot when a query finishes, and a double release cannot inflate the budget', () => {
    const clock = fakeClock();
    const limiter = new QueryRateLimiter({ maxRequestsPerWindow: 100, windowMs: 60_000, maxConcurrent: 1, now: clock.now });

    const lease = acquireOrThrow(limiter, 'inst-a');
    expect(limiter.tryAcquire('inst-a').allowed).toBe(false);

    lease.release();
    lease.release();

    const next = acquireOrThrow(limiter, 'inst-a');
    expect(limiter.tryAcquire('inst-a').allowed).toBe(false);
    next.release();
  });

  it('does not spend a rate token on a request it sheds for concurrency', () => {
    const clock = fakeClock();
    const limiter = new QueryRateLimiter({ maxRequestsPerWindow: 3, windowMs: 60_000, maxConcurrent: 1, now: clock.now });

    const held = acquireOrThrow(limiter, 'inst-a');
    for (let i = 0; i < 5; i++) {
      expect(limiter.tryAcquire('inst-a').allowed).toBe(false);
    }
    held.release();

    // Two of the three tokens should remain: only the admitted request spent
    // one. Released each time so this measures the bucket, not concurrency.
    acquireOrThrow(limiter, 'inst-a').release();
    acquireOrThrow(limiter, 'inst-a').release();
    expect(limiter.tryAcquire('inst-a').allowed).toBe(false);
  });

  it('meters concurrency per instance as well', () => {
    const clock = fakeClock();
    const limiter = new QueryRateLimiter({ maxRequestsPerWindow: 100, windowMs: 60_000, maxConcurrent: 1, now: clock.now });

    const held = acquireOrThrow(limiter, 'inst-a');
    expect(limiter.tryAcquire('inst-b').allowed).toBe(true);
    held.release();
  });
});
