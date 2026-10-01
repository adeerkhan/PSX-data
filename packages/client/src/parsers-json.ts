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
import { SELECTORS, SELECTOR_VERSION, assertMatched } from './selectors.js';
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
 * Parse the `/indices/{code}` constituent table.
 *
 * The table has 11 columns, verified against live KSE100 on 2026-10-01:
 *
 *   SYMBOL | NAME | LDCP | CURRENT | CHANGE | CHANGE (%) |
 *   IDX WTG (%) | IDX POINT | VOLUME | FREEFLOAT (M) | MARKET CAP (M)
 *
 * Columns are located by header name, never by position. An earlier version
 * assumed a 3-column row and read LDCP as the index weight, reporting Allied
 * Bank with a weight of 169.66% instead of 0.41%. Header names survive column
 * reordering; assumed column counts do not.
 */
export function parseConstituents(
  html: string,
  url: string,
  indexCode: string,
): IndexConstituent[] {
  const $ = cheerio.load(html);

  // Read headers from the table that owns these rows, so a second <thead>
  // belonging to another table cannot shift the column map.
  const rows = $('tbody tr');
  assertMatched('index constituent rows', 'tbody tr', rows.length, url);

  const headers = rows
    .first()
    .closest('table')
    .find('thead th')
    .map((_, el) => $(el).text().trim().toUpperCase())
    .get();

  const find = (candidates: readonly string[]): number =>
    headers.findIndex((header) => candidates.some((c) => header.includes(c)));

  const symbolAt = find(['SYMBOL']);
  const nameAt = find(['NAME']);
  const ldcpAt = find(['LDCP']);
  const currentAt = find(['CURRENT']);
  const changeAt = find(['CHANGE']);
  // "CHANGE" also matches "CHANGE (%)", so require the exact header.
  const changePctAt = headers.findIndex((h) => h === 'CHANGE (%)');
  const weightAt = find(['WTG', 'WEIGHT']);
  const pointAt = find(['POINT']);
  const volumeAt = find(['VOLUME']);
  const freeFloatAt = find(['FREEFLOAT', 'FREE FLOAT']);
  const marketCapAt = find(['MARKET CAP', 'MARKETCAP']);

  if (symbolAt < 0) {
    throw new PsxSchemaError(
      `index constituents: no SYMBOL column in [${headers.join(', ')}]`,
      { url, selectorVersion: SELECTOR_VERSION, actual: headers.join(', ') },
    );
  }

  const constituents: IndexConstituent[] = [];

  rows.each((_, element) => {
    const row = $(element);
    const cells = row.find('td');
    if (cells.length === 0) return;

    // Prefer `data-order`; the weight column has none upstream, so text is the
    // fallback rather than the exception.
    const cellNum = (at: number): number | null => {
      if (at < 0) return null;
      const cell = cells.eq(at);
      if (cell.length === 0) return null;
      return parseNumber(cell.attr('data-order') ?? cell.text());
    };

    const symbol = (cells.eq(symbolAt).attr('data-search') ?? cells.eq(symbolAt).text()).trim();
    if (symbol === '') return;

    constituents.push({
      indexCode: indexCode.toUpperCase(),
      symbol: symbol.toUpperCase(),
      name: nameAt < 0 ? null : cells.eq(nameAt).text().trim() || null,
      // This endpoint publishes no sector column. Left null rather than
      // borrowed from the name, which would be wrong. Use `symbols()` for
      // sector codes.
      sector: null,
      weightPct: cellNum(weightAt),
      indexPoints: cellNum(pointAt),
      freeFloatMn: cellNum(freeFloatAt),
      marketCapMn: cellNum(marketCapAt),
      ldcp: cellNum(ldcpAt),
      current: cellNum(currentAt),
      change: cellNum(changeAt),
      changePct: cellNum(changePctAt),
      volume: cellNum(volumeAt),
      updatedAt: null,
    });
  });

  if (constituents.length === 0) {
    throw new PsxSchemaError('index constituents: rows found but none carried a symbol', {
      url,
      selectorVersion: SELECTOR_VERSION,
      actual: `${rows.length} rows`,
    });
  }

  return constituents;
}

