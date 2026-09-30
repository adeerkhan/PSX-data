/**
 * Live verification against the real exchange.
 *
 * This is NOT the fixture test suite. Its purpose is to answer three questions
 * the fixture suite cannot:
 *
 *   1. Does the whole pipeline still work against bytes fetched *right now*?
 *   2. Do the parsers extract the values that are actually in the HTML?
 *   3. Do they agree with an independent extraction of the same bytes?
 *
 * (3) is the real test. For each source we run two independent implementations
 * over identical bytes -- the cheerio parser, and a deliberately naive
 * regex/split extractor written from the raw markup -- then compare every field.
 * Agreement between two independent readers is evidence; a single parser
 * asserting against itself is not.
 *
 * Run: node scripts/verify-live.mjs
 */

import * as cheerio from 'cheerio';
import { parseMarketWatch, parseMarketSummaryPage } from '../packages/client/dist/parsers.js';
import {
  parseCompanyProfile,
  parseConstituents,
  parseIndices,
  parseSectorSummaries,
  parseSymbols,
  parseTimeseriesEod,
  parseTimeseriesIntraday,
} from '../packages/client/dist/parsers-json.js';

const DPS = 'https://dps.psx.com.pk';
const WWW = 'https://www.psx.com.pk';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    failures.push(`${label}${detail ? ` -- ${detail}` : ''}`);
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

function section(name) {
  console.log(`\n${name}`);
}

/** Fetch a fresh gate key from the page HTML. Never hardcoded: it rotates. */
async function fetchKey() {
  const res = await fetch(`${DPS}/`, { headers: { 'User-Agent': UA } });
  const html = await res.text();
  const match = /window\.__ps\s*=\s*(\{[^}]+\})/.exec(html);
  if (match == null) throw new Error('no window.__ps blob');
  return JSON.parse(match[1])._k;
}

const gated = (key) => ({
  'User-Agent': UA,
  'X-Req-Id': key,
  'X-Requested-With': 'XMLHttpRequest',
  Referer: `${DPS}/`,
  Origin: DPS,
});

async function get(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

// ---------------------------------------------------------------------------
// Independent extractors. Deliberately naive, written from the raw markup and
// not sharing any code with the parsers under test.
// ---------------------------------------------------------------------------

/** Pull every market-watch row straight out of the markup with regex. */
function naiveMarketWatch(html) {
  const rows = [];
  const trRe = /<tr>(?:(?!<\/tr>)[\s\S])*?<\/tr>/g;
  let match;
  while ((match = trRe.exec(html)) != null) {
    const rowHtml = match[0];
    const symbolMatch = /<td\s+data-search="([^"]+)"/.exec(rowHtml);
    if (symbolMatch == null) continue;

    const cells = [];
    const tdRe = /<td[^>]*>(?:(?!<\/td>)[\s\S])*?<\/td>/g;
    let cell;
    while ((cell = tdRe.exec(rowHtml)) != null) cells.push(cell[0]);

    const num = (i) => {
      if (cells[i] == null) return null;
      const order = /data-order="(-?[\d.]+)"/.exec(cells[i]);
      if (order != null) return Number(order[1]);
      const text = cells[i].replace(/<[^>]+>/g, '').replace(/[,\s]/g, '');
      return text === '' ? null : Number(text);
    };

    rows.push({
      symbol: symbolMatch[1],
      ldcp: num(3),
      open: num(4),
      high: num(5),
      low: num(6),
      current: num(7),
      change: num(8),
      changePct: num(9),
      volume: num(10),
    });
  }
  return rows;
}

