/**
 * Public data types for Pakistan Stock Exchange market data.
 *
 * Two decisions shape everything here:
 *
 * 1. **Row-major, not column-major.** Every payload is an array of row objects.
 *    Consumers overwhelmingly want `rows.map(r => <td>{r.current}</td>)`. The
 *    raw size argument for columnar favours columnar, but JSON compresses
 *    repeated keys extremely well, so the delta over a gzipped response is
 *    small -- not worth a synchronisation invariant that every operation must
 *    preserve. Use {@link toColumnar} when column math is actually wanted.
 *
 * 2. **`number | null`, never `0` and never `NaN`.** PSX genuinely emits
 *    "No Data found!" for some rows and omits values for halted securities.
 *    Encoding absence as `0` would render a stock at zero and silently corrupt
 *    any aggregate computed over it. Absence is data.
 */

/** ISO-8601 timestamp. Always UTC. */
export type Timestamp = string;

/**
 * Sector code and name. PSX publishes numeric codes (`0833`) alongside
 * display names (`TRANSPORT`); we carry both so users can filter either way.
 */
export interface Sector {
  /** Numeric sector code as published by PSX, e.g. `"0833"`. */
  code: string;
  /** Display name, e.g. `"TRANSPORT"`. */
  name: string;
}

/** Market open/closed state as reported by the exchange. */
export type MarketStatus = 'OPEN' | 'CLOSED' | 'PRE_OPEN' | 'UNKNOWN';

/**
 * One security's live quote.
 *
 * Every price field is `number | null`. A `null` means PSX published no value
 * for that field -- not that the value is zero. See {@link priceOr}.
 */
export interface Quote {
  /** Ticker symbol, uppercase, e.g. `"HBL"`. */
  symbol: string;
  /** Company/security display name, e.g. `"Habib Bank Limited"`. */
  name: string | null;
  /** Sector code, e.g. `"0833"`. Raw code -- see {@link Quote.sectorName}. */
  sector: string | null;
  /** Sector display name where PSX publishes one. */
  sectorName: string | null;
  /**
   * Indices this security is a constituent of, e.g.
   * `["ALLSHR","KMIALLSHR","KSE100"]`. Empty when PSX publishes nothing.
   */
  listedIn: string[];
  /** Last Day Close Price -- the previous session's close. */
  ldcp: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  /** Current/traded price. */
  current: number | null;
  /** Absolute change vs {@link Quote.ldcp}. */
  change: number | null;
  /** Percentage change vs {@link Quote.ldcp}. PSX publishes this; we do not recompute. */
  changePct: number | null;
  /** Traded volume, in shares. */
  volume: number | null;
  /** Turnover value in PKR, where published. */
  value: number | null;
  /** When this row was published by the exchange. */
  updatedAt: Timestamp;
  /**
   * Parsing warnings for this row -- an unrecognised cell shape, a missing
   * expected attribute. Present rather than thrown so one bad row never costs
   * you the other 588. See Q9.
   */
  warnings: string[];
}

/** A directory entry from the PSX symbol list. Covers equities, debt, and ETFs. */
export interface SymbolInfo {
  symbol: string;
  name: string;
  sectorName: string | null;
  isEtf: boolean;
  isDebt: boolean;
}

/** Exchange-wide intraday totals. */
export interface MarketSummary {
  status: MarketStatus;
  /** Raw status text as PSX publishes it, e.g. `"Closed"`. */
  statusRaw: string;
  /** Total traded volume across the exchange, in shares. */
  volume: number | null;
  /** Total turnover in PKR. */
  value: number | null;
  /** Total number of trades executed. */
  trades: number | null;
  advanced: number | null;
  declined: number | null;
  unchanged: number | null;
  /** Total securities counted in the advance/decline tally. */
  total: number | null;
  /** Timestamp the exchange published this snapshot. */
  updatedAt: Timestamp | null;
}

/** One index level reading. */
export interface IndexQuote {
  /** Index code, e.g. `"KSE100"`. */
  code: string;
  /** Display name where published. */
  name: string | null;
  /** Current index level in index points. */
  value: number | null;
  /** Absolute change in index points. */
  change: number | null;
  /** Percentage change. */
  changePct: number | null;
  updatedAt: Timestamp | null;
}

/** A security's membership within one index. */
export interface IndexConstituent {
  indexCode: string;
  symbol: string;
  name: string | null;
  sector: string | null;
  /** Index weight as a percentage, e.g. `0.41` meaning 0.41%. */
  weightPct: number | null;
  /** Index points contributed to the index level. */
  indexPoints: number | null;
  /** Free float in millions of shares. */
  freeFloatMn: number | null;
  /** Market capitalisation in millions of PKR. */
  marketCapMn: number | null;
  /** Previous session's close. */
  ldcp: number | null;
  /** Current traded price. */
  current: number | null;
  /** Absolute change vs ldcp. */
  change: number | null;
  /** Percentage change vs ldcp. */
  changePct: number | null;
  /** Traded volume in shares. */
  volume: number | null;
  updatedAt: Timestamp | null;
}

/** Per-sector aggregate performance. */
export interface SectorSummary {
  sector: Sector;
  /** Number of constituents advancing. */
  advanced: number | null;
  declined: number | null;
  unchanged: number | null;
  /** Aggregate traded volume in shares. */
  volume: number | null;
  /**
   * PKR turnover.
   *
   * Always `null` on this endpoint: PSX's own "Turnover" column is a share
   * volume, not a PKR amount (see {@link SectorSummary.volume}). Kept because a
   * future endpoint may publish a genuine PKR figure; do not map PSX's
   * "Turnover" header onto it.
   */
  turnover: number | null;
  /** Aggregate market capitalisation in billions of PKR. */
  marketCapBn: number | null;
  updatedAt: Timestamp | null;
}

/** One OHLCV bar. */
export interface Bar {
  /** Bar close time, UTC ISO-8601. */
  time: Timestamp;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

/**
 * A security's fundamentals profile.
 *
 * Every field is nullable: PSX publishes a different subset per security type,
 * and a debt instrument has no PE ratio. Absence is normal, not exceptional.
 */
export interface CompanyProfile {
  symbol: string;
  name: string | null;
  sector: Sector | null;
  /** Free-text company description as published by PSX. */
  description: string | null;
  ldcp: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  current: number | null;
  /**
   * Previous session's closing price.
   *
   * Distinct from {@link CompanyProfile.ldcp}, which is the same concept as
   * published by PSX; this field exists because the company page's
   * previous-close block publishes a literal "Close" label that differs from the
   * live block's "LDCP". Both are kept so neither is silently reinterpreted.
   */
  previousClose: number | null;
  volume: number | null;
  /** Total shares outstanding. */
  totalShares: number | null;
  /** Free-floating shares, as a count (not the free-float percentage). */
  freeFloatShares: number | null;
  updatedAt: Timestamp | null;
  /**
   * Non-fatal parsing notes.
   *
   * Populated when a label appeared more than once with differing values -- the
   * company page concatenates several stat blocks that reuse labels such as
   * `Open`, `LDCP`, and `Free Float`.
   */
  warnings: string[];
}
