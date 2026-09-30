# Test fixtures

Trimmed, recorded responses from the Pakistan Stock Exchange, used by the
parser test suite so tests run offline against real bytes.

## Do not fetch these at test time

The parser tests read these files and never touch the network. That is
deliberate, for two reasons:

1. **PSX's terms forbid automated access without permission.** Their Terms of
   Use state you may not use "spiders, robots, avatars, agents, tools or other
   devices or mechanisms to navigate, search or determine the website, except
   where you have prior written permission". A test suite that hits their
   servers on every CI run is exactly that.
2. **Upstream is fragile.** All three Python references in `ref/` have silently
   rotted because nothing pinned the shape they depended on.

## Refreshing

```sh
npm run record          # trimmed, ~1 MB total
node scripts/record-fixtures.mjs --full   # untrimmed, for local debugging only
```

The recorder reads a fresh `X-Req-Id` from `https://dps.psx.com.pk/` each run
and never hardcodes one. That key **rotates** -- two captures on the same day
produced different values -- which is why the client refreshes it on HTTP 403
instead of caching a constant.

## What is trimmed

| Fixture | Full size | Kept | Why |
|---|---|---|---|
| `market-summary.html` | 815 KB | ~40 KB | nav, scripts, and 569 of 589 rows dropped |
| `market-watch.html` | 474 KB | ~40 KB | templating comments stripped; first 60 rows kept |
| `timeseries-eod-hbl.json` | 41 KB | ~3 KB | first 120 bars of 1239 |

Comments and scripts are removed wholesale -- the market-watch rows carry inert
templating comments such as
`<!-- td.right(data-order=item.obq)=numeral(item.obq).format('0,0') -->` which
are large and never parsed.

## Edge cases deliberately preserved

These are precisely the cases that broke the Python references:

- Absent values rendering as `No Data found!` -- `psx-data-reader` silently
  returned an empty frame here
- The misspelled `data-srip` attribute (upstream's own typo) -- load-bearing,
  and the only reliable ticker identifier on the market-summary row
- The misspelled `profile__item--decription` class on company pages
- Negative changes wrapped in a `decrease-rate` span, positive in `increase-rate`
- Comma-formatted numbers (`73,446,994`) sitting beside unformatted
  `data-order` attributes
- Zero volumes, which are real and must stay `0` rather than becoming `null`

## Provenance

Captured 2026-09-30 from:

- `https://www.psx.com.pk/market-summary/` -- no key required
- `https://dps.psx.com.pk/{market-watch,indices,company/HBL,listings-table/main/nc,symbols,timeseries/eod/HBL,timeseries/int/HBL,data/*}`

These files exist so parsers can be tested against reality. They are not a
license to redistribute PSX market data, and they should not be published to npm.
