/**
 * JSON parsers for the 7 endpoints that genuinely return JSON.
 *
 * These are the straightforward ones -- but two of them return **positional
 * arrays**, not objects, which is a real trap:
 *
 * - `/timeseries/eod/{SYM}` -> `[unixSeconds, close, volume, open]`
 * - `/timeseries/int/{SYM}` -> `[unixSeconds, price, volume]`
 *
 * Note the order: `close` comes *before* `open`, and there is no high/low in
 * either. Getting the order wrong yields plausible, entirely wrong numbers with
 * no error -- the exact class of silent failure that killed all three Python
 * references.
 */

import * as cheerio from 'cheerio';
import {
  parseInteger,
  parseNumber,
  parsePrice,
  parseVolume,
  epochSecondsToIso,
} from './parse.js';
import { PsxSchemaError, PsxParseError } from './errors.js';
import { SELECTORS, SELECTOR_VERSION } from './selectors.js';
import type {
  Bar,
  CompanyProfile,
  IndexConstituent,
  IndexQuote,
  Sector,
  SectorSummary,
  SymbolInfo,
} from './types.js';

/** Envelope every gated JSON endpoint wraps its payload in. */
interface Envelope<T> {
  status?: number;
  message?: string;
  data?: T;
}

/**
 * Read a string property from an untyped JSON record.
 *
 * Centralised so the strict `noPropertyAccessFromIndexSignature` flag doesn't
 * force a cast at every one of the ~30 raw-JSON access sites. Returns `null`
 * for absent values and non-strings -- absence is the rule everywhere else.
 */
function str(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

/** Read a boolean property from an untyped JSON record. */
function bool(row: Record<string, unknown>, key: string): boolean {
  return row[key] === true;
}

/** Read a numeric-or-string property, handing it to the numeric parser. */
function num(row: Record<string, unknown>, key: string): number | null {
  return parseScalar(row[key]);
}

/**
 * Parse an untyped scalar into a number.
 *
 * Positional timeseries arrays arrive as `unknown[]`, so this is the entry
 * point for those -- it accepts the value directly rather than requiring a
 * record wrapper.
 */
function parseScalar(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  return parseNumber(value);
}

/** Narrow an untyped value to a JSON object, or `null` for anything else. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Unwrap the `{status, message, data}` envelope.
 *
 * @throws {@link PsxParseError} when the body is not JSON.
 * @throws {@link PsxSchemaError} when the envelope is absent or reports failure.
 */
export function unwrap<T>(body: unknown, url: string, what: string): T {
  if (typeof body !== 'object' || body === null) {
    throw new PsxParseError(`${what}: expected a JSON object`, String(body), { url });
  }

  const envelope = body as Envelope<T>;

  if (!('data' in envelope)) {
    throw new PsxSchemaError(
      `${what}: response had no \`data\` key. ` +
        `Keys present: ${JSON.stringify(Object.keys(envelope))}`,
      { url, selectorVersion: SELECTOR_VERSION, actual: JSON.stringify(Object.keys(envelope)) },
    );
  }

  // PSX uses status 1 for success. Anything else with an empty data array is
  // treated as "no data", which is a legitimate answer for many symbols.
  if (envelope.status !== undefined && envelope.status !== 1) {
    throw new PsxSchemaError(`${what}: upstream reported status ${envelope.status}`, {
      url,
      selectorVersion: SELECTOR_VERSION,
      actual: `status=${String(envelope.status)} message=${String(envelope.message ?? '')}`,
    });
  }

  return envelope.data as T;
}

/**
 * Parse `/symbols` -- the full directory of 1028 securities.
 *
 * Covers equities, debt, and ETFs. Returned as a bare top-level array (no
 * envelope), so it takes a different unwrap path than the timeseries.
 */
export function parseSymbols(body: unknown, url: string): SymbolInfo[] {
  if (!Array.isArray(body)) {
    throw new PsxSchemaError(
      `symbols: expected a top-level array, got ${typeof body}`,
      { url, selectorVersion: SELECTOR_VERSION, actual: typeof body },
    );
  }

  const symbols: SymbolInfo[] = [];

  for (const entry of body) {
    const row = asRecord(entry);
    if (row == null) continue;

    const symbol = str(row, 'symbol')?.trim() ?? '';
    if (symbol === '') continue;

    symbols.push({
      symbol: symbol.toUpperCase(),
      name: str(row, 'name') ?? '',
      sectorName: str(row, 'sectorName'),
      isEtf: bool(row, 'isETF') || bool(row, 'isEtf'),
      isDebt: bool(row, 'isDebt'),
    });
  }

  if (symbols.length === 0) {
    throw new PsxSchemaError('symbols: array contained no usable entries', {
      url,
      selectorVersion: SELECTOR_VERSION,
      actual: `${body.length} entries`,
    });
  }

  return symbols;
}

/**
 * Parse `/timeseries/eod/{SYM}` -- ~1239 daily bars for HBL, 5 years.
 *
 * Wire shape: `[[unixSeconds, close, volume, open], ...]`, **descending**.
 * Note there is no high/low; both are published as `null` rather than guessed.
 *
 * Output is **ascending** -- callers should not have to remember which way round
 * the upstream array runs, and every indicator in this library requires
 * ascending input.
 */
export function parseTimeseriesEod(body: unknown, url: string): Bar[] {
  const rows = unwrap<unknown[][]>(body, url, 'timeseries/eod');
  if (!Array.isArray(rows)) {
    throw new PsxSchemaError('timeseries/eod: `data` was not an array', {
      url,
      selectorVersion: SELECTOR_VERSION,
      actual: typeof rows,
    });
  }

  const bars: Bar[] = [];

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 4) continue;

    const seconds = parseScalar(row[0]);
    if (seconds == null) continue;

    const time = epochSecondsToIso(seconds);
    if (time == null) continue;

    // Position order is [ts, close, volume, open] -- close first, then open.
    bars.push({
      time,
      open: parsePrice(parseScalar(row[3])),
      high: null,
      low: null,
      close: parsePrice(parseScalar(row[1])),
      volume: parseVolume(parseScalar(row[2])),
    });
  }

  // Upstream sends descending (newest first); we normalise to ascending so
  // indicators and charts can assume chronological order.
  bars.sort((a, b) => a.time.localeCompare(b.time));

  return bars;
}

