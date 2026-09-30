# psx-data-api

[![npm version](https://img.shields.io/npm/v/psx-data-api.svg)](https://www.npmjs.com/package/psx-data-api-api)
[![npm downloads](https://img.shields.io/npm/dm/psx-data-api.svg)](https://www.npmjs.com/package/psx-data-api-api)
[![license](https://img.shields.io/npm/l/psx-data-api.svg)](https://opensource.org/licenses/MIT)
[![types](https://img.shields.io/npm/types/psx-data-api.svg)](https://www.typescriptlang.org/)
[![node](https://img.shields.io/badge/node-%3E%3D20.19-5FA04E.svg)](https://nodejs.org)
[![tested against live PSX](https://img.shields.io/badge/verified-live-3D9970.svg)](#development)

Typed client for the Pakistan Stock Exchange. Live quotes, five years of OHLCV
history, indices, sectors, and the full security directory.

Plain typed arrays. Real numbers. `null` for absent values — never a formatted
string, never a misleading `0`.

```ts
import { createPsxClient } from 'psx-data-api';

const psx = createPsxClient();

const { data: quotes } = await psx.marketWatch();
const hbl = quotes.find((q) => q.symbol === 'HBL');

hbl.current;   // 302.80  — number
hbl.change;    // 1.23    — negative when declining
hbl.volume;    // 1153509 — integer, not "1,153,509"
hbl.changePct; // 0.41    — number | null
```

## Install

```sh
npm install psx-data-api
```

Requires Node 20.19+ (or any runtime with a global `fetch`). Ships ESM with
bundled type declarations.

## What it covers

| Method | Returns | Size |
|---|---|---|
| `marketWatch()` | Every listed security with live quotes | 495 |
| `marketSummary()` | Exchange totals: status, volume, trades, breadth | 1 |
| `history(symbol)` | Daily OHLCV, oldest first | ~1,239 bars |
| `intraday(symbol)` | Price/volume ticks, last two sessions | ~682 |
| `symbols()` | Full directory: equities, debt, ETFs | 1,028 |
| `indices()` | Current index levels | 17 |
| `sectorSummary()` | Per-sector aggregates | 38 |
| `company(symbol)` | Fundamentals and share counts | 1 |

## Examples

### Find the day's biggest movers

```ts
const { data } = await psx.marketWatch();

const movers = data
  .filter((q) => q.changePct != null)
  .sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0))
  .slice(0, 10);

for (const q of movers) {
  console.log(`${q.symbol.padEnd(8)} ${q.changePct!.toFixed(2)}%  ${q.current}`);
}
```

### Is the market open?

```ts
const summary = await psx.marketSummary();

console.log(summary.status);    // "OPEN" | "CLOSED" | "PRE_OPEN"
console.log(summary.total);     // 569
console.log(summary.trades);    // 295473

// Internally consistent — the exchange's own arithmetic holds.
summary.advanced + summary.declined + summary.unchanged === summary.total;
```

### Chart five years of history

```ts
const bars = await psx.history('HBL');

const closes = bars.map((b) => b.close);
const last = bars.at(-1);

console.log(`${last?.time}  close ${last?.close}`);
```

`history()` returns bars oldest-first, so charting libraries need no re-sorting.
Note that PSX publishes **no high/low** on this endpoint — those fields are
`null` rather than guessed.

```ts
bars.at(-1);
// {
//   time:   '2026-09-30T11:00:00.000Z',
//   open:   302.8,
//   high:   null,     <- not published
//   low:    null,     <- not published
//   close:  306.1,
//   volume: 1153509,
// }
```

### Compare sectors

```ts
const sectors = await psx.sectorSummary();

const ranked = sectors
  .filter((s) => s.marketCapBn != null)
  .sort((a, b) => (b.marketCapBn ?? 0) - (a.marketCapBn ?? 0));

for (const s of ranked.slice(0, 5)) {
  console.log(
    `${s.sector.code} ${s.sector.name.padEnd(32)} ` +
    `${s.advanced}/${s.declined}  PKR ${s.marketCapBn}Bn`,
  );
}
```

### Company fundamentals

```ts
const hbl = await psx.company('HBL');

hbl.totalShares;      // 1466852508
hbl.freeFloatShares;  // 586741003
hbl.description;      // free-text profile

hbl.warnings;         // [] when the page parsed cleanly
```

## Two data sources

PSX publishes data through two endpoints with very different properties.

**`dps.psx.com.pk`** carries most of it, but requires three things on every
request: an `X-Req-Id` header (a value inlined in page HTML), an
`X-Requested-With: XMLHttpRequest` header, and a browser `User-Agent`. That key
**rotates** — this client discovers it lazily and refreshes it automatically on
a 403.

**`www.psx.com.pk/market-summary/`** requires none of that. A bare `fetch` works.

```ts
// Works even where dps.psx.com.pk is unreachable.
const psx = createPsxClient({ ungatedOnly: true });

const { data, source } = await psx.marketWatch();
// source === 'market-summary'
// 589 symbols, OHLC + volume. No change %, no sector codes.
```

By default `marketWatch()` tries the richer gated source and **degrades to the
ungated page** rather than throwing:

```ts
const { data, source, notice } = await psx.marketWatch();

if (notice) console.warn(`using fallback: ${notice}`);
```

A gated outage costs you `changePct` and index membership — not your data.

## Errors

```ts
import { PsxAuthError, isPsxError } from 'psx-data-api';

try {
  await psx.company('HBL');
} catch (error) {
  if (error instanceof PsxAuthError) {
    // PSX refused the gate key, even after a refresh.
  } else if (isPsxError(error)) {
    console.error(error.code, error.url);
  }
}
```

`PsxError` subclasses carry a `code` you can switch on: `AUTH`, `NOT_FOUND`,
`RATE_LIMITED`, `TIMEOUT`, `NETWORK`, `SCHEMA`, `CONFIG`, `ABORTED`, `PARSE`.

One quirk to expect: PSX answers an unknown ticker with **HTTP 500**, not 404,
so `company('NOSUCHTICKER')` surfaces as `PsxNetworkError` rather than a
not-found error. Verify a symbol against `symbols()` before calling if that
matters to you.

### When PSX changes its markup

Parsers validate the page structure before extracting and throw
`PsxSchemaError` naming the exact selector or column that no longer matches.

```
PsxSchemaError: PSX response did not match expected structure
(selectors v1): market-watch data rows ... found 0 elements
```

This is deliberate. Most scrapers return an empty array when a site changes,
which is indistinguishable from "market closed" — and that is exactly how several
existing PSX libraries became silently broken. A loud, specific failure is
recoverable; a silent empty array is not.

## Design notes

**`number | null`, always.** PSX genuinely publishes no value for some fields —
halted securities, thin coverage. Encoding that as `0` would render a stock at
zero and corrupt any average computed over it. Absence is data, and it is typed
as such.

**Values come from `data-order`.** Numeric cells carry both a formatted display
string and an unformatted machine value. This client reads the machine value, so
it never parses `"73,446,994"` and never loses precision.

**Row-major, not column-major.** You get `Quote[]`, so
`quotes.map(q => q.current)` just works.

**CORS blocks browsers.** No endpoint on `dps.psx.com.pk` sends
`access-control-allow-origin`, so a browser cannot call PSX directly. Use this
package server-side — Node, a serverless function, or an edge worker. Do not
expect `fetch` from a React component to work.

## Troubleshooting

```ts
const psx = createPsxClient();
const status = await psx.diagnostics();

status.hasKey;           // is a gate key currently held?
status.keyAgeMs;         // how old
status.keyRefreshCount;  // how many times PSX rejected one
```

If `marketWatch()` keeps falling back, PSX is refusing this host. PSX region-
blocks some cloud ranges; a deployment in South Asia works more reliably.

## Development

```sh
npm install
npm run check
npm run verify
npm run record
```

Tests run entirely against recorded fixtures and never touch the network. `npm
run verify` is the live check: it parses each source twice with independent
readers and compares every field.

## Data source

All data originates from the Pakistan Stock Exchange and belongs to PSX. This
package is a client for publicly reachable endpoints; it does not grant any
right to redistribute exchange data. Check PSX's terms before shipping it in a
commercial product.

## License

MIT. See [LICENSE](LICENSE).
