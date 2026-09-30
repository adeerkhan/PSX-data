/**
 * Market parsers: the two sources that carry live quotes.
 *
 * Both are HTML, and both are the part of this library most likely to break --
 * so both parse defensively:
 *
 * - **Header-name-driven, not positional.** Cells are located by matching the
 *   `<th>` header text to a field name. If PSX reorders or inserts a column,
 *   extraction still works; only a *rename* surfaces, and it surfaces loudly.
 * - **`data-order` before text.** Where a machine value exists we read it and
 *   never parse the formatted display string.
 * - **Per-row warnings, never throw.** One malformed row costs one row, not the
 *   other 588. Structural failures -- no rows at all, header mismatch -- do
 *   throw {@link PsxSchemaError}.
 */

import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import {
  MARKET_WATCH_HEADERS,
  SELECTORS,
  SELECTOR_VERSION,
  assertHeaders,
  assertMatched,
} from './selectors.js';
import {
  parseInteger,
  parseList,
  parsePktTimestamp,
  parsePrice,
  parseSignedPrice,
  parseVolume,
} from './parse.js';
import { PsxSchemaError } from './errors.js';
import type { MarketStatus, Quote, MarketSummary } from './types.js';

/**
 * Field-name aliases, so a header rename has an escape hatch.
 *
 * Keys are normalised header text; values are {@link Quote} field names. Note
 * `SCRIP` -- upstream's typo for `SCRIP`, which is what the market-summary page
 * actually publishes.
 */
const HEADER_ALIASES: ReadonlyMap<string, keyof Quote> = new Map([
  ['SYMBOL', 'symbol'],
  ['SCRIP', 'symbol'],
  ['NAME', 'name'],
  ['COMPANY', 'name'],
  ['SECTOR', 'sector'],
  ['SECTOR NAME', 'sectorName'],
  ['LISTED IN', 'listedIn'],
  ['LDCP', 'ldcp'],
  ['OPEN', 'open'],
  ['HIGH', 'high'],
  ['LOW', 'low'],
  ['CURRENT', 'current'],
  ['LAST', 'current'],
  ['CHANGE', 'change'],
  ['CHANGE (%)', 'changePct'],
  ['CHANGE%', 'changePct'],
  ['VOLUME', 'volume'],
  ['VALUE', 'value'],
]);

/** Resolve a header cell to a {@link Quote} field, or `undefined` if unknown. */
function fieldForHeader(header: string): keyof Quote | undefined {
  return HEADER_ALIASES.get(header.trim().toUpperCase());
}

/**
 * Extract a numeric cell, preferring `data-order` over display text.
 *
 * `data-order` holds the unformatted machine value (`"73446994"` beside
 * `"73,446,994"`), so a comma-formatted display string never has to be parsed.
 */
function numericCell(
  row: cheerio.Cheerio<AnyNode>,
  index: number,
  kind: 'price' | 'volume',
): number | null {
  if (index < 0) return null;
  const cell = row.children('td').eq(index);
  if (cell.length === 0) return null;

  const machine = cell.attr('data-order');
  const raw = machine ?? cell.text();

  return kind === 'price' ? parsePrice(raw) : parseVolume(raw);
}

/** Map PSX status text onto our closed enum. */
function normaliseStatus(raw: string): MarketStatus {
  const text = raw.trim().toUpperCase();
  if (text.startsWith('OPEN')) return 'OPEN';
  if (text.startsWith('CLOSED') || text.startsWith('CLOSE')) return 'CLOSED';
  if (text.includes('PRE')) return 'PRE_OPEN';
  return 'UNKNOWN';
}

/**
 * Parse the dps `/market-watch` table (495 rows, 11 columns).
 *
 * Verified cell layout:
 *   [0] symbol (data-search) [1] sector [2] listedIn
 *   [3] ldcp [4] open [5] high [6] low [7] current
 *   [8] change [9] change% [10] volume
 *
 * @param html - Raw response body.
 * @param url - Source URL, for error messages.
 * @returns One {@link Quote} per row, in document order.
 * @throws {@link PsxSchemaError} when the table is absent or headers changed.
 */