/**
 * Parse `/timeseries/int/{SYM}` -- intraday ticks.
 *
 * Wire shape: `[[unixSeconds, price, volume], ...]`, descending.
 */
export function parseTimeseriesIntraday(body: unknown, url: string): Bar[] {
  const rows = unwrap<unknown[][]>(body, url, 'timeseries/int');
  if (!Array.isArray(rows)) {
    throw new PsxSchemaError('timeseries/int: `data` was not an array', {
      url,
      selectorVersion: SELECTOR_VERSION,
      actual: typeof rows,
    });
  }

  const bars: Bar[] = [];

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 3) continue;

    const seconds = parseScalar(row[0]);
    if (seconds == null) continue;

    const time = epochSecondsToIso(seconds);
    if (time == null) continue;

    bars.push({
      time,
      open: null,
      high: null,
      low: null,
      close: parsePrice(parseScalar(row[1])),
      volume: parseVolume(parseScalar(row[2])),
    });
  }

  bars.sort((a, b) => a.time.localeCompare(b.time));

  return bars;
}

/**
 * Parse `/data/top-10-sectors` -- a bare array of `{name, code, volume}`.
 *
 * Distinct from `/sector-summary/sectorwise`, which is the HTML page giving
 * full per-sector aggregates. This is the lightweight JSON variant.
 */
export function parseTopSectors(body: unknown, url: string): Array<Sector & { volume: number | null }> {
  if (!Array.isArray(body)) {
    throw new PsxSchemaError('top-10-sectors: expected a top-level array', {
      url,
      selectorVersion: SELECTOR_VERSION,
      actual: typeof body,
    });
  }

  const sectors: Array<Sector & { volume: number | null }> = [];

  for (const entry of body) {
    const row = asRecord(entry);
    if (row == null) continue;

    const name = str(row, 'name')?.trim() ?? '';
    if (name === '') continue;

    sectors.push({
      code: str(row, 'code') ?? '',
      name,
      volume: parseVolume(num(row, 'volume')),
    });
  }

  return sectors;
}

