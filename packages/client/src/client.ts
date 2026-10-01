/**
 * High-level PSX client.
 *
 * One object, namespaced methods, plain typed arrays back. Mirrors the shape of
 * `pypsx_toolkit`'s surface without its bugs: numbers instead of formatted
 * strings, no trailing spaces in field names, and `number | null` for absent
 * values rather than a misleading `0`.
 *
 * @example
 * ```ts
 * import { createPsxClient } from '@psx-data/client';
 *
 * const psx = createPsxClient();
 * const quotes = await psx.marketWatch();
 * console.log(quotes[0].symbol, quotes[0].current);
 * ```
 */

import { createTransport, type Transport, type TransportOptions } from './transport.js';
import { TtlCache, sessionTtlMs, type CacheStats } from './cache.js';
import { RateLimiter, poll } from './rate-limit.js';
import { parseMarketWatch, parseMarketSummaryPage } from './parsers.js';
import {
  parseCompanyProfile,
  parseConstituents,
  parseIndices,
  parseSectorSummaries,
  parseSymbols,
  parseTimeseriesEod,
  parseTimeseriesIntraday,
} from './parsers-json.js';
import { PsxError, PsxAbortError, type Diagnostics } from './errors.js';
import type {
  Bar,
  CompanyProfile,
  IndexConstituent,
  IndexQuote,
  MarketSummary,
  Quote,
  SectorSummary,
  SymbolInfo,
} from './types.js';

/** Client options. */
export interface PsxClientOptions extends TransportOptions {}

/**
 * A parsed result plus any degradation notice.
 *
 * Present so a caller can tell "the gated source worked" from "we fell back and
 * you are looking at slightly older data" rather than having to infer it.
 */
export interface Sourced<T> {
  data: T;
  /** Which source produced this. */
  source: 'market-watch' | 'market-summary' | 'json';
  /** Set when a preferred source failed and a fallback was used. */
  notice?: string;
}

/** Create a PSX client. */
export function createPsxClient(options: PsxClientOptions = {}): PsxClient {
  return new PsxClient(options);
}

/** Options for {@link PsxClient.cache}. */
export interface CachePolicy {
  /** Skip the cache for this call. */
  bypassCache?: boolean;
  /** Override the entry lifetime for this call. */
  ttlMs?: number;
}

/** A single tick from {@link PsxClient.stream}. */
export interface StreamTick {
  symbol: string;
  price: number | null;
  change: number | null;
  changePct: number | null;
  volume: number | null;
  /** When this tick was observed. */
  at: string;
}

/** Client for Pakistan Stock Exchange market data. */
export class PsxClient {
  readonly #transport: Transport;
  readonly #cache: TtlCache;
  readonly #limiter: RateLimiter;

