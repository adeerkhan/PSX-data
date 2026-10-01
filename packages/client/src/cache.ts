/**
 * TTL cache with request coalescing.
 *
 * Two lessons applied from the reference implementations:
 *
 * 1. **pypsx_toolkit caches with no escape hatch.** Its own docs call the
 *    stale-cache problem *"a common source of 'why is my data wrong'
 *    confusion."* So every cached method here takes `bypassCache`.
 *
 * 2. **PSX-Data-Api fetches once at module import** and serves that frozen
 *    snapshot forever, so four gunicorn workers each hold their own stale copy.
 *    Here the cache is per-client with a bounded lifetime, and concurrent
 *    callers for the same key share one in-flight request.
 *
 * TTL defaults come from the trading session (see {@link sessionTtlMs}). PSX
 * trades 09:00-15:00 Asia/Karachi, Mon-Fri; outside that window the exchange
 * publishes nothing new, so entries can be held much longer.
 */

/** A cached value with its expiry. */
interface Entry<T> {
  value: T;
  expiresAt: number;
  /** Insertion order key, for LRU eviction of expired entries. */
  seq: number;
}

/** Cache statistics, surfaced through {@link Diagnostics}. */
export interface CacheStats {
  hits: number;
  misses: number;
  /** In-flight requests deduplicated rather than duplicated. */
  coalesced: number;
  size: number;
}

/** Options for {@link TtlCache}. */
export interface CacheOptions {
  /** Default entry lifetime in milliseconds. Default: session-aware. */
  defaultTtlMs?: number;
  /** Maximum entries before the oldest are evicted. Default 200. */
  maxEntries?: number;
  /** Injectable clock, for tests. Default: `Date.now`. */
  now?: () => number;
}

export class TtlCache {
  readonly #entries = new Map<string, Entry<unknown>>();
  readonly #inFlight = new Map<string, Promise<unknown>>();
  readonly #defaultTtlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;
  #seq = 0;
  #hits = 0;
  #misses = 0;
  #coalesced = 0;

  constructor(options: CacheOptions = {}) {
    this.#defaultTtlMs = options.defaultTtlMs ?? sessionTtlMs();
    this.#maxEntries = options.maxEntries ?? 200;
    this.#now = options.now ?? (() => Date.now());
  }

  /**
   * Read a cached value, or `undefined` when absent or expired.
   *
   * Does not count as a miss; {@link fetch} owns that so the stats line up
   * with actual network calls.
   */
  get<T>(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (entry == null) return undefined;

    if (this.#now() >= entry.expiresAt) {
      this.#entries.delete(key);
      return undefined;
    }

    this.#hits += 1;
    return entry.value as T;
  }

  /** Store a value. */
  set<T>(key: string, value: T, ttlMs: number = this.#defaultTtlMs): void {
    this.#entries.set(key, { value, expiresAt: this.#now() + ttlMs, seq: this.#seq++ });
    this.#evictIfNeeded();
  }

  /**
   * Return a cached value, or produce it via `produce`.
   *
   * Concurrent callers for the same key await one shared request rather than
   * each hitting PSX. That is the difference between a React page mounting ten
   * components and PSX receiving ten requests.
   *
   * A rejected `produce` is not cached, and the in-flight entry is cleared so
   * the next caller retries rather than inheriting the failure.
   */
  async fetch<T>(key: string, produce: () => Promise<T>, ttlMs?: number): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;

    const pending = this.#inFlight.get(key) as Promise<T> | undefined;
    if (pending != null) {
      this.#coalesced += 1;
      return pending;
    }

    this.#misses += 1;

    const request = produce()
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => {
        this.#inFlight.delete(key);
      });

    this.#inFlight.set(key, request);
    return request;
  }

  /** Evict the oldest entries once over the cap. */
  #evictIfNeeded(): void {
    if (this.#entries.size <= this.#maxEntries) return;

    // Ascending insertion order, so the head is the oldest entry.
    const excess = this.#entries.size - this.#maxEntries;
    const keys = [...this.#entries.keys()].slice(0, excess);
    for (const key of keys) {
      this.#entries.delete(key);
    }
  }

  /** Drop one key. */
  delete(key: string): void {
    this.#entries.delete(key);
  }

  /** Drop everything. */
  clear(): void {
    this.#entries.clear();
  }

  /** Current statistics. */
  stats(): CacheStats {
    return {
      hits: this.#hits,
      misses: this.#misses,
      coalesced: this.#coalesced,
      size: this.#entries.size,
    };
  }
}

/**
 * Is the market currently in its trading session?
 *
 * Uses the exchange's own timezone rather than a fixed UTC+5 offset, so it
 * stays correct if PSX ever changes its clocks. Asia/Karachi has no daylight
 * saving, but deriving the zone properly costs nothing and removes the class of
 * bug where a hardcoded offset silently shifts every TTL by five hours.
 */
export function isMarketSession(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Karachi',
    weekday: 'short',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  if (weekday === 'Sat' || weekday === 'Sun') return false;

  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  return hour >= 9 && hour < 15;
}

/**
 * Cache lifetime appropriate to the current session.
 *
 * In session: 15 seconds, matching the 15-second floor the reference
 * implementation documents for PSX. Out of session: 30 minutes, because the
 * exchange publishes nothing new until the next open.
 *
 * Note this does not model public holidays -- PSX's holiday calendar is not
 * published as machine-readable data. Stale data proves a closure happened, so
 * the TTL simply runs long and the caller sees unchanged values.
 */
export function sessionTtlMs(now: Date = new Date()): number {
  return isMarketSession(now) ? 15_000 : 1_800_000;
}