export function parseMarketWatch(html: string, url: string): Quote[] {
  const $ = cheerio.load(html);

  // Assert headers before extracting anything, so a rename is reported as a
  // rename rather than as a pile of nulls.
  const headerTexts = $(SELECTORS.marketWatch.headerRow)
    .map((_, el) => $(el).text().trim())
    .get();
  if (headerTexts.length > 0) {
    assertHeaders(MARKET_WATCH_HEADERS, headerTexts, url);
  }

  // Rows are identified by the symbol cell's `data-search` attribute, which
  // excludes header rows, spacer rows, and total rows.
  const symbolCells = $(SELECTORS.marketWatch.symbol);
  assertMatched('market-watch data rows', SELECTORS.marketWatch.symbol, symbolCells.length, url);

  // Header text -> column index. Header cells live in `<thead>` so their 1-based
  // position matches the 1-based position of each `<td>` in a body row.
  const columnForField = new Map<keyof Quote, number>();
  headerTexts.forEach((header, position) => {
    const field = fieldForHeader(header);
    // +1: `<th>` position 1 corresponds to `<td>` index 0.
    if (field != null) columnForField.set(field, position);
  });

  const indexOf = (field: keyof Quote, fallback: number): number =>
    columnForField.get(field) ?? fallback;

  const ldcpAt = indexOf('ldcp', 3);
  const openAt = indexOf('open', 4);
  const highAt = indexOf('high', 5);
  const lowAt = indexOf('low', 6);
  const currentAt = indexOf('current', 7);
  const changeAt = indexOf('change', 8);
  const changePctAt = indexOf('changePct', 9);
  const volumeAt = indexOf('volume', 10);
  const sectorAt = indexOf('sector', 1);
  const listedInAt = indexOf('listedIn', 2);

  const updatedAt = new Date().toISOString();
  const quotes: Quote[] = [];

  symbolCells.each((_, element) => {
    const cell = $(element);
    // The symbol cell is itself the row's first `<td>`; its parent is the row.
    const row = cell.closest('tr');
    const warnings: string[] = [];

    const symbol = (cell.attr('data-search') ?? cell.attr('data-order') ?? '').trim();
    if (symbol === '') {
      warnings.push('symbol cell carried no data-search or data-order value');
      return;
    }

    const nameAttr = row.find(SELECTORS.marketWatch.symbolTitle).attr('data-title');
    const sectorRaw = row.children('td').eq(sectorAt).text().trim();
    const sector = sectorRaw === '' ? null : sectorRaw;

    const ldcp = numericCell(row, ldcpAt, 'price');
    const current = numericCell(row, currentAt, 'price');

    if (ldcp == null && current == null) {
      warnings.push('both LDCP and CURRENT absent -- row carried no prices');
    }

    quotes.push({
      symbol: symbol.toUpperCase(),
      name: nameAttr?.trim() || null,
      sector,
      sectorName: null,
      listedIn: parseList(row.children('td').eq(listedInAt).text()),
      ldcp,
      open: numericCell(row, openAt, 'price'),
      high: numericCell(row, highAt, 'price'),
      low: numericCell(row, lowAt, 'price'),
      current,
      // Change is legitimately negative for decliners -- parsePrice would
      // reject those and silently report every decliner as unchanged.
      change: parseSignedPrice(row.children('td').eq(changeAt).attr('data-order')),
      // PSX publishes the percentage; we do not recompute it from change/ldcp,
      // because recomputing silently disagrees with the exchange on rounding.
      changePct: parseSignedPrice(row.children('td').eq(changePctAt).attr('data-order')),
      volume: numericCell(row, volumeAt, 'volume'),
      value: null,
      updatedAt,
      warnings,
    });
  });

  return quotes;
}

/**
 * Parse the www `/market-summary/` page (589 symbols + exchange-wide scalars).
 *
 * This is the ungated source: no key, no `X-Requested-With`, no spoofed UA, and
 * it works with a bare `fetch`. It is therefore both the primary and the
 * fallback when the gated host rejects us.
 *
 * Verified cell layout (8 columns):
 *   [0] symbol+name (data-srip) [1] LDCP [2] OPEN [3] HIGH [4] LOW
 *   [5] CURRENT [6] CHANGE [7] VOLUME
 */
