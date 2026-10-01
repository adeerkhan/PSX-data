/**
 * Tests for caching, rate limiting, and streaming.
 *
 * Both use an injected clock and injected sleep, so nothing here waits on real
 * time. The rate limiter in particular is the component whose failure mode is
 * invisible: if it under-waits, users get rate limited and eventually IP
 * blocked, and no test of the returned data would notice.
 */

import { describe, expect, it } from 'vitest';

import { TtlCache, isMarketSession, sessionTtlMs } from './cache.js';
import { RateLimiter, poll } from './rate-limit.js';

/** A clock the test advances by hand. */
function fakeClock() {
  let now = 1_000_000;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** A sleep that advances the fake clock instead of waiting. */
function fakeSleep(clock: { advance: (ms: number) => void }) {
  return async (ms: number) => {
    clock.advance(ms);
  };
}

describe('TtlCache', () => {
  it('returns a cached value before expiry', () => {
    const cache = new TtlCache({ defaultTtlMs: 1000 });
    cache.set('k', 42);
    expect(cache.get('k')).toBe(42);
  });

  it('expires an entry once its TTL passes', () => {
    const clock = fakeClock();
    const cache = new TtlCache({ defaultTtlMs: 1000, now: clock.now });
    cache.set('k', 42);
    clock.advance(999);
    expect(cache.get('k')).toBe(42);
    clock.advance(2);
    expect(cache.get('k')).toBeUndefined();
  });

  it('coalesces concurrent misses into one upstream call', async () => {
    // This is the property that stops a React page mounting ten components
    // from sending ten requests to the exchange.
    const cache = new TtlCache({ defaultTtlMs: 10_000 });
    let calls = 0;
    const produce = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return ['value'];
    };

    const results = await Promise.all([
      cache.fetch('k', produce),
      cache.fetch('k', produce),
      cache.fetch('k', produce),
      cache.fetch('k', produce),
    ]);

    expect(calls).toBe(1);
    expect(results).toHaveLength(4);
    expect(cache.stats().coalesced).toBe(3);
  });

  it('does not cache a rejection, so the next caller retries', async () => {
    // Caching a failure would wedge the key until the TTL expired.
    const cache = new TtlCache({ defaultTtlMs: 10_000 });
    let attempt = 0;
    const produce = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('upstream down');
      return 'recovered';
    };

    await expect(cache.fetch('k', produce)).rejects.toThrow('upstream down');
    await expect(cache.fetch('k', produce)).resolves.toBe('recovered');
    expect(attempt).toBe(2);
  });

  it('evicts the oldest entry when over capacity', () => {
    const cache = new TtlCache({ defaultTtlMs: 100_000, maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
    expect(cache.stats().size).toBe(2);
  });

  it('reports hit and miss counts', async () => {
    const cache = new TtlCache({ defaultTtlMs: 10_000 });
    await cache.fetch('k', async () => 'v');
    await cache.fetch('k', async () => 'v');
    expect(cache.stats().hits).toBe(1);
    expect(cache.stats().misses).toBe(1);
  });
});

describe('isMarketSession', () => {
  // PSX trades 09:00-15:00 Asia/Karachi (UTC+5, no DST), Monday to Friday.
  it('is true during trading hours on a weekday', () => {
    // 2026-10-01 is a Thursday. 12:00 UTC is 17:00 PKT -- after the close.
    expect(isMarketSession(new Date('2026-10-01T06:00:00Z'))).toBe(true); // 11:00 PKT
    expect(isMarketSession(new Date('2026-10-01T09:59:00Z'))).toBe(true); // 14:59 PKT
  });

  it('is false before the open and after the close', () => {
    expect(isMarketSession(new Date('2026-10-01T03:00:00Z'))).toBe(false); // 08:00 PKT
    expect(isMarketSession(new Date('2026-10-01T10:00:00Z'))).toBe(false); // 15:00 PKT
  });

  it('is false at the weekend', () => {
    // 2026-10-03 is a Saturday, 2026-10-04 a Sunday.
    expect(isMarketSession(new Date('2026-10-03T06:00:00Z'))).toBe(false);
    expect(isMarketSession(new Date('2026-10-04T06:00:00Z'))).toBe(false);
  });

  it('uses the exchange timezone rather than a fixed offset', () => {
    // A naive UTC check would call 06:00Z "outside hours" and wrongly skip
    // caching during the PKT session. This is the regression that matters.
    expect(isMarketSession(new Date('2026-10-01T06:00:00Z'))).toBe(true);
  });
});

describe('sessionTtlMs', () => {
  it('is short in session and long out of it', () => {
    const inSession = sessionTtlMs(new Date('2026-10-01T06:00:00Z'));
    const outOfSession = sessionTtlMs(new Date('2026-10-01T12:00:00Z'));
    expect(inSession).toBe(15_000);
    expect(outOfSession).toBeGreaterThan(inSession);
  });
});

describe('RateLimiter', () => {
  it('lets the first request through immediately', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ minIntervalMs: 15_000, now: clock.now, sleep: fakeSleep(clock) });
    const started = clock.now();
    await limiter.run('HBL', async () => 'ok');
    expect(clock.now()).toBe(started);
  });

  it('waits the full interval before a second request to the same key', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ minIntervalMs: 15_000, now: clock.now, sleep: fakeSleep(clock) });
    await limiter.run('HBL', async () => 1);
    const started = clock.now();
    await limiter.run('HBL', async () => 2);
    expect(clock.now() - started).toBe(15_000);
  });

  it('does not delay requests for different keys', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ minIntervalMs: 15_000, now: clock.now, sleep: fakeSleep(clock) });
    await limiter.run('HBL', async () => 1);
    const started = clock.now();
    await limiter.run('OGDC', async () => 2);
    expect(clock.now()).toBe(started);
  });

  it('serialises concurrent calls so two do not fire at once', async () => {
    // Without chaining, both callers compute "15s from now" and fire
    // simultaneously -- exactly the burst this exists to prevent.
    const clock = fakeClock();
    const limiter = new RateLimiter({ minIntervalMs: 15_000, now: clock.now, sleep: fakeSleep(clock) });

    const startTimes: number[] = [];
    await Promise.all([
      limiter.run('HBL', async () => {
        startTimes.push(clock.now());
        return 1;
      }),
      limiter.run('HBL', async () => {
        startTimes.push(clock.now());
        return 2;
      }),
    ]);

    expect(startTimes).toHaveLength(2);
    expect(startTimes[1]! - startTimes[0]!).toBe(15_000);
  });

  it('keeps working after a failure, rather than wedging the key', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ minIntervalMs: 1000, now: clock.now, sleep: fakeSleep(clock) });

    await expect(
      limiter.run('HBL', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    await expect(limiter.run('HBL', async () => 'recovered')).resolves.toBe('recovered');
  });

  it('counts waits for observability', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ minIntervalMs: 15_000, now: clock.now, sleep: fakeSleep(clock) });
    await limiter.run('HBL', async () => 1);
    await limiter.run('HBL', async () => 2);
    expect(limiter.stats().waits).toBe(1);
    expect(limiter.stats().totalWaitMs).toBe(15_000);
  });
});

describe('poll', () => {
  it('yields items and stops on abort', async () => {
    const controller = new AbortController();
    let calls = 0;

    const source = poll(
      async () => {
        calls += 1;
        return [{ n: calls }];
      },
      1,
      controller.signal,
    );

    const seen: Array<{ n: number }> = [];
    for await (const item of source) {
      seen.push(item);
      if (seen.length === 3) controller.abort();
    }

    expect(seen).toHaveLength(3);
    expect(seen.map((s) => s.n)).toEqual([1, 2, 3]);
  });

  it('returns immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const source = poll(async () => [1], 1, controller.signal);
    const seen: number[] = [];
    for await (const item of source) seen.push(item);
    expect(seen).toEqual([]);
  });
});