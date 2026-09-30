/**
 * Versioned selector manifest -- the single place every brittle CSS selector
 * lives.
 *
 * **Why this exists.** All three Python references in `ref/` failed the same
 * way: PSX changed its markup, the parsers silently returned empty or partial
 * results, and nobody noticed for years. `psx-data-reader` broke when PSX
 * renamed a `TIME` column to `Date` in August 2022; its open issue is still
 * `KeyError: "None of ['TIME'] are in the columns"`.
 *
 * Two rules make that failure mode impossible here:
 *
 * 1. **Every selector lives here.** No ad-hoc selectors in parser code. When
 *    PSX changes markup, there is exactly one file to update and exactly one
 *    version to bump.
 * 2. **Parsers assert before extracting.** Every parser validates that the
 *    structural markers below actually matched, and throws
 *    {@link PsxSchemaError} naming the specific selector that failed.
 *
 * Bump {@link SELECTOR_VERSION} in the same commit as any selector change. It
 * is embedded in every schema error so a user's bug report is attributable to a
 * known manifest state.
 */

import { PsxSchemaError } from './errors.js';

/**
 * Manifest version. Embedded in every `PsxSchemaError`.
 *
 * v1 2026-09-30 -- initial manifest, verified against live responses.
 *   - dps `/market-watch`: 495 rows, 11 `<th>` headers confirmed.
 *   - www `/market-summary/`: 589 rows, `data-srip` attribute confirmed.
 *   - All 7 JSON endpoints confirmed returning JSON.
 */
export const SELECTOR_VERSION = 'v1';

/** Upstream hosts. */
export const HOSTS = {
  /** Data Portal Services -- the JSON + HTML endpoints behind the gate. */
  dps: 'https://dps.psx.com.pk',
  /**
   * Main exchange site -- the market-summary page.
   *
   * This one needs no key, no `X-Requested-With`, and no spoofed UA. It is the
   * primary source, and the fallback when the gated host rejects us.
   */
  www: 'https://www.psx.com.pk',
} as const;

/**
 * PSX's browser-UA allowlist.
 *
 * Verified: `python-requests` -> 404, `node-fetch` -> 404, `curl/8.4.0` -> 404,
 * `undici` (Node's default) -> 404. A Chrome UA is mandatory.
 */
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/**
 * The Origin PSX's WAF allowlists. Any other origin gets 403 with a
 * zero-length body. We send it deliberately -- omitting `Origin` also works,
 * but sending the allowlisted value is more honest about what we are.
 */
export const ALLOWED_ORIGIN = HOSTS.dps;

/** Column headers on dps `/market-watch`, in order. Verified 2026-09-30. */
export const MARKET_WATCH_HEADERS = [
  'SYMBOL',
  'SECTOR',
  'LISTED IN',
  'LDCP',
  'OPEN',
  'HIGH',
  'LOW',
  'CURRENT',
  'CHANGE',
  'CHANGE (%)',
  'VOLUME',
] as const;

/** Column headers on www `/market-summary/` rows, in order. */
export const MARKET_SUMMARY_HEADERS = [
  'SCRIP',
  'LDCP',
  'OPEN',
  'HIGH',
  'LOW',
  'CURRENT',
  'CHANGE',
  'VOLUME',
] as const;

/**
 * CSS selectors, grouped by source and endpoint.
 *
 * Kept flat and explicitly named rather than nested so a stack trace or error
 * message can point at exactly one string.
 */
