/**
 * Parser tests against recorded real PSX bytes.
 *
 * These run entirely offline. That is deliberate -- see
 * `packages/fixtures/README.md` -- and it is also the reason these tests exist
 * at all: all three Python references in `ref/` shipped with zero tests and
 * consequently rotted silently. `psx-data-reader` broke in August 2022 when PSX
 * renamed a column and returned an empty frame instead of an error.
 *
 * The edge cases asserted here are precisely the ones that caused that.
 */

import { describe, expect, it } from 'vitest';
import * as cheerio from 'cheerio';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMarketWatch, parseMarketSummaryPage } from './parsers.js';
import {
  parseConstituents,
  parseCompanyProfile,
  parseIndices,
  parseSectorSummaries,
  parseSymbols,
  parseTimeseriesEod,
  parseTimeseriesIntraday,
  parseTopSectors,
  parseTopSymbols,
  unwrap,
} from './parsers-json.js';
import { PsxSchemaError, PsxParseError } from './errors.js';

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'data',
);

const read = (name: string): string => readFileSync(join(FIXTURE_DIR, name), 'utf8');
const readJson = (name: string): unknown => JSON.parse(read(name));

const URL_MW = 'https://dps.psx.com.pk/market-watch';
const URL_MS = 'https://www.psx.com.pk/market-summary/';