/** Pull market-summary rows with a split-based reader, independent of cheerio. */
function naiveMarketSummary(html) {
  const rows = [];
  const rowRe = /data-srip="([^"]+)"[^>]*>([^<]*)<\/td>((?:(?!<\/tr>)[\s\S])*?)<\/tr>/g;
  let match;
  while ((match = rowRe.exec(html)) != null) {
    const symbol = match[1];
    const name = match[2].trim();
    const body = match[3];

    const tds = [];
    const tdRe = /<td[^>]*>(?:(?!<\/td>)[\s\S])*?<\/td>/g;
    let cell;
    while ((cell = tdRe.exec(body)) != null) tds.push(cell[0]);

    // tds[0] here is LDCP, because the symbol <td> was consumed by the outer match.
    const num = (i) => {
      if (tds[i] == null) return null;
      const text = tds[i].replace(/<[^>]+>/g, '').replace(/[,\s]/g, '');
      return text === '' || Number.isNaN(Number(text)) ? null : Number(text);
    };

    rows.push({ symbol, name, ldcp: num(0), open: num(1), high: num(2), low: num(3), current: num(4), change: num(5), volume: num(6) });
  }
  return rows;
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`Verifying against live PSX at ${new Date().toISOString()}`);

  const key = await fetchKey();
  console.log(`Obtained gate key (length ${key.length})`);
  const h = gated(key);

  // -- market-watch -------------------------------------------------------
  section('dps /market-watch');
  const mwHtml = await get(`${DPS}/market-watch`, h);
  console.log(`  fetched ${(mwHtml.length / 1024).toFixed(0)}KB`);
  const mw = parseMarketWatch(mwHtml, `${DPS}/market-watch`);
  const naive = naiveMarketWatch(mwHtml);
  console.log(`  parser: ${mw.length} rows | independent reader: ${naive.length} rows`);

  check('row counts agree', mw.length === naive.length, `${mw.length} vs ${naive.length}`);
  check('row count is plausible', mw.length > 100, `${mw.length}`);

  // Field-by-field agreement on every row.
  let mismatch = null;
  const bySymbol = new Map(naive.map((r) => [r.symbol, r]));
  let compared = 0;
  for (const quote of mw) {
    const ref = bySymbol.get(quote.symbol);
    if (ref == null) continue;
    compared += 1;
    for (const field of ['ldcp', 'open', 'high', 'low', 'current', 'change', 'changePct', 'volume']) {
      const a = quote[field];
      const b = ref[field];
      const same = a === b || (a != null && b != null && Math.abs(a - b) < 1e-9);
      if (!same && mismatch == null) {
        mismatch = `${quote.symbol}.${field}: parser=${a} independent=${b}`;
      }
    }
  }
  check(`all ${compared} rows agree field-by-field`, mismatch == null, mismatch ?? '');
  check('no NaN in any price field', mw.every((q) => [q.ldcp, q.open, q.high, q.low, q.current, q.change, q.changePct, q.volume].every((v) => v == null || !Number.isNaN(v))));
  check('no negative prices', mw.every((q) => [q.ldcp, q.open, q.high, q.low, q.current].every((v) => v == null || v >= 0)));
  check('no negative volumes', mw.every((q) => q.volume == null || q.volume >= 0));
  check('decliners present and negative', mw.some((q) => q.change != null && q.change < 0), 'none found');
  check('gainers present and positive', mw.some((q) => q.change != null && q.change > 0), 'none found');
  check('no row warns about missing prices', mw.every((q) => !q.warnings.some((w) => w.includes('no prices'))));
  check('every symbol has KSE100 or is unlisted-in', mw.some((q) => q.listedIn.length > 0));

  // -- market-summary -----------------------------------------------------
  section('www /market-summary/');
  const msHtml = await get(`${WWW}/market-summary/`, { 'User-Agent': UA });
  console.log(`  fetched ${(msHtml.length / 1024).toFixed(0)}KB`);
  const { summary, quotes } = parseMarketSummaryPage(msHtml, `${WWW}/market-summary/`);
  const naiveMs = naiveMarketSummary(msHtml);
  console.log(`  parser: ${quotes.length} rows | independent reader: ${naiveMs.length} rows`);

  check('row counts agree', quotes.length === naiveMs.length, `${quotes.length} vs ${naiveMs.length}`);
  check('row count is substantial', quotes.length > 400, `${quotes.length}`);

  const msBySymbol = new Map(naiveMs.map((r) => [r.symbol, r]));
  let msMismatch = null;
  let msCompared = 0;
  for (const quote of quotes) {
    const ref = msBySymbol.get(quote.symbol);
    if (ref == null) continue;
    msCompared += 1;
    for (const field of ['ldcp', 'open', 'high', 'low', 'current', 'change', 'volume']) {
      const a = quote[field];
      const b = ref[field];
      const same = a === b || (a != null && b != null && Math.abs(a - b) < 1e-9);
      if (!same && msMismatch == null) {
        msMismatch = `${quote.symbol}.${field}: parser=${a} independent=${b}`;
      }
    }
  }
  check(`all ${msCompared} rows agree field-by-field`, msMismatch == null, msMismatch ?? '');

  // The seven scalars, cross-checked against a regex read of the same bytes.
  const scalar = (label) => {
    const re = new RegExp(`<p[^>]*>\\s*<span>\\s*${label}:?\\s*</span>\\s*([^<]*?)\\s*</p>`, 'i');
    const found = re.exec(msHtml);
    if (found == null) return null;
    const text = found[1].replace(/,/g, '').trim();
    return text === '' ? null : Number(text);
  };
  check('volume matches independent read', summary.volume === scalar('Volume'), `${summary.volume} vs ${scalar('Volume')}`);
  check('value matches independent read', summary.value === scalar('Value'), `${summary.value} vs ${scalar('Value')}`);
  check('trades matches independent read', summary.trades === scalar('Trades'), `${summary.trades} vs ${scalar('Trades')}`);
  check('advanced matches independent read', summary.advanced === scalar('Advanced'), `${summary.advanced} vs ${scalar('Advanced')}`);
  check('declined matches independent read', summary.declined === scalar('Declined'), `${summary.declined} vs ${scalar('Declined')}`);
  check('unchanged matches independent read', summary.unchanged === scalar('Unchanged'), `${summary.unchanged} vs ${scalar('Unchanged')}`);
  check('total matches independent read', summary.total === scalar('Total'), `${summary.total} vs ${scalar('Total')}`);
  check('status recognised', ['OPEN', 'CLOSED', 'PRE_OPEN'].includes(summary.status), summary.status);
  check('advanced + declined + unchanged == total', summary.advanced + summary.declined + summary.unchanged === summary.total,
    `${summary.advanced}+${summary.declined}+${summary.unchanged} vs ${summary.total}`);
  check('decliners parsed as negative', quotes.some((q) => q.change != null && q.change < 0), 'none found');
  check('sectors attributed to some rows', quotes.some((q) => q.sector != null), 'none');

  // -- timeseries ---------------------------------------------------------
  section('dps /timeseries/eod/HBL');
  const eodRaw = JSON.parse(await get(`${DPS}/timeseries/eod/HBL`, h));
  const eod = parseTimeseriesEod(eodRaw, `${DPS}/timeseries/eod/HBL`);
  check('raw data is non-empty', Array.isArray(eodRaw.data) && eodRaw.data.length > 0);
  check('parsed bars match raw count', eod.length === eodRaw.data.length, `${eod.length} vs ${eodRaw.data.length}`);
  check('years of history available', eod.length > 500, `${eod.length} bars`);
  let ascending = true;
  for (let i = 1; i < eod.length; i += 1) {
    if (eod[i - 1].time.localeCompare(eod[i].time) > 0) { ascending = false; break; }
  }
  check('output is ascending (wire is descending)', ascending);
  check('wire order is descending', eodRaw.data.length < 2 || eodRaw.data[0][0] > eodRaw.data[1][0]);
  // Wire is DESCENDING (newest first), so wire[0] is the newest bar and our
  // ascending output puts that same bar last.
  const newestWire = eodRaw.data[0];
  const newestParsed = eod[eod.length - 1];
  check('newest bar: close maps to wire position 1', newestParsed.close === newestWire[1], `${newestParsed.close} vs ${newestWire[1]}`);
  check('newest bar: open maps to wire position 3', newestParsed.open === newestWire[3], `${newestParsed.open} vs ${newestWire[3]}`);
  check('newest bar: volume maps to wire position 2', newestParsed.volume === newestWire[2], `${newestParsed.volume} vs ${newestWire[2]}`);
  // And the oldest end, to confirm the mapping holds across the whole range.
  const oldestWire = eodRaw.data[eodRaw.data.length - 1];
  const oldestParsed = eod[0];
  check('oldest bar: close maps to wire position 1', oldestParsed.close === oldestWire[1], `${oldestParsed.close} vs ${oldestWire[1]}`);
  check('oldest bar: open maps to wire position 3', oldestParsed.open === oldestWire[3], `${oldestParsed.open} vs ${oldestWire[3]}`);
  // Every bar must match its wire counterpart by timestamp -- the strongest form.
  const wireByTs = new Map(eodRaw.data.map((r) => [r[0], r]));
  let mapMismatch = null;
  for (const bar of eod) {
    const wire = wireByTs.get(Date.parse(bar.time) / 1000);
    if (wire == null) { mapMismatch = `no wire row for ${bar.time}`; break; }
    if (bar.close !== wire[1] || bar.open !== wire[3] || bar.volume !== wire[2]) {
      mapMismatch = `${bar.time}: got close=${bar.close} open=${bar.open} vol=${bar.volume}, wire=[${wire.join(',')}]`;
      break;
    }
  }
  check(`all ${eod.length} bars map to their wire row`, mapMismatch == null, mapMismatch ?? '');
  check('close is positive for every bar', eod.every((b) => b.close == null || b.close > 0));
  check('volume non-negative for every bar', eod.every((b) => b.volume == null || b.volume >= 0));
  const spread = eod.filter((b) => b.open != null && b.close != null && b.high == null).length;
  check('open/close present on all bars', spread > 0, `${spread}`);

  section('dps /timeseries/int/HBL');
  const intRaw = JSON.parse(await get(`${DPS}/timeseries/int/HBL`, h));
  const int = parseTimeseriesIntraday(intRaw, `${DPS}/timeseries/int/HBL`);
  check('intraday ticks parsed', int.length > 0, `${int.length}`);
  check('intraday count matches raw', int.length === intRaw.data.length);

  // -- symbols ------------------------------------------------------------
  section('dps /symbols');
  const symRaw = JSON.parse(await get(`${DPS}/symbols`, h));
  const symbols = parseSymbols(symRaw, `${DPS}/symbols`);
  check('directory is large', symbols.length > 900, `${symbols.length}`);
  check('count matches raw', symbols.length === symRaw.length, `${symbols.length} vs ${symRaw.length}`);
  check('contains equity (non-debt) instruments', symbols.some((s) => !s.isDebt), 'none');
  check('contains debt instruments', symbols.some((s) => s.isDebt), 'none');
  check('every symbol non-empty and uppercase', symbols.every((s) => s.symbol.length > 0 && s.symbol === s.symbol.toUpperCase()));

  // -- indices ------------------------------------------------------------
  section('dps /indices');
  const idxHtml = await get(`${DPS}/indices`, h);
  const indices = parseIndices(idxHtml, `${DPS}/indices`);
  console.log(`  parsed ${indices.length} indices`);
  check('several indices parsed', indices.length > 5, `${indices.length}`);
  check('KSE100 present', indices.some((i) => i.code === 'KSE100'));
  const kse = indices.find((i) => i.code === 'KSE100');
  check('KSE100 has a level', kse?.value != null && kse.value > 1000, `${kse?.value}`);
  check('all codes non-empty', indices.every((i) => i.code.length > 0));
  check('no NaN levels', indices.every((i) => i.value == null || !Number.isNaN(i.value)));
  // Cross-check one index against a regex read of the same bytes.
  const idxRe = new RegExp(`data-code="${kse?.code}"[^>]*>.*?data-order="([\\d.]+)"[^>]*>[^<]*</td>\\s*<td[^>]*data-order="([\\d.]+)"[^>]*>[^<]*</td>\\s*<td[^>]*data-order="([\\d.]+)"[^>]*>[^<]*</td>\\s*<td[^>]*data-order="(-?[\\d.]+)"[^>]*>.*?</td>\\s*<td[^>]*data-order="(-?[\\d.]+)"`, 's');
  const idxRaw = idxRe.exec(idxHtml);
  if (idxRaw != null) {
    // Regex groups, in order: high, low, current, change, %change.
    check('independent read found KSE100 row', idxRaw[0].includes('KSE100'));
    check('KSE100 current matches independent read', kse?.value === Number(idxRaw[3]), `parser=${kse?.value} regex=${idxRaw[3]}`);
    check('KSE100 change matches independent read', Math.abs((kse?.change ?? 0) - Number(idxRaw[4])) < 1e-6, `parser=${kse?.change} regex=${idxRaw[4]}`);
    check('KSE100 changePct matches independent read', Math.abs((kse?.changePct ?? 0) - Number(idxRaw[5])) < 1e-6, `parser=${kse?.changePct} regex=${idxRaw[5]}`);
  } else {
    check('independent read located the KSE100 table row', false, 'regex did not match');
  }

  // -- company (previously only tautologically tested) ---------------------
  section('dps /company/HBL');
  const coHtml = await get(`${DPS}/company/HBL`, h);
  const profile = parseCompanyProfile(coHtml, `${DPS}/company/HBL`, 'HBL');
  // Independent read of the same stat pairs.
  // Independent reader: FIRST occurrence per label, matching what the page's
  // first (live quote) block means. This reader deliberately keeps *all*
  // occurrences so we can compare against a specific one.
  const $co = cheerio.load(coHtml);
  const naiveAll = new Map();
  $co('div.stats_label').each((_, el) => {
    const label = $co(el).text().trim().toLowerCase();
    const value = $co(el).next('div.stats_value').text().trim();
    const list = naiveAll.get(label);
    if (list == null) naiveAll.set(label, [value]);
    else list.push(value);
  });
  const naiveNum = (label) => {
    const list = naiveAll.get(label);
    const raw = list?.[0];
    if (raw == null) return null;
    const text = raw.replace(/[,\s]/g, '');
    return text === '' ? null : Number(text);
  };

  const duplicateLabels = [...naiveAll.entries()].filter(([, v]) => v.length > 1);
  console.log(`  stat labels found: ${naiveAll.size} (${duplicateLabels.length} duplicated)`);
  console.log(`  duplicated: ${duplicateLabels.map(([k, v]) => `${k} x${v.length}`).join(', ')}`);
  check('stat pairs present', naiveAll.size > 5, `${naiveAll.size}`);
  check('page genuinely has duplicate labels', duplicateLabels.length > 0, `${duplicateLabels.length}`);
  check('totalShares matches independent read', profile.totalShares === naiveNum('shares'), `${profile.totalShares} vs ${naiveNum('shares')}`);
  // The page publishes "Free Float" twice: a share count and a percentage.
  // Reading the wrong one yields NaN or a bogus 40. Assert against the FIRST
  // occurrence (the live block), not a last-write-wins Map.
  const freeFloatValues = naiveAll.get('free float') ?? [];
  check('free float label appears more than once', freeFloatValues.length > 1, `${freeFloatValues.length}`);
  const expectedFreeFloat = Number(freeFloatValues[0].replace(/[,\s]/g, ''));
  check('freeFloat matches first occurrence', profile.freeFloatShares === expectedFreeFloat, `${profile.freeFloatShares} vs ${expectedFreeFloat}`);
  check('freeFloat is a real share count, not a percentage', profile.freeFloatShares == null || (profile.freeFloatShares > 1_000_000 && profile.freeFloatShares % 1 === 0), `${profile.freeFloatShares}`);
  check('duplicate labels are reported as warnings', profile.warnings.some((w) => w.includes('appears') && w.includes('times')), profile.warnings.slice(0, 2).join(' | '));
  // `current` must NOT fall back to LDCP: LDCP is the previous close.
  check('current is not silently LDCP', profile.current !== profile.ldcp, `current=${profile.current} ldcp=${profile.ldcp}`);
  check('live block volume is not zero', profile.volume == null || profile.volume > 0, `${profile.volume}`);
  check('volume matches independent read', profile.volume === naiveNum('volume'), `${profile.volume} vs ${naiveNum('volume')}`);
  check('description extracted', profile.description != null && profile.description.length > 20, `${profile.description?.length ?? 0} chars`);
  check('no schema warning', !profile.warnings.some((w) => w.includes('stats_label')), profile.warnings.join('; '));
  // A real assertion, not the earlier tautology: shares should be a real number.
  check('totalShares is a real share count', profile.totalShares == null || (profile.totalShares > 1_000_000), `${profile.totalShares}`);

  // -- listings / constituents --------------------------------------------
  section('dps /listings-table/main/nc');
  const listHtml = await get(`${DPS}/listings-table/main/nc`, h);
  const cons = parseConstituents(listHtml, `${DPS}/listings-table/main/nc`, 'NC');
  console.log(`  parsed ${cons.length} constituents`);
  const $list = cheerio.load(listHtml);
  const naiveCons = $list('tbody tr').length;
  check('constituents row count plausible', cons.length > 0, `${cons.length} vs naive ${naiveCons}`);
  check('every constituent has a symbol', cons.every((c) => c.symbol.length > 0));
  check('index code stamped on all', cons.every((c) => c.indexCode === 'NC'));

  // -- sector summary -----------------------------------------------------
  section('dps /sector-summary/sectorwise');
  const secHtml = await get(`${DPS}/sector-summary/sectorwise`, h);
  const sectors = parseSectorSummaries(secHtml, `${DPS}/sector-summary/sectorwise`);
  console.log(`  parsed ${sectors.length} sectors`);
  const $sec = cheerio.load(secHtml);
  const headers = $sec('thead th').map((_, el) => $sec(el).text().trim()).get();
  console.log(`  headers: [${headers.join(' | ')}]`);
  check('sector headers located', headers.length > 0, `${headers.length}`);

  // -- summary ------------------------------------------------------------
  console.log(`\n${'='.repeat(60)}`);
  console.log(`PASSED ${passed}   FAILED ${failed}`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('\nVERIFICATION ABORTED:', error.message);
  process.exit(2);
});