export function parseMarketSummaryPage(html: string, url: string): {
  summary: MarketSummary;
  quotes: Quote[];
} {
  const $ = cheerio.load(html);

  const symbolCells = $(SELECTORS.marketSummary.symbolCell);
  assertMatched(
    'market-summary rows',
    `${SELECTORS.marketSummary.symbolCell} [${SELECTORS.marketSummary.symbolAttr}]`,
    symbolCells.length,
    url,
  );

  const updatedAt = parsePktTimestamp(firstTimestamp($));

  // Market-wide scalars live in `<p><span>Label:</span> value</p>` pairs.
  const scalars = new Map<string, string>();
  $(SELECTORS.marketSummary.summaryLabel).each((_, element) => {
    const label = $(element).text().trim().replace(/:$/, '');
    const value = $(element).parent().text().trim().replace(/^[^:]*:/, '').trim();
    if (label !== '') scalars.set(label.toUpperCase(), value);
  });

  const scalar = (key: string): number | null => {
    const raw = scalars.get(key);
    return raw == null ? null : parseInteger(raw);
  };

  const statusRaw = scalars.get('STATUS') ?? '';

  const summary: MarketSummary = {
    status: normaliseStatus(statusRaw),
    statusRaw,
    volume: scalar('VOLUME'),
    value: scalar('VALUE'),
    trades: scalar('TRADES'),
    advanced: scalar('ADVANCED'),
    declined: scalar('DECLINED'),
    unchanged: scalar('UNCHANGED'),
    total: scalar('TOTAL'),
    updatedAt,
  };

  // Sector attribution: walk `<h4>` elements in document order; the publication
  // timestamp is the one that parses as a date, everything else names a sector.
  const sectorByRow = attributeSectors($);

  const quotes: Quote[] = [];

  symbolCells.each((index, element) => {
    const cell = $(element);
    const row = cell.closest('tr');
    const warnings: string[] = [];

    const symbol = (cell.attr(SELECTORS.marketSummary.symbolAttr) ?? '').trim();
    if (symbol === '') {
      warnings.push('symbol cell carried no data-srip value');
      return;
    }

    const name = cell.text().trim() || null;
    const ldcp = numericCell(row, 1, 'price');
    const current = numericCell(row, 5, 'price');

    // The CHANGE cell holds a direction span followed by the number:
    //   <td> <span class="decrease-rate"></span> -0.13</td>
    //
    // The span is empty, so the sign lives in the text, and this cell carries no
    // `data-order` -- hence a text read rather than numericCell(). `.text()`
    // concatenates descendant nodes, so the number beside the empty span is
    // still found; trimming isolates it from surrounding whitespace.
    const changeText = row.children('td').eq(6).text().trim();
    const change = parseSignedPrice(changeText);
    if (change == null && changeText !== '') {
      warnings.push(`change cell present but unparseable: ${JSON.stringify(changeText)}`);
    }

    if (ldcp == null && current == null) {
      warnings.push('both LDCP and CURRENT absent -- row carried no prices');
    }

    quotes.push({
      symbol: symbol.toUpperCase(),
      name,
      sector: sectorByRow.get(index) ?? null,
      sectorName: null,
      listedIn: [],
      ldcp,
      open: numericCell(row, 2, 'price'),
      high: numericCell(row, 3, 'price'),
      low: numericCell(row, 4, 'price'),
      current,
      change,
      changePct: null, // This page publishes no percentage column.
      volume: numericCell(row, 7, 'volume'),
      value: null,
      updatedAt: updatedAt ?? new Date().toISOString(),
      warnings,
    });
  });

  if (quotes.length === 0) {
    throw new PsxSchemaError('market-summary symbol cells all carried empty symbols', {
      url,
      selectorVersion: SELECTOR_VERSION,
      actual: `${symbolCells.length} cells, 0 usable`,
    });
  }

  return { summary, quotes };
}

/**
 * Find the publication timestamp among the page's `<h4>` elements.
 *
 * Only one `<h4>` matches the datetime shape; the rest are sector headers.
 */
function firstTimestamp($: CheerioAPI): string | null {
  let found: string | null = null;
  $('h4').each((_, element) => {
    if (found != null) return;
    const text = $(element).text().trim();
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(text)) {
      found = text;
    }
  });
  return found;
}

/**
 * Map each symbol-cell index to the sector named by its preceding `<h4>`.
 *
 * Best-effort by design. Returns an empty map when the document does not follow
 * the expected group-header pattern, which makes callers fall back to `null`
 * sectors rather than silently mislabelling rows -- a wrong sector is worse
 * than an absent one.
 */
function attributeSectors($: CheerioAPI): Map<number, string> {
  const mapping = new Map<number, string>();
  const symbolCellCount = $('td.dataportal[data-srip]').length;

  let currentSector: string | null = null;
  let assigned = 0;

  $('h4, td.dataportal[data-srip]').each((_, element) => {
    const $el = $(element);

    if ($el.is('h4')) {
      const text = $el.text().trim();
      const isTimestamp = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(text);
      if (isTimestamp) {
        // The timestamp ends any sector block.
        currentSector = null;
      } else if (text !== '' && /^[A-Z0-9 &()/'.,-]+$/.test(text)) {
        // Sector headings are ALL-CAPS names, e.g. "APPAREL".
        currentSector = text;
      }
      return;
    }

    if (currentSector != null) {
      mapping.set(assigned, currentSector);
      assigned += 1;
    }
  });

  // Nothing attributed, or implausibly little, means the pattern did not hold.
  // Discard entirely rather than label only some rows.
  if (mapping.size === 0 || mapping.size < symbolCellCount * 0.5) {
    return new Map();
  }

  return mapping;
}
