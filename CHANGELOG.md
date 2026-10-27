# Changelog

## 0.3.0 — 2026-10-27

**The refused-egress diagnosis.** Measured 2026-10-27: PSX's data endpoints
(`/market-watch`, `/timeseries/eod`, `/timeseries/int`) answer **Cloudflare 52x
to datacenter egress** — Cloudflare Workers included — while the content pages
(`/company`, `/indices`, `/screener`, `/sector-summary`, `/listings-table`)
answer the same network normally, with the full gate satisfied. The library
always worked; the environment it runs in is what gets refused. This release
makes that diagnosis unmissable instead of misleading:

- **`PsxEdgeError`** (code `'EDGE'`): the Cloudflare 52x family, thrown with the
  edge status and the egress diagnosis. Previously `unexpected HTTP 520`, which
  read as a transient network fault and sent callers retrying a request that
  no retry can fix.
- **The fresh-key 403 message names the real cause.** `fetchGated` retries once
  with a freshly discovered gate key; when that is *also* refused, staleness is
  ruled out, and the error now says so — the request itself or the egress is
  being rejected — instead of sending the caller to refresh a key that is not
  the problem.
- **`history()` coverage documented**: equities, debt, ETFs, and the indices
  themselves (`history('KSE100')` returns the index's real daily series —
  latest close 164,467.2, the published level). Each bar's `time` is the
  session's last trade moment, not midnight.

**For Workers consumers:** gated calls throw `PsxEdgeError` in production. The
ungated market-summary fallback is unaffected and remains the Worker's working
source for live quotes; EOD history from the Worker has no reachable source and
needs a capture written from an allowed egress.

No parser or endpoint changes: `npm run verify` (live) passes 71/71, and the
endpoint set is unchanged from 0.2.0.