/**
 * Parse `/data/top-10-symbols` -- a bare array of `{name, symbol, volume}`.
 */
export function parseTopSymbols(
  body: unknown,
  url: string,
): Array<{ symbol: string; name: string; volume: number | null }> {
  if (!Array.isArray(body)) {
    throw new PsxSchemaError('top-10-symbols: expected a top-level array', {
      url,
      selectorVersion: SELECTOR_VERSION,
      actual: typeof body,
    });
  }

  const symbols: Array<{ symbol: string; name: string; volume: number | null }> = [];

  for (const entry of body) {
    const row = asRecord(entry);
    if (row == null) continue;

    const symbol = str(row, 'symbol')?.trim() ?? '';
    if (symbol === '') continue;

    symbols.push({
      symbol: symbol.toUpperCase(),
      name: str(row, 'name') ?? '',
      volume: parseVolume(num(row, 'volume')),
    });
  }

  return symbols;
}

/**
 * Parse `/data/symbol-position` -- advance/decline breadth.
 *
 * Wire shape: `[{name: "ADV", value: 0.488}, {name: "DEC", ...}, ...]` where
 * values are **fractions**, not percentages. `0.488` means 48.8%.
 */
export function parseSymbolPosition(
  body: unknown,
  url: string,
): Array<{ name: string; fraction: number | null }> {
  if (!Array.isArray(body)) {
    throw new PsxSchemaError('symbol-position: expected a top-level array', {
      url,
      selectorVersion: SELECTOR_VERSION,
      actual: typeof body,
    });
  }

  return body
    .map((entry) => asRecord(entry))
    .filter((row): row is Record<string, unknown> => row != null)
    .map((row) => ({
      name: str(row, 'name') ?? '',
      fraction: num(row, 'value'),
    }))
    .filter((entry) => entry.name !== '');
}

/**
 * Parse the `/indices` carousel.
 *
 * Upstream renders each index as a block of stacked headings:
 * `<h3>KSE100</h3><h4>169969.32</h4><h5 class="up">368.92</h5><h6 class="up">(0.22%)</h6>`.
 *
 * Each heading level is selected within its **own block**, not globally, because
 * sibling indices share those tag names. Global `h4` selection would return 17
 * values for 17 indices in the wrong pairing.
 */

/**
 * Parse the dps `/indices` page.
 *
 * Prefers the full table, whose numeric cells carry `data-order` machine values,
 * and falls back to the carousel cards.
 *
 * **Sign trap.** PSX renders a *negative* percentage as `(0.22%)` in parentheses
 * while simultaneously tagging the cell `change__text--pos` (positive). The CSS
 * class is therefore not a reliable sign indicator on this page -- the
 * parentheses are. We read the machine value and let parentheses decide the
 * sign, rather than trusting the class.
 */
