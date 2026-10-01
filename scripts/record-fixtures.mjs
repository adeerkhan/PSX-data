/**
 * Fixture recorder.
 *
 * Captures live PSX responses into trimmed, committed fixtures so the parser
 * test suite runs offline against real bytes.
 *
 * Trimmed deliberately. The full responses are large (the market-summary page is
 * 815 KB, market-watch is 474 KB) and the overwhelming majority of that is
 * navigation chrome and templating comments. What we keep is the table region
 * plus a fixed sample of rows -- enough to cover every edge case that actually
 * broke the Python references:
 *
 *   - rows where a value is absent ("No Data found!" empty states)
 *   - negative changes (the `decrease-rate` span)
 *   - positive changes (the `increase-rate` span)
 *   - comma-formatted numbers ("73,446,994")
 *   - zero volumes
 *
 * Live capture is opt-in and never runs in CI. PSX's terms forbid automated
 * access without permission, so the committed fixtures are the source of truth
 * for tests and this script is for maintainers who choose to refresh them.
 *
 * Usage:
 *   node scripts/record-fixtures.mjs [--full]
 */

import { mkdir, writeFile, readdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, '..', 'packages', 'fixtures', 'data');

const HOSTS = {
  dps: 'https://dps.psx.com.pk',
  www: 'https://www.psx.com.pk',
};

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** Rows to keep per HTML table. */
const SAMPLE_ROWS = 60;

/** Rows to keep from a bare top-level JSON array. */
const MAX_ARRAY_ROWS = 40;

/** Rows to keep from a timeseries `data` array. */
const MAX_TIMESERIES_ROWS = 120;

/**
 * Obtain a fresh `X-Req-Id`.
 *
 * This key is NOT static despite appearances. Between two captures on
 * 2026-09-30 the value changed from `MqehxMCM3RhH9ve9-...` to
 * `mnXvHiF2LPD4...`, which is why the client refreshes on 403 rather than
 * caching a constant. It is read from the page HTML, never hardcoded.
 */
async function fetchKey() {
  const res = await fetch(`${HOSTS.dps}/`, {
    headers: { 'User-Agent': BROWSER_UA },
  });
  if (!res.ok) throw new Error(`dps root returned ${res.status}`);
  const html = await res.text();
  const match = /window\.__ps\s*=\s*(\{[^}]+\})/.exec(html);
  if (match == null) throw new Error('no window.__ps blob found in dps root');
  const blob = JSON.parse(match[1]);
  if (typeof blob._k !== 'string' || blob._k.length === 0) {
    throw new Error('window.__ps._k missing or empty');
  }
  console.log(`  obtained X-Req-Id (length ${blob._k.length})`);
  return blob._k;
}

/** Headers every gated dps request needs. All three are required. */
function gatedHeaders(key) {
  return {
    'User-Agent': BROWSER_UA,
    'X-Req-Id': key,
    'X-Requested-With': 'XMLHttpRequest',
    Referer: `${HOSTS.dps}/`,
    Origin: HOSTS.dps,
    Accept: 'application/json, text/html, */*',
  };
}

/**
 * Trim an HTML document down to the region the parsers actually read.
 *
 * Keeps `<head>` metadata (for the key blob, where present) and the first table
 * region's rows. Strips nav, scripts, and templating comments, which is where
 * nearly all the bulk lives.
 */
function trimHtml(html, { anchor, keepRows = SAMPLE_ROWS, keepBefore = 0 }) {
  let out = html;

  // Drop comments: the market-watch rows carry templating comments
  // (`<!-- td.right(data-order=item.obq) -->`) that are large and inert.
  out = out.replace(/<!--[\s\S]*?-->/g, '');

  // Drop scripts and styles wholesale.
  out = out.replace(/<script[\s\S]*?<\/script>/gi, '');
  out = out.replace(/<style[\s\S]*?<\/style>/gi, '');

  if (anchor != null) {
    const at = out.indexOf(anchor);
    if (at !== -1) {
      // Start from a little before the anchor so the enclosing table header
      // survives -- the header assertion depends on it.
      out = out.slice(Math.max(0, at - keepBefore));
    }
  }

  // Keep only the first `keepRows` table rows after the anchor.
  const rowRe = /<tr\b[\s\S]*?<\/tr>/gi;
  let count = 0;
  out = out.replace(rowRe, (match) => {
    count += 1;
    return count <= keepRows ? match : '';
  });

  // Collapse the whitespace the row removal leaves behind.
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');

  return out;
}