  constructor(options: PsxClientOptions = {}) {
    this.#transport = createTransport(options);
    this.#cache = new TtlCache();
    this.#limiter = new RateLimiter({
      minIntervalMs: (options as { minIntervalMs?: number }).minIntervalMs ?? 15_000,
    });
  }

  /** Drop every cached response. */
  clearCache(): void {
    this.#cache.clear();
  }

  /** Cache and rate-limiter counters. */
  stats(): { cache: CacheStats; limiter: { waits: number; totalWaitMs: number } } {
    return { cache: this.#cache.stats(), limiter: this.#limiter.stats() };
  }

  /**
   * All listed securities with live quotes.
   *
   * Prefers the richer gated source (495 rows, includes `changePct`, sector
   * codes, and index membership) and falls back to the ungated page (589 rows,
   * no percentage column) if the gate rejects us.
   *
   * @example
   * ```ts
   * const { data, source } = await psx.marketWatch();
   * const gainers = data.filter(q => (q.change ?? 0) > 0);
   * ```
   */
  async marketWatch(policy: CachePolicy = {}): Promise<Sourced<Quote[]>> {
    if (policy.bypassCache === true) return this.#fetchMarketWatch();

    return this.#cache.fetch('marketWatch', () => this.#fetchMarketWatch(), policy.ttlMs);
  }

  /** Uncached market-watch fetch. Falls back to the ungated page on failure. */
  async #fetchMarketWatch(): Promise<Sourced<Quote[]>> {
    if (this.#transport.ungatedOnly) {
      const fallback = await this.#summaryPage();
      return { data: fallback.quotes, source: 'market-summary', notice: 'transport is ungatedOnly' };
    }

    try {
      const html = await this.#transport.fetchGated('/market-watch');
      return { data: parseMarketWatch(html, 'https://dps.psx.com.pk/market-watch'), source: 'market-watch' };
    } catch (error) {
      // Degrade rather than throw: one dead endpoint should not cost the caller
      // 589 symbols.
      const fallback = await this.#summaryPage();
      return {
        data: fallback.quotes,
        source: 'market-summary',
        notice: `market-watch unavailable (${describe(error)}); using ungated market-summary`,
      };
    }
  }

  /**
   * Exchange-wide totals plus the full symbol table.
   *
   * Always uses the ungated page -- these scalars exist on no other endpoint.
   *
   * @example
   * ```ts
   * const { data: { summary } } = await psx.marketSummary();
   * console.log(summary.status, summary.total); // "CLOSED" 569
   * ```
   */
  async marketSummary(policy: CachePolicy = {}): Promise<MarketSummary> {
    if (policy.bypassCache === true) {
      const { summary } = await this.#summaryPage();
      return summary;
    }

    return this.#cache.fetch('marketSummary', async () => {
      const { summary } = await this.#summaryPage();
      return summary;
    }, policy.ttlMs);
  }

  /**
   * End-of-day OHLCV history, oldest bar first.
   *
   * ~1,239 daily bars over about five years. PSX publishes open, close, and
   * volume only -- high and low are `null`, never guessed.
   *
   * @example
   * ```ts
   * const { data } = await psx.history('HBL');
   * const last = data.at(-1);
   * console.log(last?.time, last?.close);
   * ```
   */
  async history(symbol: string): Promise<Bar[]> {
    const body = await this.#json(`/timeseries/eod/${encodeURIComponent(symbol.toUpperCase())}`);
    return parseTimeseriesEod(body, `https://dps.psx.com.pk/timeseries/eod/${symbol}`);
  }

  /**
   * Intraday ticks for the last two trading sessions, oldest first.
   *
   * Each bar carries price and volume only.
   */
  async intraday(symbol: string): Promise<Bar[]> {
    const body = await this.#json(`/timeseries/int/${encodeURIComponent(symbol.toUpperCase())}`);
    return parseTimeseriesIntraday(body, `https://dps.psx.com.pk/timeseries/int/${symbol}`);
  }

  /**
   * The full security directory: ~1,028 entries spanning equities, debt, and
   * ETFs.
   */
  async symbols(policy: CachePolicy = {}): Promise<SymbolInfo[]> {
    if (policy.bypassCache === true) {
      return parseSymbols(await this.#json('/symbols'), 'https://dps.psx.com.pk/symbols');
    }
    // The directory changes rarely; hold it far longer than live quotes.
    return this.#cache.fetch('symbols', async () =>
      parseSymbols(await this.#json('/symbols'), 'https://dps.psx.com.pk/symbols'),
    policy.ttlMs ?? 3_600_000);
  }

  /**
   * Constituents of one index, e.g. constituents('KSE100').
   *
   * The list changes only at index review, so it is cached for an hour.
   */
  async constituents(indexCode: string, policy: CachePolicy = {}): Promise<IndexConstituent[]> {
    const code = indexCode.toUpperCase();
    const load = () =>
      this.#limiter.run(`index:${code}`, async () =>
        parseConstituents(
          await this.#transport.fetchGated(`/indices/${encodeURIComponent(code)}`),
          `https://dps.psx.com.pk/indices/${code}`,
          code,
        ),
      );

    if (policy.bypassCache === true) return load();
    return this.#cache.fetch(`index:${code}`, load, policy.ttlMs ?? 3_600_000);
  }

  /**
   * Current index levels.
   *
   * @example
   * ```ts
   * const indices = await psx.indices();
   * const kse100 = indices.find(i => i.code === 'KSE100');
   * ```
   */
  async indices(policy: CachePolicy = {}): Promise<IndexQuote[]> {
    const load = async () =>
      parseIndices(await this.#transport.fetchGated('/indices'), 'https://dps.psx.com.pk/indices');

    if (policy.bypassCache === true) return load();
    return this.#cache.fetch('indices', load, policy.ttlMs);
  }

  /**
   * Per-sector aggregates: advance/decline counts, volume, and market cap in
   * billions PKR.
   */
  async sectorSummary(): Promise<SectorSummary[]> {
    const html = await this.#transport.fetchGated('/sector-summary/sectorwise');
    return parseSectorSummaries(html, 'https://dps.psx.com.pk/sector-summary/sectorwise');
  }

  /**
   * Fundamentals for one security.
   *
   * PSX concatenates several stat blocks that reuse labels (`Free Float`
   * appears as both a share count and a percentage); the parser reads the live
   * quote block and reports ambiguity in `warnings`.
   */
  async company(symbol: string): Promise<CompanyProfile> {
    const upper = symbol.toUpperCase();
    const html = await this.#transport.fetchGated(`/company/${encodeURIComponent(upper)}`);
    return parseCompanyProfile(html, `https://dps.psx.com.pk/company/${upper}`, upper);
  }

  /**
   * Poll live quotes for a set of symbols.
   *
   * Async iterable, so no event-emitter dependency:
   *
   * `	s
   * for await (const tick of psx.stream(['HBL', 'OGDC'])) {
   *   console.log(tick.symbol, tick.price);
   * }
   * `
   *
   * Bypasses the cache deliberately -- a stream that served cached values
   * would not be a stream -- and enforces the 15-second floor per symbol.
   *
   * @param symbols - Symbols to poll.
   * @param options.intervalMs - Poll interval. Default 15_000, PSX's floor.
   * @param options.signal - Abort to stop the stream.
   */
  async *stream(
    symbols: string[],
    options: { intervalMs?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<StreamTick, void, undefined> {
    const wanted = new Set(symbols.map((s) => s.toUpperCase()));

    const fetchOnce = async (): Promise<StreamTick[]> => {
      const { data } = await this.#fetchMarketWatch();
      const at = new Date().toISOString();
      return data
        .filter((quote) => wanted.has(quote.symbol))
        .map((quote) => ({
          symbol: quote.symbol,
          price: quote.current,
          change: quote.change,
          changePct: quote.changePct,
          volume: quote.volume,
          at,
        }));
    };

    yield* poll(fetchOnce, options.intervalMs ?? 15_000, options.signal);
  }

  /** Operational status, for troubleshooting a user's connection. */
  async diagnostics(): Promise<Diagnostics> {
    return {
      hasKey: this.#transport.hasKey,
      keyAgeMs: this.#transport.keyAgeMs,
      keyAcquiredAt: this.#transport.keyAcquiredAt?.toISOString() ?? null,
      keyRefreshCount: this.#transport.keyRefreshCount,
      fallbackReachable: null,
      cache: {
        hits: this.#cache.stats().hits,
        misses: this.#cache.stats().misses,
        size: this.#cache.stats().size,
      },
      inFlight: 0,
    };
  }

  /** Fetch and parse a JSON endpoint. */
  async #json(path: string): Promise<unknown> {
    const text = await this.#transport.fetchGated(path);
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new PsxError('PARSE', `expected JSON from ${path}`, { url: path, cause: error });
    }
  }

  /** Fetch and parse the ungated market-summary page. */
  async #summaryPage(): Promise<{ summary: MarketSummary; quotes: Quote[] }> {
    const html = await this.#transport.fetchUngated();
    return parseMarketSummaryPage(html, 'https://www.psx.com.pk/market-summary/');
  }
}

/** Short, safe description of an error for user-facing notices. */
function describe(error: unknown): string {
  if (error instanceof PsxError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
