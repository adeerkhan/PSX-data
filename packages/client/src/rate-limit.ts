/**
 * Per-key rate limiting.
 *
 * The reference implementation documents one hard constraint on this exchange:
 * **a minimum 15-second polling interval per symbol**. PSX also states it
 * reserves the right to block an IP address.
 *
 * That makes this the difference between a library that behaves and one that
 * gets its users banned, so it is enforced here rather than left as a
 * docstring. A documented limit nobody enforces is a suggestion.
 *
 * Concurrency is handled by chaining: every call for a key queues behind the
 * previous one for that key. Different keys stay fully parallel, so fetching
 * ten symbols concurrently still works -- they just cannot exceed one request
 * per symbol per interval. Chaining also removes the race where two callers
 * both compute "15s from now" and fire simultaneously.
 */

/** Options for {@link RateLimiter}. */
export interface RateLimiterOptions {
  /**
   * Minimum interval between two requests to the same key, in milliseconds.
   * Default 15_000, matching PSX's documented polling floor.
   */
  minIntervalMs?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
  /** Injectable sleep, for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export class RateLimiter {
  readonly #minIntervalMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  /** Last time a request to each key was *started*. */
  readonly #lastRequestAt = new Map<string, number>();
  /** Tail of each key's serial chain. */
  readonly #chain = new Map<string, Promise<unknown>>();
  #waits = 0;
  #waitMs = 0;

  constructor(options: RateLimiterOptions = {}) {
    this.#minIntervalMs = options.minIntervalMs ?? 15_000;
    this.#now = options.now ?? (() => Date.now());
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Run `task` once the rate limit for `key` allows.
   *
   * @param key - What the limit applies to, typically a symbol or endpoint.
   */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    // Chain off the previous call for this key so starts are strictly serial.
    const previous = this.#chain.get(key) ?? Promise.resolve();

    const next = previous.then(async () => {
      const last = this.#lastRequestAt.get(key);
      if (last != null) {
        const waitMs = this.#minIntervalMs - (this.#now() - last);
        if (waitMs > 0) {
          this.#waits += 1;
          this.#waitMs += waitMs;
          await this.#sleep(waitMs);
        }
      }
      this.#lastRequestAt.set(key, this.#now());
      return task();
    });

    // Keep the chain alive after a rejection so one failure does not wedge the
    // key forever.
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.#chain.set(key, tail);

    return next;
  }

  /** Requests that had to wait, and total time spent waiting. */
  stats(): { waits: number; totalWaitMs: number } {
    return { waits: this.#waits, totalWaitMs: this.#waitMs };
  }
}

/**
 * Async iterable that polls `fetchOne` on an interval.
 *
 * The native idiom replaces the reference implementation's callback-and-
 * `stop()` pattern, with no event-emitter dependency:
 *
 * ```ts
 * for await (const tick of psx.stream(['HBL', 'OGDC'], { intervalMs: 15_000 })) {
 *   console.log(tick.symbol, tick.price);
 * }
 * ```
 *
 * The interval is measured from the *start* of the previous cycle, so a slow
 * fetch pushes the next one out rather than stacking requests behind it.
 */
export async function* poll<T>(
  fetchOne: () => Promise<T[]>,
  intervalMs: number,
  signal?: AbortSignal,
): AsyncGenerator<T, void, undefined> {
  for (;;) {
    if (signal?.aborted === true) return;

    const started = Date.now();
    const items = await fetchOne();
    for (const item of items) yield item;

    // TypeScript narrows `signal?.aborted` to false after the check above, so
    // re-read it rather than trusting the stale narrowing.
    if (signal != null && signal.aborted) return;

    const remaining = intervalMs - (Date.now() - started);
    if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
  }
}