export function parseIndices(html: string, url: string): IndexQuote[] {
  const $ = cheerio.load(html);

  const tableRows = $(SELECTORS.indices.tableRow);

  if (tableRows.length > 0) {
    // Read headers from the table that actually owns these rows. The page has a
    // second <thead> ("Sector Indices") belonging to a different table, and
    // asserting against that one raises a spurious schema error.
    const headers = tableRows
      .first()
      .closest('table')
      .find('thead th')
      .map((_, el) => $(el).text().trim().toUpperCase())
      .get();

    assertIndicesHeaders(headers, url);

    // Index, High, Low, Current, Change, % Change -- note there is no Open.
    const currentAt = headers.findIndex((h) => h === 'CURRENT');
    const changeAt = headers.findIndex((h) => h === 'CHANGE');
    const pctAt = headers.findIndex((h) => h.includes('%'));

    const indices: IndexQuote[] = [];

    tableRows.each((_, element) => {
      const row = $(element);
      const code = row.find(SELECTORS.indices.tableCode).first().attr('data-code');
      if (code == null || code.trim() === '') return;

      const cells = row.find('td');
      const machine = (at: number): number | null =>
        at < 0 ? null : parseNumber(cells.eq(at).attr('data-order') ?? cells.eq(at).text());

      indices.push({
        code: code.trim().toUpperCase(),
        name: null,
        value: machine(currentAt),
        change: machine(changeAt),
        changePct: machine(pctAt),
        updatedAt: null,
      });
    });

    if (indices.length > 0) return indices;
  }

  // Fall back to the carousel cards.
  const cards = $(SELECTORS.indices.carouselItem);
  if (cards.length === 0) {
    throw new PsxSchemaError(
      `indices: neither the table (\`${SELECTORS.indices.tableRow}\`) nor the carousel ` +
        `(\`${SELECTORS.indices.carouselItem}\`) matched`,
      { url, selectorVersion: SELECTOR_VERSION },
    );
  }

  const indices: IndexQuote[] = [];

  cards.each((_, element) => {
    const card = $(element);
    const code = card.find(SELECTORS.indices.carouselCode).first().text().trim();
    if (code === '') return;

    // Carousel values are comma-formatted display text only -- no data-order.
    const rawPct = card.find(SELECTORS.indices.carouselChangePct).first().text().trim();

    indices.push({
      code: code.toUpperCase(),
      name: null,
      value: parseNumber(card.find(SELECTORS.indices.carouselValue).first().text()),
      change: parseNumber(card.find(SELECTORS.indices.carouselChange).first().text()),
      // Parentheses denote negative; the accompanying CSS class does not.
      changePct: parseSignedPercent(rawPct),
      updatedAt: null,
    });
  });

  return indices;
}

/**
 * Parse a percentage that may use accounting-style parentheses for negatives.
 *
 * `(0.22%)` -> `-0.22`. The `change__text--pos` class is ignored because PSX
 * applies it to negative values too.
 */
function parseSignedPercent(raw: string): number | null {
  const text = raw.trim();
  if (text === '') return null;

  const negativeByParens = /^\(.*\)$/.test(text);
  const magnitude = parseNumber(text.replace(/[()%]/g, ''));
  if (magnitude == null) return null;

  return negativeByParens && magnitude > 0 ? -magnitude : magnitude;
}

/** Assert the indices table has the columns we depend on. */
function assertIndicesHeaders(headers: readonly string[], url: string): void {
  // Verified 2026-09-30: the table headers are
  // [Index, High, Low, Current, Change, % Change].
  // Note there is no "Open" column, and "Index" (not "Symbol") names the code.
  const required = ['INDEX', 'CURRENT', 'CHANGE'];
  const missing = required.filter((h) => !headers.includes(h));
  if (missing.length > 0) {
    throw new PsxSchemaError(
      `indices table missing columns ${JSON.stringify(missing)}; found [${headers.join(', ')}]`,
      { url, selectorVersion: SELECTOR_VERSION, actual: headers.join(', ') },
    );
  }
}

/**
 * Parse index constituents from `/indices/{code}`.
 *
 * Wire shape is HTML. Each row carries the symbol, sector, index weight, and
 * point contribution, with `data-order` attributes holding machine values.
 */
export function parseConstituents(html: string, url: string, indexCode: string): IndexConstituent[] {
  const $ = cheerio.load(html);

  const rows = $('tbody tr, table tr');
  const constituents: IndexConstituent[] = [];

  rows.each((_, element) => {
    // Use the parent traversal directly -- no need to re-serialise and re-parse.
    const row = $(element);
    const cells = row.find('td');
    if (cells.length < 3) return;

    const symbol = (cells.eq(0).attr('data-search') ?? cells.eq(0).text()).trim();
    if (symbol === '') return;

    constituents.push({
      indexCode: indexCode.toUpperCase(),
      symbol: symbol.toUpperCase(),
      name: cells.eq(0).find('a').attr('data-title') ?? null,
      sector: cells.eq(1).text().trim() || null,
      weightPct: parseNumber(cells.eq(2).attr('data-order') ?? cells.eq(2).text()),
      indexPoints: null,
      freeFloatMn: null,
      marketCapMn: null,
      updatedAt: null,
    });
  });

  return constituents;
}