async function record() {
  const full = process.argv.includes('--full');
  await mkdir(FIXTURE_DIR, { recursive: true });

  // Clear stale fixtures so a removed endpoint does not linger as a passing test.
  for (const entry of await readdir(FIXTURE_DIR).catch(() => [])) {
    await unlink(join(FIXTURE_DIR, entry)).catch(() => {});
  }

  console.log('Obtaining fresh X-Req-Id...');
  const key = await fetchKey();

  /**
   * Trim record for bare arrays, written to a sidecar manifest.
   *
   * Recorded separately rather than injected into the JSON, because injecting it
   * would change the payload's shape -- see the note in the array branch below.
   */
  const trims = {};

  // `keepBefore` is how much document context to retain ahead of the anchor.
  //
  // market-summary needs a very large window: the market-wide scalars
  // (Status/Volume/Trades/Advanced/Declined/Unchanged/Total) and the
  // publication timestamp appear in the page header, long before the first
  // `data-srip` row. Trimming tightly around the anchor silently drops them,
  // which is exactly the kind of quiet fixture rot that hides parser bugs --
  // so we keep the whole document up to the first table row.
  const htmlTargets = [
    { name: 'market-watch', url: `${HOSTS.dps}/market-watch`, anchor: '<thead', keepBefore: 4000 },
    { name: 'market-summary', url: `${HOSTS.www}/market-summary/`, anchor: 'data-srip', keepBefore: 200_000 },
    { name: 'indices', url: `${HOSTS.dps}/indices`, anchor: 'topIndices__item__name', keepBefore: 4000 },
    { name: 'company-hbl', url: `${HOSTS.dps}/company/HBL`, anchor: 'stats_label', keepBefore: 8000 },
    { name: 'listings-nc', url: `${HOSTS.dps}/listings-table/main/nc`, anchor: '<thead', keepBefore: 4000 },
    { name: 'index-kse100', url: `${HOSTS.dps}/indices/KSE100`, anchor: '<thead', keepBefore: 4000 },
    { name: 'sector-summary', url: `${HOSTS.dps}/sector-summary/sectorwise`, anchor: 'Sector Code', keepBefore: 4000 },
  ];

  const jsonTargets = [
    { name: 'symbols', url: `${HOSTS.dps}/symbols` },
    { name: 'timeseries-eod-hbl', url: `${HOSTS.dps}/timeseries/eod/HBL` },
    { name: 'timeseries-int-hbl', url: `${HOSTS.dps}/timeseries/int/HBL` },
    { name: 'top-10-sectors', url: `${HOSTS.dps}/data/top-10-sectors` },
    { name: 'top-10-symbols', url: `${HOSTS.dps}/data/top-10-symbols` },
    { name: 'symbol-position', url: `${HOSTS.dps}/data/symbol-position` },
  ];

  for (const target of htmlTargets) {
    process.stdout.write(`  ${target.name} ... `);
    try {
      const res = await fetch(target.url, { headers: gatedHeaders(key) });
      const body = await res.text();
      const trimmed = full
        ? body
        : trimHtml(body, { anchor: target.anchor, keepBefore: target.keepBefore });
      await writeFile(join(FIXTURE_DIR, `${target.name}.html`), trimmed, 'utf8');
      console.log(`${res.status}, ${(body.length / 1024).toFixed(0)}KB -> ${(trimmed.length / 1024).toFixed(0)}KB`);
    } catch (error) {
      console.log(`FAILED: ${error.message}`);
    }
  }

  for (const target of jsonTargets) {
    process.stdout.write(`  ${target.name} ... `);
    try {
      const res = await fetch(target.url, { headers: gatedHeaders(key) });
      const body = await res.text();
      const outFile = join(FIXTURE_DIR, `${target.name}.json`);

      if (full) {
        await writeFile(outFile, body, 'utf8');
        console.log(`${res.status}, ${body.length} bytes (full)`);
        continue;
      }

      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        // Not JSON at all -- store raw and let the test fail loudly if the
        // parser expected otherwise.
        await writeFile(outFile, body, 'utf8');
        console.log(`${res.status}, ${body.length} bytes (raw, unparseable)`);
        continue;
      }

      // Two shapes exist across these endpoints:
      //   a) an envelope `{status, message, data:[...]}`, where `data` can be
      //      thousands of rows (timeseries), and
      //   b) a bare top-level array (`/symbols`, `/data/top-10-*`).
      // Trim both, and mark the envelope case so a reader knows rows were cut.
      if (Array.isArray(parsed)) {
        // A bare array must stay a bare array: the parser's contract is
        // "top-level array", and wrapping it in an object to stash trim
        // metadata would mask exactly the shape change we want tests to catch.
        const original = parsed.length;
        const kept = original > MAX_ARRAY_ROWS ? parsed.slice(0, MAX_ARRAY_ROWS) : parsed;
        await writeFile(outFile, JSON.stringify(kept, null, 1), 'utf8');
        if (original > MAX_ARRAY_ROWS) {
          trims[target.name] = { kept: MAX_ARRAY_ROWS, original };
        }
        console.log(`${res.status}, ${body.length} bytes -> ${kept.length} of ${original} rows`);
      } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.data)) {
        const original = parsed.data.length;
        if (original > MAX_TIMESERIES_ROWS) {
          parsed.data = parsed.data.slice(0, MAX_TIMESERIES_ROWS);
          parsed.__fixture_trimmed_to = MAX_TIMESERIES_ROWS;
          parsed.__fixture_original_length = original;
        }
        await writeFile(outFile, JSON.stringify(parsed, null, 1), 'utf8');
        console.log(`${res.status}, ${body.length} bytes -> ${Math.min(original, MAX_TIMESERIES_ROWS)} of ${original} rows`);
      } else {
        await writeFile(outFile, JSON.stringify(parsed, null, 1), 'utf8');
        console.log(`${res.status}, ${body.length} bytes`);
      }
    } catch (error) {
      console.log(`FAILED: ${error.message}`);
    }
  }

  if (Object.keys(trims).length > 0) {
    await writeFile(
      join(FIXTURE_DIR, '_trims.json'),
      JSON.stringify(trims, null, 2),
      'utf8',
    );
  }

  console.log(`\nFixtures written to ${FIXTURE_DIR}`);
  console.log('These are test data, not a license to redistribute PSX market data.');
}

record().catch((error) => {
  console.error(error);
  process.exit(1);
});
