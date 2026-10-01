/**
 * `@psx-data/client` -- public entry point.
 *
 * Everything a consumer needs is re-exported here. Internal modules
 * (`parse.js`, `selectors.js`, `parsers*.js`) stay reachable by path for
 * advanced use, but are not part of the supported surface.
 *
 * @example
 * ```ts
 * import { parseMarketWatch } from '@psx-data/client';
 *
 * const quotes = parseMarketWatch(html, url);
 * ```
 */

export { createPsxClient, PsxClient } from './client.js';
export type { CachePolicy, StreamTick } from './client.js';
export { TtlCache, isMarketSession, sessionTtlMs } from './cache.js';
export type { CacheOptions, CacheStats } from './cache.js';
export { RateLimiter, poll } from './rate-limit.js';
export type { RateLimiterOptions } from './rate-limit.js';
export type { PsxClientOptions, Sourced } from './client.js';
export { createTransport, Transport } from './transport.js';
export type { TransportOptions } from './transport.js';

export { parseMarketWatch, parseMarketSummaryPage } from './parsers.js';

export {
  parseCompanyProfile,
  parseConstituents,
  parseIndices,
  parseSectorSummaries,
  parseSymbols,
  parseTimeseriesEod,
  parseTimeseriesIntraday,
  parseTopSectors,
  parseTopSymbols,
  parseSymbolPosition,
  unwrap,
} from './parsers-json.js';

export {
  parseInteger,
  parseList,
  parseNumber,
  parsePktTimestamp,
  parsePrice,
  parseSignedPrice,
  parseVolume,
  epochSecondsToIso,
} from './parse.js';

export { BROWSER_UA, HOSTS, MARKET_WATCH_HEADERS, SELECTORS, SELECTOR_VERSION } from './selectors.js';

export {
  PsxAbortError,
  PsxAuthError,
  PsxConfigError,
  PsxError,
  PsxNetworkError,
  PsxNotFoundError,
  PsxParseError,
  PsxRateLimitError,
  PsxSchemaError,
  PsxTimeoutError,
  isPsxError,
} from './errors.js';

export type { Diagnostics, PsxErrorCode } from './errors.js';

export type {
  Bar,
  CompanyProfile,
  IndexConstituent,
  IndexQuote,
  MarketStatus,
  MarketSummary,
  Quote,
  Sector,
  SectorSummary,
  SymbolInfo,
  Timestamp,
} from './types.js';