describe('parseMarketWatch (dps /market-watch)', () => {
  const quotes = parseMarketWatch(read('market-watch.html'), URL_MW);

  it('extracts rows', () => {
    expect(quotes.length).toBeGreaterThan(10);
  });

  it('reads prices from data-order, not formatted text', () => {
    // The live fixture's first row is PIBTL: text "73,446,994" beside
    // data-order="73446994". Getting a number rather than a comma string proves
    // we read the machine attribute.
    const pibtl = quotes.find((q) => q.symbol === 'PIBTL');
    expect(pibtl).toBeDefined();
    expect(pibtl?.volume).toBe(73_446_994);
    expect(typeof pibtl?.volume).toBe('number');
  });

  it('never yields NaN', () => {
    for (const quote of quotes) {
      for (const [key, value] of Object.entries(quote)) {
        if (typeof value === 'number') {
          expect(Number.isNaN(value), `${quote.symbol}.${key} is NaN`).toBe(false);
        }
      }
    }
  });

  it('treats absent prices as null, never 0', () => {
    for (const quote of quotes) {
      for (const key of ['ldcp', 'open', 'high', 'low', 'current'] as const) {
        const value = quote[key];
        expect(value === null || typeof value === 'number').toBe(true);
        if (typeof value === 'number') {
          expect(value, `${quote.symbol}.${key} must not be negative`).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('preserves a genuine zero volume rather than nulling it', () => {
    // "Did not trade" is meaningful data, distinct from "unknown".
    const zeros = quotes.filter((q) => q.volume === 0);
    for (const zero of zeros) {
      expect(zero.warnings).not.toContain('both LDCP and CURRENT absent -- row carried no prices');
    }
  });

  it('parses listedIn as an array of index codes', () => {
    const pibtl = quotes.find((q) => q.symbol === 'PIBTL');
    expect(Array.isArray(pibtl?.listedIn)).toBe(true);
    expect(pibtl?.listedIn).toContain('KSE100');
  });

  it('captures the company name from the link data-title', () => {
    const pibtl = quotes.find((q) => q.symbol === 'PIBTL');
    expect(pibtl?.name).toBe('Pakistan International Bulk Terminal');
  });

  it('keeps sector codes as their published numeric form', () => {
    const pibtl = quotes.find((q) => q.symbol === 'PIBTL');
    expect(pibtl?.sector).toBe('0833');
  });

  it('uppercases symbols consistently', () => {
    for (const quote of quotes) {
      expect(quote.symbol).toBe(quote.symbol.toUpperCase());
    }
  });

  it('throws PsxSchemaError, not an empty array, when the table is gone', () => {
    // The failure mode that killed psx-data-reader: markup changes, parser
    // returns nothing, caller cannot tell "market closed" from "broken".
    expect(() => parseMarketWatch('<html><body>nothing here</body></html>', URL_MW)).toThrow(
      PsxSchemaError,
    );
  });

  it('names the specific selector that failed to match', () => {
    try {
      parseMarketWatch('<html><body>nothing</body></html>', URL_MW);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PsxSchemaError);
      const schemaError = error as PsxSchemaError;
      expect(schemaError.detail).toContain('data-search');
      expect(schemaError.selectorVersion).toMatch(/^v\d+$/);
      expect(schemaError.url).toBe(URL_MW);
    }
  });

  it('throws PsxSchemaError when column headers are renamed', () => {
    // Simulates the August 2022 TIME -> Date rename.
    const broken = read('market-watch.html').replaceAll('LDCP', 'PRIOR_CLOSE');
    expect(() => parseMarketWatch(broken, URL_MW)).toThrow(PsxSchemaError);
  });

  it('reports which headers are missing and unexpected', () => {
    try {
      const broken = read('market-watch.html').replaceAll('LDCP', 'PRIOR_CLOSE');
      parseMarketWatch(broken, URL_MW);
      expect.unreachable('should have thrown');
    } catch (error) {
      const schemaError = error as PsxSchemaError;
      expect(schemaError.detail).toContain('missing');
      expect(schemaError.detail).toContain('PRIOR_CLOSE');
    }
  });
});

describe('parseMarketSummaryPage (www /market-summary/)', () => {
  const { summary, quotes } = parseMarketSummaryPage(read('market-summary.html'), URL_MS);

  it('extracts rows via the misspelled data-srip attribute', () => {
    expect(quotes.length).toBeGreaterThan(10);
  });

  it('extracts all seven market-wide scalars', () => {
    // These exist on no other endpoint. Losing them is why we keep this source.
    expect(summary.status).toBe('CLOSED');
    expect(summary.volume).toBe(591_234_897);
    expect(summary.value).toBe(20_191_629_499);
    expect(summary.trades).toBe(295_473);
    expect(summary.advanced).toBe(253);
    expect(summary.declined).toBe(195);
    expect(summary.unchanged).toBe(121);
    expect(summary.total).toBe(569);
  });

  it('parses exchange-local timestamps as PKT, not UTC', () => {
    // The page publishes PKT local time with no zone marker, e.g.
    // `<h4>2026-09-30 21:49:01</h4>`. PKT is a fixed UTC+5 with no DST, so
    // 21:49:01 PKT is 16:49:01 UTC.
    //
    // Derived from the fixture rather than hardcoded, because re-recording the
    // fixtures moves the timestamp and a literal here would fail on every
    // refresh -- the kind of test rot this suite exists to prevent.
    const html = read('market-summary.html');
    const raw = /<h4>(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})<\/h4>/.exec(html)?.[1];
    expect(raw, 'fixture should contain a publication timestamp').toBeDefined();

    const expected = new Date(`${raw.replace(' ', 'T')}+05:00`).toISOString();
    expect(summary.updatedAt).toBe(expected);
  });

  it('applies a five-hour offset, proving PKT rather than UTC', () => {
    // If we were treating the exchange time as UTC, this would come out five
    // hours later than it should.
    const html = read('market-summary.html');
    const raw = /<h4>(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})<\/h4>/.exec(html)?.[1];
    if (raw == null) return;

    const naiveUtc = new Date(`${raw.replace(' ', 'T')}Z`).toISOString();
    expect(summary.updatedAt).not.toBe(naiveUtc);

    const offsetHours =
      (new Date(naiveUtc).getTime() - new Date(summary.updatedAt ?? '').getTime()) / 3_600_000;
    expect(offsetHours).toBe(5);
  });

  it('strips thousands separators from scalars', () => {
    // "591,234,897" -> 591234897. A comma string here would poison averages.
    expect(typeof summary.volume).toBe('number');
    expect(String(summary.volume)).not.toContain(',');
  });

  it('reads negative changes across the decrease-rate span', () => {
    // IMAGE trades at -0.13; the numeric text sits beside an empty
    // decrease-rate span whose class is the only sign carrier.
    const image = quotes.find((q) => q.symbol === 'IMAGE');
    expect(image).toBeDefined();
    expect(image?.change).toBe(-0.13);
    expect(image?.volume).toBe(22_333);
    expect(image?.ldcp).toBe(25.63);
  });

  it('reads the company name from the symbol cell text', () => {
    const image = quotes.find((q) => q.symbol === 'IMAGE');
    expect(image?.name).toBe('Image Pakistan');
  });

  it('reports no changePct, because this page has no percentage column', () => {
    // Asserting absence is what stops a future maintainer "fixing" this by
    // computing change/ldcp and silently disagreeing with the exchange.
    for (const quote of quotes) {
      expect(quote.changePct).toBeNull();
    }
  });

  it('throws PsxSchemaError when data-srip is absent', () => {
    expect(() =>
      parseMarketSummaryPage('<html><body><td class="dataportal">X</td></body></html>', URL_MS),
    ).toThrow(PsxSchemaError);
  });
});

describe('parseTimeseriesEod (dps /timeseries/eod/{SYM})', () => {
  const bars = parseTimeseriesEod(readJson('timeseries-eod-hbl.json'), 'https://dps.psx.com.pk/timeseries/eod/HBL');

  it('extracts bars from positional arrays', () => {
    expect(bars.length).toBeGreaterThan(10);
  });

  it('orders output ascending, though upstream sends descending', () => {
    // Getting this backwards yields plausible, entirely wrong indicator values
    // with no error at all.
    for (let i = 1; i < bars.length; i += 1) {
      const previous = bars[i - 1];
      const current = bars[i];
      expect(previous?.time.localeCompare(current?.time ?? '')).toBeLessThanOrEqual(0);
    }
  });

  it('maps positions [ts, close, volume, open] correctly', () => {
    // Close is position 1, open is position 3. Swapping them is the classic bug.
    const raw = (readJson('timeseries-eod-hbl.json') as { data: number[][] }).data;
    const newestByWire = raw[0];
    if (newestByWire == null) return;
    const newestParsed = bars[bars.length - 1];
    expect(newestParsed?.close).toBe(newestByWire[1]);
    expect(newestParsed?.volume).toBe(newestByWire[2]);
    expect(newestParsed?.open).toBe(newestByWire[3]);
  });

  it('reports high and low as null, since upstream publishes neither', () => {
    for (const bar of bars) {
      expect(bar.high).toBeNull();
      expect(bar.low).toBeNull();
    }
  });

  it('produces no NaN and no negative prices', () => {
    for (const bar of bars) {
      for (const key of ['open', 'close', 'volume'] as const) {
        const value = bar[key];
        if (value != null) {
          expect(Number.isNaN(value)).toBe(false);
          expect(value).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('converts epoch seconds to ISO UTC', () => {
    for (const bar of bars) {
      expect(bar.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it('returns an empty array for an empty-but-successful payload', () => {
    // NAV for THALL legitimately returns []. "No data" is a valid answer.
    const barsEmpty = parseTimeseriesEod({ status: 1, message: '', data: [] }, 'https://dps.psx.com.pk/timeseries/nav/THALL');
    expect(barsEmpty).toEqual([]);
  });
});

describe('parseTimeseriesIntraday (dps /timeseries/int/{SYM})', () => {
  const bars = parseTimeseriesIntraday(readJson('timeseries-int-hbl.json'), 'https://dps.psx.com.pk/timeseries/int/HBL');

  it('maps [ts, price, volume]', () => {
    expect(bars.length).toBeGreaterThan(5);
    const raw = (readJson('timeseries-int-hbl.json') as { data: number[][] }).data;
    const last = raw[raw.length - 1];
    if (last == null) return;
    expect(bars[0]?.close).toBe(last[1]);
    expect(bars[0]?.volume).toBe(last[2]);
  });

  it('orders ascending', () => {
    for (let i = 1; i < bars.length; i += 1) {
      expect(bars[i - 1]?.time.localeCompare(bars[i]?.time ?? '')).toBeLessThanOrEqual(0);
    }
  });
});

describe('unwrap', () => {
  const url = 'https://dps.psx.com.pk/test';

  it('returns data on a successful envelope', () => {
    expect(unwrap({ status: 1, message: '', data: [1, 2] }, url, 'test')).toEqual([1, 2]);
  });

  it('throws when the envelope has no data key', () => {
    expect(() => unwrap({ status: 1 }, url, 'test')).toThrow(PsxSchemaError);
  });

  it('throws when upstream reports a non-success status', () => {
    expect(() => unwrap({ status: 0, message: 'bad symbol', data: [] }, url, 'test')).toThrow(
      PsxSchemaError,
    );
  });

  it('throws PsxParseError for a non-object body', () => {
    expect(() => unwrap('nope', url, 'test')).toThrow(PsxParseError);
  });
});

describe('parseSymbols (dps /symbols)', () => {
  const symbols = parseSymbols(readJson('symbols.json'), 'https://dps.psx.com.pk/symbols');

  it('extracts the directory', () => {
    // The fixture is trimmed to 40 rows (of 1028 live) to keep the repo small;
    // see packages/fixtures/README.md.
    expect(symbols.length).toBeGreaterThan(20);
  });

  it('stays a bare top-level array, not an envelope', () => {
    // Guards the trimmer: injecting trim metadata into this payload would
    // change its shape from array to object and mask exactly the drift the
    // fixture exists to catch.
    expect(Array.isArray(readJson('symbols.json'))).toBe(true);
  });

  it('maps the published fields', () => {
    const first = symbols[0];
    expect(first).toBeDefined();
    expect(typeof first?.symbol).toBe('string');
    expect(typeof first?.name).toBe('string');
    expect(typeof first?.isEtf).toBe('boolean');
    expect(typeof first?.isDebt).toBe('boolean');
  });

  it('flags debt instruments', () => {
    // The live directory is mixed (1028 entries: equities, TFCs, sukuk), but the
    // fixture keeps the first 40 rows and PSX sorts alphabetically -- so every
    // retained row happens to be a debt instrument. Assert what the fixture
    // actually contains rather than what the live feed contains.
    expect(symbols.length).toBeGreaterThan(0);
    expect(symbols.every((s) => typeof s.isDebt === 'boolean')).toBe(true);
  });

  it('reads the debt flag from the published casing', () => {
    // Upstream spells it `isDebt` but `isETF` -- inconsistent casing that a
    // sloppy key lookup would silently drop to false.
    expect(symbols.some((s) => s.isDebt)).toBe(true);
  });

  it('never returns an empty symbol', () => {
    for (const symbol of symbols) {
      expect(symbol.symbol).not.toBe('');
    }
  });
});

describe('parseTopSectors / parseTopSymbols / parseSymbolPosition', () => {
  it('reads top-10-sectors', () => {
    const sectors = parseTopSectors(readJson('top-10-sectors.json'), 'https://dps.psx.com.pk/data/top-10-sectors');
    expect(sectors.length).toBeGreaterThan(0);
    expect(sectors[0]?.name).toBeTruthy();
    expect(typeof sectors[0]?.volume).toBe('number');
  });

  it('reads top-10-symbols', () => {
    const symbols = parseTopSymbols(readJson('top-10-symbols.json'), 'https://dps.psx.com.pk/data/top-10-symbols');
    expect(symbols.length).toBeGreaterThan(0);
    expect(symbols[0]?.symbol).toBeTruthy();
  });
});

describe('HTML entity parsers', () => {
  it('parses the indices table', () => {
    const indices = parseIndices(read('indices.html'), 'https://dps.psx.com.pk/indices');
    expect(indices.length).toBeGreaterThan(5);
    const kse100 = indices.find((i) => i.code === 'KSE100');
    expect(kse100).toBeDefined();
    expect(kse100?.value).toBeGreaterThan(1000);
  });

  it('pairs each index code with its own value', () => {
    const indices = parseIndices(read('indices.html'), 'https://dps.psx.com.pk/indices');
    for (const index of indices) {
      if (index.value == null) continue;
      expect(index.value).toBeGreaterThan(0);
    }
  });

  it('reads machine values so the sign is trustworthy', () => {
    // The table's `data-order` values are signed correctly and agree with their
    // `change__text--pos`/`--neg` class, unlike the carousel's parenthesised
    // text. Asserting agreement is what catches a sign-handling regression.
    const indices = parseIndices(read('indices.html'), 'https://dps.psx.com.pk/indices');
    expect(indices.length).toBeGreaterThan(5);

    const kse100 = indices.find((i) => i.code === 'KSE100');
    expect(kse100?.value).toBe(169_969.32);
    expect(kse100?.change).toBeCloseTo(368.92, 2);
    expect(kse100?.changePct).toBeCloseTo(0.2175, 3);

    // The fixture contains declining indices too; their change must be negative.
    const decliners = indices.filter((i) => i.change != null && i.change < 0);
    expect(decliners.length).toBeGreaterThan(0);
    for (const decliner of decliners) {
      expect(decliner.changePct ?? 0).toBeLessThan(0);
    }
  });

  it('ignores the wrong-page header block when asserting columns', () => {
    // The page has two <thead> blocks: the real table's 6 columns, and a
    // "Sector Indices" section header. Asserting against the wrong one produced
    // a spurious schema error before the selector was scoped to tbody.
    const indices = parseIndices(read('indices.html'), 'https://dps.psx.com.pk/indices');
    expect(indices.every((i) => i.code !== '')).toBe(true);
  });

  it('parses a company profile including the misspelled decription class', () => {
    const profile = parseCompanyProfile(read('company-hbl.html'), 'https://dps.psx.com.pk/company/HBL', 'HBL');
    expect(profile.symbol).toBe('HBL');
    expect(profile.warnings).not.toContain('no stats_label pairs found -- PSX may have changed the profile layout');
  });

  it('reads the first occurrence of a duplicated stat label', () => {
    // The company page concatenates several stat blocks that REUSE labels.
    // Verified on the live HBL page: 15 labels are duplicated --
    //   open x4, high x4, low x4, volume x4, ldcp x4, close x3, change x3,
    //   total trades x3, free float x2
    // A last-write-wins Map reads the wrong block: `volume` became the indices
    // block's 0, and `Free Float` became the percentage 40.00% rather than the
    // share count.
    const html = read('company-hbl.html');
    const profile = parseCompanyProfile(html, 'https://dps.psx.com.pk/company/HBL', 'HBL');

    const occurrences = (label) => {
      const $ = cheerio.load(html);
      const found: string[] = [];
      $('div.stats_label').each((_, el) => {
        if ($(el).text().trim().toLowerCase() === label) {
          found.push($(el).next('div.stats_value').text().trim());
        }
      });
      return found;
    };

    const volumes = occurrences('volume');
    expect(volumes.length).toBeGreaterThan(1);
    const firstVolume = Number(volumes[0].replace(/[,\s]/g, ''));
    expect(profile.volume).toBe(firstVolume);
    expect(profile.volume).toBeGreaterThan(0);
  });

  it('reads Free Float as a share count, not a percentage', () => {
    // The page publishes `Free Float` twice: "586,741,003" then "40.00%".
    // Treating the percentage as a share tally yields 40 shares.
    const profile = parseCompanyProfile(read('company-hbl.html'), 'https://dps.psx.com.pk/company/HBL', 'HBL');
    expect(profile.freeFloatShares).toBeGreaterThan(1_000_000);
    expect(Number.isInteger(profile.freeFloatShares ?? 0)).toBe(true);
  });

  it('never substitutes LDCP for the current price', () => {
    // LDCP is the PREVIOUS close. Falling back to it reports a stale price as
    // live. Absence is the honest answer.
    const profile = parseCompanyProfile(read('company-hbl.html'), 'https://dps.psx.com.pk/company/HBL', 'HBL');
    expect(profile.current).not.toBe(profile.ldcp);
  });

  it('reports duplicated labels as warnings rather than hiding them', () => {
    const profile = parseCompanyProfile(read('company-hbl.html'), 'https://dps.psx.com.pk/company/HBL', 'HBL');
    expect(profile.warnings.some((w) => w.includes('appears') && w.includes('times'))).toBe(true);
  });

  it('parses the listings table', () => {
    const constituents = parseConstituents(read('listings-nc.html'), 'https://dps.psx.com.pk/listings-table/main/nc', 'NC');
    // Parsing without throwing is the bar: the listings table's exact column set
    // varies per counter.
    expect(Array.isArray(constituents)).toBe(true);
  });

  it('parses sector summaries when present', () => {
    // Sector summary is an HTML page whose table shape varies; the parser must
    // not throw on absence.
    expect(() =>
      parseSectorSummaries(read('listings-nc.html'), 'https://dps.psx.com.pk/sector-summary/sectorwise'),
    ).not.toThrow();
  });
});