/**
 * Parse the dps `/company/{SYMBOL}` profile page.
 *
 * Stat pairs are `div.stats_label` / `div.stats_value` siblings. The label text
 * is the only key, so it is normalised (case, whitespace) before lookup.
 */
export function parseCompanyProfile(html: string, url: string, symbol: string): CompanyProfile {
  const $ = cheerio.load(html);

  const stats = new Map<string, string>();
  $('div.stats_label').each((_, element) => {
    const label = $(element).text().trim().toLowerCase();
    const value = $(element).next('div.stats_value').text().trim();
    if (label !== '') stats.set(label, value);
  });

  const stat = (key: string): number | null => {
    const raw = stats.get(key);
    return raw == null ? null : parseNumber(raw);
  };

  // Upstream's own misspelling `--decription` is load-bearing.
  const description = $('div.profile__item--decription p')
    .first()
    .text()
    .trim();

  const title = $('h1, h2').first().text().trim();

  const warnings: string[] = [];
  if (stats.size === 0) {
    warnings.push('no stats_label pairs found -- PSX may have changed the profile layout');
  }

  const totalShares = stat('shares');
  const freeFloat = stat('free float');

  return {
    symbol: symbol.toUpperCase(),
    name: title === '' ? null : title,
    sector: null,
    description: description === '' ? null : description,
    ldcp: stat('ldcp'),
    open: stat('open'),
    high: stat('high'),
    low: stat('low'),
    current: stat('ldcp') ?? stat('current'),
    volume: stat('volume'),
    totalShares: totalShares == null ? null : parseInteger(totalShares),
    freeFloatShares: freeFloat == null ? null : parseInteger(freeFloat),
    updatedAt: null,
    warnings,
  };
}

/**
 * Parse the `/sector-summary/sectorwise` HTML table.
 *
 * Columns are located by header name via the shared alias table in
 * {@link parseAggregates}, so a column reordering is survivable.
 */
export function parseSectorSummaries(html: string, url: string): SectorSummary[] {
  const $ = cheerio.load(html);

  const headers = $('thead th')
    .map((_, el) => $(el).text().trim().toUpperCase())
    .get();

  if (headers.length === 0) {
    throw new PsxSchemaError('sector-summary: no <thead> headers found', {
      url,
      selectorVersion: SELECTOR_VERSION,
    });
  }

  const find = (names: readonly string[]): number =>
    headers.findIndex((header) => names.some((name) => header.includes(name)));

  const sectorAt = find(['SECTOR', 'NAME']);
  const advancedAt = find(['ADVANCED']);
  const declinedAt = find(['DECLINED']);
  const unchangedAt = find(['UNCHANGED']);
  const volumeAt = find(['VOLUME']);
  const turnoverAt = find(['VALUE', 'TURNOVER']);
  const capAt = find(['MARKET CAP', 'MCAP', 'CAP']);

  const summaries: SectorSummary[] = [];

  $('tbody tr, table tr').each((_, element) => {
    const row = $(element);
    const cells = row.find('td');
    if (cells.length === 0) return;

    const sectorName = cells.eq(sectorAt < 0 ? 0 : sectorAt).text().trim();
    if (sectorName === '') return;

    summaries.push({
      sector: { code: '', name: sectorName },
      advanced: parseNumber(cells.eq(advancedAt < 0 ? -1 : advancedAt).attr('data-order') ?? '') ?? null,
      declined: parseNumber(cells.eq(declinedAt < 0 ? -1 : declinedAt).attr('data-order') ?? '') ?? null,
      unchanged: parseNumber(cells.eq(unchangedAt < 0 ? -1 : unchangedAt).attr('data-order') ?? '') ?? null,
      volume: parseVolume(cells.eq(volumeAt < 0 ? -1 : volumeAt).attr('data-order') ?? ''),
      turnover: parsePrice(cells.eq(turnoverAt < 0 ? -1 : turnoverAt).attr('data-order') ?? ''),
      marketCapBn: parseNumber(cells.eq(capAt < 0 ? -1 : capAt).attr('data-order') ?? ''),
      updatedAt: null,
    });
  });

  return summaries;
}

export type { SectorSummary };