export const SELECTORS = {
  /**
   * dps `/market-watch` -- 495 rows, all 11 columns.
   *
   * Numeric cells carry a `data-order` attribute holding the *unformatted*
   * machine value (`data-order="73446994"` next to text `73,446,994`). We read
   * that attribute, never the text, so we never parse a formatted number.
   */
  marketWatch: {
    /** Data rows. Excluded by asserting on `data-search` presence. */
    row: 'tr',
    /** Symbol cell. Carries `data-search` (symbol) and `data-order`. */
    symbolCell: 'td[data-search]',
    /** The machine-readable symbol attribute. */
    symbol: 'td[data-search][data-order]',
    /** Sector code cell -- positional (2nd `<td>`). */
    sector: 'td:nth-child(2)',
    /** Indices-listed-in cell -- positional (3rd `<td>`). */
    listedIn: 'td:nth-child(3)',
    /** Human-readable symbol name, from the link's `data-title`. */
    symbolTitle: 'a.tbl__symbol[data-title]',
    /** Header row, used to assert column layout before extraction. */
    headerRow: 'thead th',
  },

  /**
   * www `/market-summary/` -- 589 symbols.
   *
   * Upstream's own attribute is misspelled `data-srip` (s-r-i-p, not "script").
   * This is load-bearing: it is the only reliable symbol identifier on the
   * row, since the visible cell text is a company *name* rather than a ticker.
   */
  marketSummary: {
    /** Symbol cell carrying the load-bearing misspelled attribute. */
    symbolCell: 'td.dataportal[data-srip]',
    /** The symbol itself. */
    symbolAttr: 'data-srip',
    /** Sector group header rows, used to attribute each table to its sector. */
    sectorHeader: 'h4',
    /** Market-wide scalars, matched by their label text. */
    summaryLabel: 'p > span',
    /** The publication timestamp, `<h4>2026-09-30 21:33:02</h4>`. */
    timestamp: 'h4',
    /** "No Data found!" empty states -- 2 present on the live page. */
    emptyState: 'td, div',
  },

  /**
   * dps `/indices`.
   *
   * Corrected 2026-09-30 against live bytes. The page renders the index data
   * in **two** places with different structures:
   *
   * 1. A top carousel of `div.topIndices__item` cards using
   *    `topIndices__item__name` / `__val` / `__change` / `__changep` classes.
   * 2. A full table with columns Symbol, Open, High, Low, Current, Change,
   *    % Change, where numeric cells carry `data-order`.
   *
   * An earlier probe reported `div.indices-single` with `h3`/`h4`/`h5`/`h6`
   * headings. **That structure does not exist** -- the live page has zero `<h3>`
   * and zero `indices-single` elements. The full table is preferred because its
   * `data-order` attributes give machine values.
   */
  indices: {
    /** Full table rows. */
    tableRow: 'tbody.tbl__body tr',
    /** Index code, from the row's `data-code` attribute. */
    tableCode: 'td a[data-code]',
    /** Carousel cards, as a fallback when the table is absent. */
    carouselItem: 'div.topIndices__item',
    carouselCode: 'div.topIndices__item__name',
    carouselValue: 'div.topIndices__item__val',
    carouselChange: 'div.topIndices__item__change',
    carouselChangePct: 'div.topIndices__item__changep',
    /** Header cells, for the header assertion. */
    headerRow: 'thead th',
  },

  /** dps `/company/{SYMBOL}`. */
  company: {
    /** Label/value stat pairs. */
    statLabel: 'div.stats_label',
    statValue: 'div.stats_value',
    /**
     * Description container. Upstream's own misspelling `--decription` is
     * load-bearing and must be matched exactly.
     */
    description: 'div.profile__item--decription',
    /** Company display name. */
    title: 'h1, h2',
  },
} as const;

/**
 * Assert that a required selector matched at least one element.
 *
 * @param what - Human description of what was being extracted, e.g. `"market-watch rows"`.
 * @param selector - The selector that was tried.
 * @param matches - How many elements matched.
 * @param url - The source URL, for the error message.
 * @throws {@link PsxSchemaError} when nothing matched.
 */
export function assertMatched(
  what: string,
  selector: string,
  matches: number,
  url: string,
): void {
  if (matches === 0) {
    throw new PsxSchemaError(
      `expected ${what} via selector \`${selector}\`, found 0 elements`,
      { url, selectorVersion: SELECTOR_VERSION },
    );
  }
}

/**
 * Assert that an observed header row matches the expected headers exactly.
 *
 * This is the check that would have caught the August 2022 `TIME` -> `Date`
 * rename. On mismatch it reports the exact difference.
 *
 * @throws {@link PsxSchemaError} when the header sets differ.
 */
export function assertHeaders(
  expected: readonly string[],
  actual: readonly string[],
  url: string,
): void {
  const expectedNorm = expected.map((h) => h.trim().toUpperCase());
  const actualNorm = actual.map((h) => h.trim().toUpperCase());

  const missing = expectedNorm.filter((h) => !actualNorm.includes(h));
  const unexpected = actualNorm.filter((h) => !expectedNorm.includes(h));

  if (missing.length === 0 && unexpected.length === 0) {
    return;
  }

  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing ${JSON.stringify(missing)}`);
  if (unexpected.length > 0) parts.push(`unexpected ${JSON.stringify(unexpected)}`);

  throw new PsxSchemaError(
    `column headers changed: ${parts.join('; ')}. ` +
      `Expected [${expectedNorm.join(', ')}] but found [${actualNorm.join(', ')}]. ` +
      `If PSX changed its markup, update SELECTORS and bump SELECTOR_VERSION.`,
    {
      url,
      selectorVersion: SELECTOR_VERSION,
      actual: actualNorm.join(', '),
    },
  );
}