/**
 * Parse the dps `/company/{SYMBOL}` profile page.
 *
 * **The page concatenates several stat blocks that reuse the same labels.**
 * Verified against HBL on 2026-09-30, the document carries:
 *
 *   block 1 -- live quote:     Open 302.80, High 309.00, Low 302.80,
 *                               Volume 1,153,509, LDCP 302.15
 *   block 2 -- previous close: Close 308.29, LDCP 304.53, Change 1.23%,
 *                               Volume 124,500, Total Trades 136
 *   block 3 -- index entries:  Open 0.00, High 0.00, ... (all zeros)
 *
 * So `Open`, `High`, `Low`, `LDCP`, `Volume` and `Free Float` each appear more
 * than once, with different meanings and different units -- `Free Float` is
 * `586,741,003` in one block and `40.00%` in another.
 *
 * A naive `Map.set()` keeps the LAST occurrence, which silently reported:
 *   - `current`/`ldcp`/`volume` as block 3's zeros,
 *   - `freeFloatShares` as `null`, because `40.00` is a percentage, not a count.
 *
 * So we collect **every** value per label and read the FIRST, which is the live
 * quote block. Duplicate labels are recorded in `warnings` rather than hidden.
 */
export function parseCompanyProfile(html: string, url: string, symbol: string): CompanyProfile {
  const $ = cheerio.load(html);

  /** label -> every value seen for it, in document order. */
  const allValues = new Map<string, string[]>();
  $('div.stats_label').each((_, element) => {
    const label = $(element).text().trim().toLowerCase();
    const value = $(element).next('div.stats_value').text().trim();
    if (label === '') return;
    const existing = allValues.get(label);
    if (existing == null) allValues.set(label, [value]);
    else existing.push(value);
  });

  const warnings: string[] = [];

  /** First (live-quote-block) value for a label. */
  const first = (key: string): string | null => allValues.get(key)?.[0] ?? null;

  const stat = (key: string): number | null => {
    const raw = first(key);
    return raw == null ? null : parseNumber(raw);
  };

  // A share count must be an integer count; a percentage under the same label
  // ("Free Float" = "40.00%") is a different field entirely and must not be
  // mistaken for a share tally.
  const shareCount = (key: string): number | null => {
    const raw = first(key);
    if (raw == null) return null;
    if (raw.includes('%')) return null;
    const value = parseNumber(raw);
    return value == null ? null : Math.round(value);
  };

  // Surface ambiguous labels rather than silently picking one.
  for (const [label, values] of allValues) {
    if (values.length > 1) {
      const distinct = new Set(values).size;
      if (distinct > 1) {
        warnings.push(
          `label "${label}" appears ${values.length} times with differing values ` +
            `(${values.map((v) => JSON.stringify(v)).join(', ')}); read the first. ` +
            `PSX concatenates multiple stat blocks on this page.`,
        );
      }
    }
  }

  // Upstream's own misspelling `--decription` is load-bearing.
  const description = $('div.profile__item--decription p')
    .first()
    .text()
    .trim();

  const title = $('h1, h2').first().text().trim();

  if (allValues.size === 0) {
    warnings.push('no stats_label pairs found -- PSX may have changed the profile layout');
  }

  const totalShares = shareCount('shares');
  const freeFloatShares = shareCount('free float');

  return {
    symbol: symbol.toUpperCase(),
    name: title === '' ? null : title,
    sector: null,
    description: description === '' ? null : description,
    ldcp: stat('ldcp'),
    open: stat('open'),
    high: stat('high'),
    low: stat('low'),
    // NOTE: do not fall back to `ldcp` here. LDCP is the *previous* session's
    // close, so substituting it reports a stale price as the live one. The live
    // block on this page publishes Open/High/Low/Volume/LDCP but no "Current";
    // absence is the honest answer until PSX publishes one.
    current: stat('current'),
    volume: stat('volume'),
    totalShares,
    freeFloatShares,
    // The previous-close block publishes a real "Close"; the live block does not.
    // Surfaced separately rather than folded into `current`.
    previousClose: stat('close'),
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

  // The page holds 39 tables. Only the FIRST is the sector table (7 columns);
  // the other 38 are nested market-watch tables with 10 columns each.
  //
  // Reading `$('thead th')` globally concatenates all of them, so a global
  // `findIndex('VOLUME')` resolves to index 10 -- a market-watch column, not a
  // sector column. That produced 595 rows with garbage turnover/volume/market-cap
  // fields. So scope to the table that actually has sector headers.
  const sectorTable = findSectorTable($);
  assertMatched('sector-summary rows', SELECTORS.sectorSummary.row, sectorTable.length, url);

  const headers = sectorTable
    .first()
    .closest('table')
    .find('thead th')
    .map((_, el) => $(el).text().trim().toUpperCase())
    .get();

  const find = (names: readonly string[]): number =>
    headers.findIndex((header) => names.some((name) => header.includes(name)));

  // Verified 2026-09-30 header text:
  //   [Sector Code | Sector Name | Advance | Decline | Unchange | Turnover | Market Cap. (B)]
  //
  // Note the singular "Advance"/"Decline"/"Unchange" -- the market-watch tables
  // use plural "Advanced"/"Declined", which is why matching must be exact-ish and
  // scoped to this table.
  const sectorCodeAt = find(['SECTOR CODE']);
  const sectorNameAt = find(['SECTOR NAME']);
  const advancedAt = find(['ADVANCE']);
  const declinedAt = find(['DECLINE']);
  const unchangedAt = find(['UNCHANGE']);
  const volumeAt = find(['VOLUME', 'TURNOVER']);
  const capAt = find(['MARKET CAP', 'MCAP']);

  // "Sector Code" and "Sector Name" must both resolve; without them we would be
  // reading the wrong table and silently producing nonsense.
  for (const [label, at] of [
    ['Sector Code', sectorCodeAt],
    ['Sector Name', sectorNameAt],
    ['Advance', advancedAt],
  ] as const) {
    if (at < 0) {
      throw new PsxSchemaError(
        `sector-summary: could not locate column "${label}" in [${headers.join(', ')}]`,
        { url, selectorVersion: SELECTOR_VERSION, actual: headers.join(', ') },
      );
    }
  }

  const summaries: SectorSummary[] = [];

  sectorTable.each((_, element) => {
    const row = $(element);
    const cells = row.find('td');
    if (cells.length === 0) return;

    const code = cells.eq(sectorCodeAt).text().trim();
    const name = cells.eq(sectorNameAt).text().trim();
    // Sector codes are numeric (`0801`); a non-numeric first cell means we are
    // reading a header or spacer row, not a sector.
    if (name === '' || !/^\d+$/.test(code)) return;

    const cellNum = (at: number): number | null => {
      if (at < 0) return null;
      const cell = cells.eq(at);
      // `data-order` is the machine value where present. The name cell carries a
      // stray `data-order` upstream, but we never read that cell numerically.
      const machine = cell.attr('data-order');
      return parseNumber(machine ?? cell.text());
    };

    summaries.push({
      sector: { code, name },
      advanced: cellNum(advancedAt),
      declined: cellNum(declinedAt),
      unchanged: cellNum(unchangedAt),
      // PSX labels the traded-share column "Turnover"; it is a volume in shares.
      volume: cellNum(volumeAt) == null ? null : Math.round(cellNum(volumeAt) ?? 0),
      // "Turnover" in PSX's own vocabulary is share volume, not PKR. This page
      // publishes no separate PKR turnover column, so it is absent by design.
      turnover: null,
      // "Market Cap. (B)" is billions of PKR. It carries no `data-order`, so the
      // formatted text ("1,539.34") is parsed instead.
      marketCapBn: cellNum(capAt),
      updatedAt: null,
    });
  });

  return summaries;
}

/**
 * Locate the rows of the sector-summary table.
 *
 * Identified by shape rather than position: a table whose headers include both
 * "Sector Code" and "Sector Name". Using `table:first` would work today but
 * breaks the moment PSX inserts a banner table above it.
 */
function findSectorTable($: cheerio.CheerioAPI): ReturnType<cheerio.CheerioAPI> {
  const selector = SELECTORS.sectorSummary.row;
  let matched = $();

  $('table').each((_, table) => {
    if (matched.length > 0) return;
    const headers = $(table)
      .find('thead th')
      .map((_, el) => $(el).text().trim().toUpperCase())
      .get();
    const hasSectorHeaders =
      headers.some((h) => h.includes('SECTOR CODE')) &&
      headers.some((h) => h.includes('SECTOR NAME'));
    if (hasSectorHeaders) {
      matched = $(table).find(selector);
    }
  });

  return matched;
}

export type { SectorSummary };
