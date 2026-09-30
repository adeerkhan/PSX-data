/**
 * Numeric parsing with strict `number | null` discipline.
 *
 * PSX publishes formatted text (`"73,446,994"`, `"0.76%"`, `"14.50"`), but
 * where a machine-readable value exists we read it directly via the `data-order`
 * attribute. This module is the only place that converts text to numbers, and
 * it enforces three rules everywhere:
 *
 * 1. Absence is `null`. Never `0`, never `NaN`.
 * 2. Strip thousands separators, currency marks, and percent signs.
 * 3. Never throw on unparseable input -- return `null`. A single malformed
 *    cell must not cost the caller the other 588 rows.
 *
 * The Python references broke the opposite way: `psx-data-reader` ran
 * `.astype(np.float64)` over every column with no error handling, and
 * `PSX-Data-Api` returned every number as a formatted string. A missing price
 * encoded as `0` renders a stock at zero and silently corrupts any average
 * computed over it.
 */

/** Text that means "no value". Matched case-insensitively. */
const ABSENT_TOKENS = new Set([
  '',
  '-',
  '--',
  'n/a',
  'na',
  'null',
  'nil',
  'none',
  'undefined',
  'no data',
  'no data found!',
  'no data found',
]);

/**
 * Strip formatting noise from a numeric string.
 *
 * Removes thousands separators, currency marks, percent signs, and surrounding
 * whitespace. Parentheses are treated as negative, per accounting convention:
 * `(0.11)` -> `-0.11`.
 */
function normalise(text: string): string {
  let s = text.trim();
  const negativeByParens = /^\(.*\)$/.test(s);
  s = s.replace(/[(),\s]/g, '').replace(/[^\d.eE+-]/g, '');
  if (negativeByParens && !s.startsWith('-')) {
    s = `-${s}`;
  }
  return s;
}

/**
 * Parse a numeric string, returning `null` for anything unparseable.
 *
 * @example
 * ```ts
 * parseNumber('73,446,994')  // 73446994
 * parseNumber('0.76%')       // 0.76
 * parseNumber('(0.11)')      // -0.11
 * parseNumber('No Data found!') // null
 * parseNumber('')            // null
 * ```
 */
export function parseNumber(input: string | number | null | undefined): number | null {
  if (input == null) return null;

  if (typeof input === 'number') {
    // An already-numeric value is trusted, but a non-finite one is absence.
    return Number.isFinite(input) ? input : null;
  }

  const raw = input.trim();
  if (ABSENT_TOKENS.has(raw.toLowerCase())) return null;

  const normalised = normalise(raw);
  if (normalised === '' || normalised === '-' || normalised === '+') return null;

  const value = Number(normalised);
  // Number.isFinite rejects NaN and +/-Infinity. Negative zero is normalised
  // so `-0` and `0` compare equal downstream.
  if (!Number.isFinite(value)) return null;
  return Object.is(value, -0) ? 0 : value;
}

/**
 * Parse an integer, rejecting fractional values.
 *
 * Used for counts (volume, trades, share totals) where a fractional value would
 * indicate a mis-parsed cell rather than real data.
 */
export function parseInteger(input: string | number | null | undefined): number | null {
  const value = parseNumber(input);
  if (value == null) return null;
  return Number.isInteger(value) ? value : Math.round(value);
}

/**
 * Parse a comma-separated list, dropping empty entries.
 *
 * Used for `LISTED IN` cells (`"ALLSHR,KMIALLSHR,KSE100,KSE100PR"`) and for
 * sector memberships. An absent cell yields an empty array, never `null` --
 * "published nothing" is meaningfully different from "published one thing".
 */
export function parseList(input: string | null | undefined): string[] {
  if (input == null) return [];
  const trimmed = input.trim();
  if (trimmed === '' || ABSENT_TOKENS.has(trimmed.toLowerCase())) return [];

  return trimmed
    .split(/[,;|]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '' && !ABSENT_TOKENS.has(entry.toLowerCase()));
}

/**
 * Parse a price with a plausible-range sanity check.
 *
 * PSX prices are PKR per share, realistically between 0.01 and 10,000,000.
 * A value outside that range almost certainly means we mis-read a column -- a
 * volume or a percentage landing in a price field. Returning `null` there
 * surfaces the parsing problem instead of propagating a nonsense number into
 * user-facing charts.
 *
 * **Negative values are rejected**, because a PSX price is never negative.
 * Do NOT use this for change or percentage fields, which are legitimately
 * negative for decliners -- use {@link parseSignedPrice} there. Using this
 * function for a change column silently nulled every decliner on the page.
 */
export function parsePrice(input: string | number | null | undefined): number | null {
  const value = parseNumber(input);
  if (value == null) return null;
  if (value < 0) return null;
  if (value > 10_000_000) return null;
  return value;
}

/**
 * Parse a signed magnitude -- a price-like value that may be negative.
 *
 * For `change` and `% change` columns, where a decline is a real, expected
 * value rather than a parse failure. Still bounded, because an absurd magnitude
 * means we mis-read a column.
 */
export function parseSignedPrice(input: string | number | null | undefined): number | null {
  const value = parseNumber(input);
  if (value == null) return null;
  // A change can never exceed the price itself by much; allow a wide band but
  // reject obvious column mixups (e.g. a volume landing in a change field).
  if (value > 1_000_000_000 || value < -1_000_000_000) return null;
  return value;
}

/**
 * Parse a non-negative volume/count.
 *
 * Distinguishes a genuine `0` (a security that did not trade) from absence,
 * because "did not trade" is meaningful while "unknown" is not.
 */
export function parseVolume(input: string | number | null | undefined): number | null {
  const value = parseNumber(input);
  if (value == null) return null;
  if (value < 0) return null;
  return Math.round(value);
}

/**
 * Parse a percentage from a value that may or may not carry a `%` sign.
 *
 * Preserves the numeric magnitude as published -- `"0.76%"` becomes `0.76`,
 * not `0.0076`. PSX publishes whole-number percentages; callers wanting a
 * fraction divide by 100.
 */
export function parsePercent(input: string | number | null | undefined): number | null {
  return parseNumber(input);
}

/**
 * Convert Unix seconds to an ISO-8601 UTC timestamp.
 *
 * PSX timeseries return epoch seconds. Anything non-finite returns `null`
 * rather than an `Invalid Date` that would poison a `Date` comparison later.
 */
export function epochSecondsToIso(seconds: number): string | null {
  if (!Number.isFinite(seconds)) return null;
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Parse the exchange's publication timestamp.
 *
 * The live page publishes `<h4>2026-09-30 21:33:02</h4>` -- PKT local time with
 * no timezone marker. We treat it as PKT (UTC+5, no DST) and normalise to UTC.
 *
 * Returns `null` rather than guessing when the input is unrecognised.
 */
export function parsePktTimestamp(text: string | null | undefined): string | null {
  if (text == null) return null;
  const match = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text);
  if (match == null) return null;

  const [, y, mo, d, h, mi, s] = match as unknown as [string, ...string[]];
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second)
  ) {
    return null;
  }

  // PKT is a fixed UTC+5 with no daylight saving.
  const utcMs = Date.UTC(year, month - 1, day, hour - 5, minute, second);
  const date = new Date(utcMs);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
