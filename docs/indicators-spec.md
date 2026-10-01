# PSX Indicators & Performance Metrics — Implementation Specification

**Status:** draft for implementation. Every numeric claim is tagged with its provenance:

| Tag | Meaning |
|---|---|
| `[V-TULIP]` | Cross-checked against the worked example table published at tulipindicators.org. Values reproduce to the published precision. |
| `[V-TALIB]` | Read directly out of TA-Lib C source (`TA-Lib/ta-lib`, branch `dev`). |
| `[V-NPM]` | Read directly out of the published `technicalindicators@3.1.0` bundle. |
| `[V-CALC]` | Computed by me from the stated formula, not cross-checked against any published table. Arithmetic is shown so it can be re-derived. |
| `[AMBIG]` | Genuinely contested between sources. Both/all variants documented; our choice stated explicitly. |

> **Accuracy policy.** Where a library disagrees with this spec, this spec is wrong or the
> reader is using a different variant — find out which before assuming a bug. Wrong indicators
> are worse than missing ones.

---

## 0. Scope and reading guide

This document specifies ~45 functions across three layers:

- **Part 1** — statistical and performance metrics (§3)
- **Part 2** — technical indicators (§4)
- **Part 3** — deterministic signal / insights layer (§5)

Supporting material:

- §1 Input contract
- §2 Global numerical conventions (nulls, NaN, precision, Welford, `ddof`, annualization)
- §6 Master edge-case matrix
- §7 Test-vector datasets A and B
- §8 Library-disagreement matrix
- §9 Open questions / things that could not be verified

Target runtime: TypeScript, no dependencies, ES2022, `number` (IEEE-754 double) throughout.

---

## 1. Input contract

### 1.1 The bar type

```ts
export interface Bar {
  /** Unix epoch milliseconds, UTC midnight. */
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Shares traded. Must be a finite number >= 0. Volume is REQUIRED even for
   *  price-only indicators, because the adapter validates OHLC consistency. */
  volume: number;
}
```

Every technical indicator accepts one of:

```ts
export type OHLCV  = readonly Bar[];
export type Close  = readonly number[];   // only for SMA/EMA/WMA/RSI/ROC/MOM/TRIX/DEMA/TEMA/HMA/MACD line
export type HighLowClose = { high: readonly number[]; low: readonly number[]; close: readonly number[] };
```

### 1.2 ORDER — READ THIS, IT IS THE #1 SOURCE OF SILENTLY WRONG VALUES

**All indicator inputs MUST be sorted ASCENDING by timestamp — oldest first, newest last.**

This is the opposite of what most PSX/alpha-vantage-shaped APIs hand you.

- The (now removed) ``psx-data-reader`` explicitly calls ``data.sort_index()`` (ascending).
- The DPS historical API (`https://dps.psx.com.pk/historical`) returns each monthly table
  newest-row-first; the Python reader relies on the ascending sort to undo that.
- The npm `technicalindicators` package calls `Indicator.reverseInputs(input)` on every input,
  because *its* public API takes newest-first arrays. Do **not** copy its convention.
- The pypsx_toolkit public stub (since removed from this repo) documents`history()` returning a
  `Date`-indexed DataFrame but does not state the order.

**Enforcement.** Every function that takes `Bar[]` MUST run this precondition and throw
`OrderError` on violation:

```ts
function assertAscending(bars: readonly Bar[]): void {
  for (let i = 1; i < bars.length; i++) {
    if (!(bars[i].timestamp > bars[i - 1].timestamp)) {
      throw new OrderError(
        `bars must be strictly ascending by timestamp; ` +
        `index ${i - 1} (ts=${bars[i - 1].timestamp}) >= index ${i} (ts=${bars[i].timestamp})`
      );
    }
  }
}
```

Functions that take raw `number[]` (e.g. `sma(close, 20)`) cannot check order. Their docstring
MUST carry `/** requires ASCENDING input */`. `Bar`-taking wrappers are the safe path and are
the default public API.

**Failure mode if ignored.** `sma` is symmetric so it is unaffected; `ema`, `rsi`, `macd`,
`obv`, `adl`, `atr`, `adx`, `psar`, `supertrend`, `roc`, `trix`, and every cumulative function
return *plausible-looking, completely wrong* numbers. There is no exception, no NaN, no warning.
This is why the check is a throw, not a warning.

### 1.3 OHLC consistency validation

On ingest, validate once (not per indicator call):

```
for each bar:
  low <= min(open, close) <= max(open, close) <= high
  volume >= 0
  all six fields finite (no NaN, no Infinity)
```

Reject the **whole series** with `DataError` if any bar fails. Do not silently repair bars.

PSX publishes suspended / zero-volume days. A bar with `volume === 0` and
`open === high === low === close` is legal. A bar with `volume === 0` and a real range is
treated as `volume 0` for all volume indicators (it contributes nothing to sums) but still
participates in price indicators. See §2.6.

### 1.4 Duplicates and gaps

- Duplicate timestamps → `DataError`. Never average or dedupe silently.
- Calendar gaps (holidays, closures) are **expected and must not be filled**. Indicators are
  bar-count based, not calendar based. Do not resample.

### 1.5 Bar interval

This spec assumes **daily** bars (one bar per PSX trading day, ~250/yr). Weekly and monthly
bars are legal inputs; every warmup is stated in **bars**, and the annualization factor must be
supplied by the caller for non-daily bars (§2.7).

---

## 2. Global numerical conventions

These rules apply to **every** function in this spec. Deviating from them is a spec violation.

### 2.1 Missing output: `null`, never `NaN`

**Every indicator returns `(number | null)[]`, the same length as its input.** Positions that
cannot be computed because of insufficient warmup are `null`. `NaN` is **never** returned and
**never** appears inside an output array.

Rationale: `NaN` propagates silently and turns a downstream chart into an empty canvas with no
error. `null` is a value you must handle, and JSON round-trips it as `null`.

```
rsi(close, 14)          -> (number|null)[]   length === close.length
rsi([1,2,3], 14)        -> [null, null, null]
```

Rules:

1. Warmup positions → `null`.
2. Mathematically undefined (0/0) → `null` (§2.4).
3. Scalar metrics that are undefined (Sharpe with zero volatility, beta with zero benchmark
   variance) → `null`, **not** `Infinity`, `NaN`, or `0`.
4. `NaN` **input** → throw `DataError`. Do not propagate.

Implementation note: `Number.isFinite` guards must be written so that `null` never reaches an
arithmetic operator. Internally use `number | null` and short-circuit; do not use `as number`.

### 2.2 Output length and index alignment

For every indicator in Part 2:

- Output length **equals** input length. The output is index-aligned with the input.
- Output `[i]` is the value **as of bar `i`**, using data up to and including bar `i`. No
  look-ahead, no centred windows.
- `warmup` (number of leading `null`s) is stated per indicator and is exact, not "about".

### 2.3 Scalar metrics

Part 1 functions return `number | null`, or a structured object whose numeric fields are
`number | null`. Never `undefined` and never `NaN`.

### 2.4 Division by zero

Canonical rule, applied everywhere:

```ts
/** Returns null when the denominator is exactly 0 (or exactly non-finite). */
function div(num: number, den: number): number | null {
  return den === 0 || !Number.isFinite(num / den) ? null : num / den;
}
```

- Denominator is `0` (exact) → `null`.
- Division overflows to `Infinity` → `null`.
- There is **no epsilon band**. `1e-18` is a real denominator and produces a real number.
  A previous fixed epsilon (`TA_IS_ZERO`) is a known TA-Lib bug class: it zeroes a healthy
  oscillator for any instrument quoted below the epsilon (TA-Lib issue #253). Do not
  reintroduce it.

Constant-price series therefore produce `null`, not `0` and not `NaN`, wherever a ratio is
involved. E.g. `RSI` on a flat series is `null` (see §4.7 for the exact rule).

### 2.5 Catastrophic cancellation — use Welford, not the two-pass-free sum-of-squares

The naive `mean(x²) − mean(x)²` form loses catastrophically when `|mean| >> stddev`. For a
PSX price series quoted around 500 with a daily stddev of ~5, `mean(x²) ≈ 250000` and
`mean(x)² ≈ 250000`, and their difference is ~25. The relative error of the double-precision
representation of 250000 is ~2⁻⁵² ≈ 2.2e-16, so the absolute error on a variance of 25 is
~5.5e-11 — tolerable here, but it degrades as `O(mean²/std²)` and is catastrophic for
low-variance instruments (e.g. a near-flat bond-fund-like price, or short windows).

**Required implementation: Welford's online algorithm** (for streaming/rolling) or a
**shifted two-pass** algorithm (for batch windows). Either is acceptable; the naive
`sum(x²)/n − (sum(x)/n)²` is **forbidden**.

```ts
/** Welford, single pass, numerically stable. `pop = true` -> divide by n, else n-1. */
function varianceWelford(xs: ArrayLike<number>, pop = true): number | null {
  const n = xs.length;
  if (n < (pop ? 1 : 2)) return null;
  let mean = 0, m2 = 0, i = 0;
  for (const x of xs) {           // must skip nothing; caller filters non-finite
    i++;
    const d = x - mean;
    mean += d / i;
    m2 += d * (x - mean);
  }
  return m2 / (pop ? n : n - 1);
}

/** Shifted two-pass. `k` is any value in/near the window (e.g. its first element). */
function varianceShifted(xs: ArrayLike<number>, k: number, pop = true): number | null {
  const n = xs.length;
  if (n < (pop ? 1 : 2)) return null;
  let sum = 0;
  for (const x of xs) sum += x - k;
  const mean = sum / n;
  let m2 = 0;
  for (const x of xs) { const d = x - k - mean; m2 += d * d; }
  return m2 / (pop ? n : n - 1);
}
```

This is exactly what TA-Lib does: `ta_VAR.c` computes `variance = periodTotal2/period − mean²`
with `periodTotal1/2` built from `inReal[j] − shift`, anchored to the first window element. Cite
that comment; it is the reference implementation.

Rolling (windowed) variance MUST use a rolling Welford with add/remove updates, or a rolling
shifted two-pass with add/remove on the shifted sums. Rolling sums alone (`rolling(n).std()`)
recomputing a naive variance per window is O(n·w) and still numerically fragile.

### 2.6 Non-finite and zero input values

| Input condition | Behaviour |
|---|---|
| `NaN` / `Infinity` in any bar field | throw `DataError` at ingest (§1.3). Never reaches an indicator. |
| `volume === 0` | Legal. Contributes `0` to every volume sum. Bar still participates in price-only indicators. |
| `high === low` | Legal. Makes `max−min === 0`; any indicator dividing by the range returns `null` for that bar (Stochastic %K, Williams %R, MFI, CMF, A/D). |
| `close === 0` or negative | Legal input (PSX does not produce it), but every return/drawdown/percent indicator returns `null` for the affected bar, because the percentage change is undefined. |

### 2.7 The annualization factor — 252 vs 365

This is the single most consequential convention in Part 1. Get it wrong and every risk-adjusted
number is wrong by `sqrt(365/252) = 1.204`.

**The two conventions:**

| Convention | Value | When |
|---|---|---|
| **Trading-day** | `252` | Daily equity/PSX data. Volatility is over *trading* time. |
| **Calendar-day** | `365` | Continuously-traded or crypto data. |

**What the standard libraries actually do** `[V-*]`:

| Library | Daily default | Note |
|---|---|---|
| `empyrical` (Quantopian) | **252** | `annualization_factor(period)` → `{'monthly': 12, 'weekly': 52, 'daily': 252}`. Source: `quantopian/empyrical@master:empyrical/stats.py`. |
| `PyPortfolioOpt` | **252** | |
| `quantstats` | **252** | |
| `backtrader` | **252** | |
| `pyfolio` | **252** | |
| **QuantLib** | **252** | Risk-measure annualization factor for continuous monitoring (TARGET). |
| **`statsmodels.tsa.stattools.sharpe_ratio`** | **365** | Signature `sharpe_ratio(x, ddof=1, periods=365)`. The outlier. |
| `scipy.stats` / `numpy` | n/a | No annualization; caller supplies. |
| `R PerformanceAnalytics` | **252** | |

**Our choice: `252` for daily bars, exposed as a required option.**

```ts
export interface AnnualizationOptions {
  /** Periods per year. Default 252 for daily bars. MUST be overridden for
   *  weekly (52), monthly (12), or crypto/24-7 (365). */
  periodsPerYear?: number;   // default 252
}
```

Rules:

1. Default `periodsPerYear = 252`.
2. If the caller passes non-daily bars, `periodsPerYear` is **required** (no silent default).
   Document the mapping: weekly → 52, monthly → 12, 24-7 crypto → 365, hourly (6.5h session) → 1638.
3. The **risk-free rate** is always an ANNUAL figure and MUST be divided by `periodsPerYear`
   before subtracting from a per-period return. Never compare an annual rf to a daily mean.
4. Annualized volatility scales by `sqrt(periodsPerYear)`.
5. Sharpe / Sortino / information ratio scale by `sqrt(periodsPerYear)`.
6. CAGR uses the actual bar count (see §3.2) — it does **not** use `periodsPerYear` directly
   unless you also have the true elapsed period count. Read §3.2 carefully; this is the most
   commonly botched formula in the set.

### 2.8 Precision and rounding

- **No rounding inside indicators.** Return full `double` precision. Rounding propagates error.
- Formatting/rounding is a presentation concern and belongs in the API/UI layer.
- One documented exception: npm `technicalindicators` rounds RSI to 2 decimals
  (`parseFloat((100 - (100/(1+RS))).toFixed(2))`). We do **not** reproduce this. It is listed in
  §8 as a divergence so anyone cross-checking against that package knows why they see `-0.01`
  scale differences.
- Tests MUST use a relative tolerance, not exact equality, except where the expected value is
  exactly representable. Recommended: `expectClose(actual, expected, 1e-9)` relative for values
  of magnitude > 1, `1e-12` absolute for values near zero.

---

## 3. Part 1 — Statistical and performance metrics

### 3.0 Shared input: the return series

Most Part 1 metrics do not take OHLCV. They take a **return series**.

```ts
export interface ReturnOptions {
  /** 'simple' = P_t/P_{t-1} - 1. 'log' = ln(P_t/P_{t-1}). Default 'simple'. */
  method?: 'simple' | 'log';
  periodsPerYear?: number;   // default 252, see 2.7
  /** Annual risk-free rate as a decimal, e.g. 0.10 for 10%. Default 0.
   *  For PSX the defensible default is the prevailing Pakistan T-bill yield;
   *  pass it explicitly rather than relying on a default. */
  riskFreeRate?: number;
}
```

`simpleReturns(close: readonly number[]): (number | null)[]`
- Length equals input. `[0] = null` (no prior bar).
- `r[t] = close[t]/close[t-1] - 1`.
- `close[t-1] === 0` → `r[t] = null`.

`logReturns(close: readonly number[]): (number | null)[]`
- `[0] = null`. `r[t] = Math.log(close[t]/close[t-1])`.
- `close[t-1] <= 0` or `close[t] <= 0` → `null`.

**Which return type for which metric** `[AMBIG]` — a real, cited disagreement:

| Metric | Standard | Disagreement |
|---|---|---|
| Total return | simple | none |
| CAGR | simple | none |
| Annualized volatility | **log** | `pypsx_toolkit` stub docstring says *"std dev of log returns"*; most Python code uses simple returns. Simple vs log changes ann. vol by ~0.5% relative on typical data. **We default to simple** (matches empyrical, QuantLib, QuantStart) and expose `method`. |
| Sharpe | simple | none — Sharpe is *defined* on simple returns by Sharpe (1966). |
| Sortino | simple | none |
| VaR / CVaR | either | Historical VaR is distribution-based; log returns are more Gaussian. We support both, default simple. |
| Beta / alpha / Treynor / IR | simple | CAPM is defined on simple returns. Both supported. |

Beta with simple returns on dataset A = `1.25170734`; with log returns = `1.24921628`. Both are
in §7.2 — a 0.2% difference, which is exactly why this must be a documented option.

### 3.1 Total / cumulative return

```
totalReturn = P_last / P_first - 1
```

- Input: `close: readonly number[]`, or `bars: readonly Bar[]` (uses `close`).
- Requires `close.length >= 2`. Else `null`.
- `close[0] === 0` → `null`.
- Ignores any interior `null` (there are none after ingest validation).
- Returns a **decimal fraction**, not a percentage. `0.35` means 35%.

`cumulativeReturns(close): (number|null)[]` — the equity curve, normalized:
- `cum[t] = P_t / P_0`. `[t] = 1` at `t = 0`. Length equals input.
- `P_0 === 0` → all `null`.

### 3.2 Annualized return (CAGR)

Two distinct quantities are both called "annualized return". Confusing them is the most common
error in this area.

```
yearsElapsed  = (nBars - 1) / periodsPerYear          // bar-count convention
cagr          = (P_last / P_first) ** (1 / yearsElapsed) - 1
             = (P_last / P_first) ** (periodsPerYear / (nBars - 1)) - 1
```

- Requires `nBars >= 2`. Else `null`.
- `yearsElapsed <= 0` → `null`.
- `P_first <= 0` or `P_last <= 0` → `null`.
- Result in `(-1, +Infinity)`. May legitimately exceed 1 and may be negative.
- **With a short series the number is an extrapolation, not a measurement.** With 14 bars and
  `periodsPerYear = 252`, `yearsElapsed = 13/252 = 0.0516`, and CAGR is 237% on a 7% total
  return. That is arithmetically correct and statistically meaningless. **The function must
  return the value anyway** (it is the caller's job to sanity-check) but MUST expose
  `yearsElapsed` alongside it.

```ts
export interface AnnualizedReturn {
  cagr: number | null;
  yearsElapsed: number | null;
  /** true when (nBars - 1) / periodsPerYear < minYears (default 2). Consumer should
   *  treat cagr as unreliable and display "insufficient history". */
  reliable: boolean;
}
annualizedReturn(close, { periodsPerYear = 252, minYears = 2 }): AnnualizedReturn
```

**Calendar-time variant** `[AMBIG]`: if real timestamps are available, a better `yearsElapsed`
is `(t_last − t_first) / (365.25 * 86_400_000 * 1000)`. The two differ materially for
non-daily bars (a 20-calendar-day span of daily bars gives `0.0556` years by calendar vs
`0.0516` by bar count, an 8% difference). Provide `annualizedReturnFromBars(bars, opts)` using
calendar time and `annualizedReturn(close, opts)` using bar count. **Do not silently pick one.**

**empyrical divergence** `[V-*]`: `empyrical.annualize_return` computes `(1 + cumReturn) ** A − 1`
where `A = periodsPerYear`. For a multi-period return series this is wrong by construction — it
raises a cumulative multi-year return to the 252nd power. Documented here so nobody porting
empyrical code copies it.

### 3.3 Annualized volatility

```
volAnnualized = std(returns) * sqrt(periodsPerYear)
std            = sample standard deviation, ddof = 1        // see 2.5
```

- Requires `n >= 2` valid returns, else `null`.
- `ddof = 1` (sample). Justification: `empyrical.annual_volatility` uses `np.nanstd(returns,
  ddof=1)`; `pandas.Series.std()` defaults to `ddof=1`; QuantLib's `volatility` estimator is a
  sample estimator. `[V-*]`
- **This is opposite to Bollinger Bands**, which use population (`ddof = 0`) — see §4.5. Both
  are correct in their domain; do not "unify" them.
- Constant returns (zero variance) → `0`, not `null`. Zero volatility is a real measurement.
- `std(returns) = 0` is legal. It makes Sharpe `null` (§3.4), not infinite.

### 3.4 Sharpe ratio

```
rfPerPeriod = riskFreeRate / periodsPerYear
excess[t]   = returns[t] - rfPerPeriod
sharpe      = (mean(excess) / std(excess, ddof=1)) * sqrt(periodsPerYear)
```

- Requires `n >= 2`. Else `null`.
- `std === 0` → `null` (§2.4). **Not** `Infinity`, **not** `0`.
- `riskFreeRate` is an ANNUAL decimal. Default: `0` — but for PSX the honest default is the
  prevailing T-bill yield; require it to be passed for any published number.
- Returns are **simple**.
- `periodsPerYear` default `252`.
- Interpretation bands (convention, not a formula): `< 0` poor, `0–1` acceptable, `> 1` good,
  `> 2` very good, `> 3` exceptional. PSX equities realistically sit in `0–1`.

**Divergence to note** `[AMBIG]`: some implementations subtract the geometric mean excess return
rather than the arithmetic mean. Sharpe's original and every standard library use the arithmetic
mean. We use arithmetic.

### 3.5 Sortino ratio

```
rfPerPeriod    = riskFreeRate / periodsPerYear
excess[t]      = returns[t] - rfPerPeriod
downside[t]    = min(excess[t], 0)              // 0 when excess >= 0
downsideDev    = sqrt( mean(downside[t]^2) )   // over ALL n observations
sortino        = (mean(excess) * periodsPerYear - riskFreeRate) / (downsideDev * sqrt(periodsPerYear))
```

Equivalent, clearer form: `annualisedExcessReturn / annualisedDownsideDeviation`.

- Requires `n >= 2`. Else `null`.
- `downsideDev === 0` (no negative excess returns at all) → `null`. **Not** `Infinity`.
- Denominator uses **all n** observations, not just the losing ones, and is **not** divided by
  `n_losses`. This matches `empyrical.downside_risk_ratio`:
  `np.sqrt(np.nanmean(np.square(np.clip(0, None, returns - mar))))`. `[V-*]`
- **Divergence**: the "Sortino" that divides only by the losing observations' own count is a
  different statistic (sometimes called the "modified Sortino" or used by
  `quantopian/alphalens`-era code). Not used here. Documented so it is not mistaken for a bug.

### 3.6 Calmar ratio

```
calmar = cagr / abs(maxDrawdown)
```

- Requires `nBars >= 2` and a defined `maxDrawdown`. Else `null`.
- `maxDrawdown === 0` (monotonically rising series) → `null`. **Not** `Infinity`.
- Uses the **CAGR** from §3.2 (bar-count convention), not the arithmetic mean return.
- Returns a non-negative number. Drawdown is a magnitude.

**Divergence** `[V-*]`: `empyrical.calmar_ratio` uses `annualize_return(returns) / abs(max_drawdown(returns))`,
i.e. the flawed `annualize_return` from §3.2. Over a 1-year window `(1+cum)^252 − 1` and CAGR
happen to be similar; over 3 years they differ enormously. We use the true CAGR.

### 3.7 Maximum drawdown

**Sign convention: drawdowns are returned as NEGATIVE numbers in `[-1, 0]`.** A 35% loss is
`-0.35`. This is the `pypsx_toolkit` stub's stated convention ("Maximum peak-to-trough drawdown
as a negative decimal (e.g. -0.35 = -35%)") and matches `empyrical.max_drawdown`. Preserve it
everywhere, including in the Calmar numerator's `abs()`.

```
drawdown[t] = (equity[t] / runningMax(equity[0..t])) - 1
maxDrawdown = min(drawdown)
```

where `equity[t] = P_t / P_0`.

- Requires `nBars >= 2`. Else `null`.
- `drawdown[0] = 0` by construction.
- `maxDrawdown === 0` iff the series never closed below a prior close.
- Work on the **equity curve built from closes**, not on the return series — this is
  drawdown-from-a-running-peak, and it must include the starting price as the first peak.
- Use the simple return series only if you are given returns instead of prices; in that case
  reconstruct `equity[t] = prod(1 + r[k])` with `equity[0] = 1`.

### 3.8 Drawdown series and drawdown duration

`drawdown(close): (number|null)[]` — length equals input, `drawdown[0] = 0`, all values in
`[-1, 0]`, non-positive. This is what `pypsx_toolkit.analysis.drawdown` is stubbed to return
(*"Rolling drawdown series (0 to -1 scale)"*).

**Drawdown duration — three different definitions exist** `[AMBIG]`:

| Definition | Meaning | Recommended? |
|---|---|---|
| (a) Longest underwater run | Length in bars of the longest stretch where `drawdown < 0`. Includes the recovery bar. | **Yes — default.** Matches the stub docstring "Length of the longest drawdown period in trading days". |
| (b) Longest time-to-recovery | Bars from a peak until equity returns to that peak. Undefined (→ `null`) if never recovered within the sample. | Provide as `timeToRecovery`. |
| (c) Current underwater duration | Bars since the most recent all-time high. | Provide as `currentUnderwaterBars`. |

```ts
export interface DrawdownStats {
  drawdown: (number | null)[];      // full series
  maxDrawdown: number | null;       // negative
  /** Index of the bar at which maxDrawdown occurs. */
  maxDrawdownIndex: number | null;
  /** Index of the prior peak that maxDrawdown is measured from. */
  peakIndex: number | null;
  /** (a) longest run of bars with drawdown < 0. */
  longestDrawdownBars: number | null;
  /** (c) bars currently below the running peak. 0 if at a new high. */
  currentUnderwaterBars: number;
  /** (b) bars from the pre-drawdown peak to the recovery bar; null if unrecovered. */
  timeToRecoveryBars: number | null;
}
drawdownStats(close): DrawdownStats
```

**Off-by-one warning** `[V-CALC]`: whether the recovery bar (the bar whose close equals the peak
again) counts as "underwater" is a judgement call. Our convention: a bar is underwater iff
`drawdown[t] < 0`, so the recovery bar (`drawdown === 0`) is **not** counted. On dataset A the
longest underwater run is **2 bars**, spanning indices 5–6. An implementation that counts the
recovery bar reports 3 and will fail our test vector.

### 3.9 Recovery factor

```
recoveryFactor = totalReturn / abs(maxDrawdown)
```

- Requires `nBars >= 2` and `maxDrawdown !== 0`. Else `null`.
- **Sign**: we use `totalReturn` (the whole-period return), matching the common definition.
  Some sources use `netProfit` of a trade list instead — see §3.16 for that variant, which is a
  **different input contract** and must not be conflated.

### 3.10 Beta, Jensen's alpha, Treynor ratio, information ratio

All four need a **benchmark return series of the same length**. Align on **timestamp join**, not
positional join — different symbols have different holiday/non-trading days, and positional
joining silently pairs the wrong days.

```ts
export interface BenchmarkOptions {
  /** Benchmark prices, ascending, same trading calendar ideally. */
  benchmark: readonly Bar[] | readonly number[];
  riskFreeRate?: number;
  periodsPerYear?: number;
}
```

If the lengths differ: inner-join on `timestamp`, drop unmatched bars, and **return `null` if
fewer than 3 overlapping observations survive**. Do not pad, forward-fill, or silently
truncate. Report `nOverlapping` in the result so the caller can reject a thin sample.

```
beta      = cov(r_asset, r_bench) / var(r_bench)
             cov and var are SAMPLE (ddof = 1); the ddof cancels in the ratio, but
             use the same convention on both sides regardless.
alpha     = (mean(r_asset) - rfPerPeriod) - beta * (mean(r_bench) - rfPerPeriod)
             // per-period alpha; multiply by periodsPerYear for an annual figure
treynor   = (mean(r_asset) * periodsPerYear - riskFreeRate) / beta
informationRatio = (mean(r_asset - r_bench) * periodsPerYear)
                 / (std(r_asset - r_bench, ddof = 1) * sqrt(periodsPerYear))
```

Edge cases:

| Condition | Result |
|---|---|
| `var(r_bench) === 0` | `beta = null`; `alpha = null`; `treynor = null`; `IR` still defined |
| `beta === 0` (for Treynor) | `treynor = null` |
| `std(r_asset − r_bench) === 0` | `IR = null` |
| `nOverlapping < 3` | all `null` |
| `nOverlapping < 30` | compute, but set `reliable: false` in the result object |

**Beta is unbounded below and above.** `beta < 0` is legal (a genuine negative correlation) and
Treynor is then negative — do not clamp.

**Jensen's alpha sign convention**: we return alpha as a **per-period** fraction in the
`AnnualizedResult` wrapper, and also expose `alphaAnnualized`. Report both; do not guess.

### 3.11 Historical VaR and CVaR / Expected Shortfall

Two conventions in circulation; we state ours explicitly.

**Convention A (return-signed, what we implement):** VaR and CVaR are expressed as **negative
returns** (a loss). `-0.023` means "a 2.3% loss at the 95% level".

**Convention B (loss-signed, what many desks use):** positive loss magnitude, `0.023`. Provide
`varPct`/`cvarPct` accessors returning the positive magnitude so consumers can pick.

```ts
export interface TailRiskOptions {
  confidence?: number;   // default 0.95
  method?: 'simple' | 'log';
}
historicalVaR(returns, { confidence = 0.95 }): number | null
historicalCVaR(returns, { confidence = 0.95 }): number | null
```

**Exact algorithm** — nearest-rank, no interpolation:

```
sort returns ASCENDING: s[0] <= s[1] <= ... <= s[n-1]
k      = floor((1 - confidence) * n)          clamp to [0, n-1]
VaR    = s[k]                                   // a negative number, or 0 for confidence < 1/n
m      = max(1, ceil((1 - confidence) * n))    // count of tail observations
CVaR   = mean(s[0], ..., s[m-1])               // mean of the m worst
```

Requires `n >= 2`. Else `null`.
`confidence <= 0` or `>= 1` → throw `RangeError`.
No interpolation, no parametric (variance-covariance) VaR, no Cornish-Fisher. Those are
different statistics; if wanted they go in separate functions, not as an option here.

**Divergence** `[AMBIG]`: some implementations use `k = ceil((1-c)*n) − 1` for VaR and
`k + 1` observations for CVaR. For most `(n, c)` pairs this yields the identical answer (with
`n = 39, c = 0.95`: our `floor(0.05·39) = 1`; theirs `ceil(1.95) − 1 = 1` — same). It differs
only when `(1−c)·n` is an exact integer. We use `floor` and document it; a port that switches
to `ceil` will differ on exactly those inputs.

### 3.12 Correlation, covariance, and the matrices

```
cov(x, y)   = (1/(n-1)) * Σ (x_t − x̄)(y_t − ȳ)          sample, ddof = 1
var(x)      = cov(x, x)
corr(x, y)  = cov(x, y) / (sqrt(var(x)) * sqrt(var(y)))
```

- Requires `n >= 2`. `var(x) === 0` or `var(y) === 0` → `null`.
- `corr(x, x) === 1` exactly (by construction; guard so floating-point does not give 0.9999999998
  on the diagonal — set the diagonal to exactly `1`).
- `ddof = 1` for covariance. This matches `numpy.cov`/`pandas.DataFrame.cov` defaults. For
  correlation the ddof also cancels.
- Use Welford/§2.5 for the pairwise covariance sum. `numpy.cov` uses a centred two-pass, which
  is stable — do the same.
- Inputs must already be timestamp-aligned (see §3.10).
- NaN propagation: if any bar in the window is `null` after ingest validation fails, the whole
  call throws. There is no pairwise-deletion — for a portfolio matrix that would produce a
  non-PSD matrix and silently corrupt every downstream risk decomposition.

```ts
covarianceMatrix(series: Record<string, readonly Bar[]>): Record<string, Record<string, number | null>>
correlationMatrix(series: Record<string, readonly Bar[]>): Record<string, Record<string, number | null>>
```

- All series must cover the **same aligned timestamps**. Inner-join on timestamp; if any series
  ends up with a different observation count after joining, throw `DataError` — a ragged matrix
  is meaningless.
- Output includes the full square, symmetric, diagonal exactly `1` (correlation) or the series
  variance (covariance).
- Keys are returned in the caller's insertion order, plus a sorted `symbols: string[]` so JSON
  key order is deterministic across engines.

### 3.13 Skewness

**Three estimators exist** `[AMBIG]`. Name them explicitly in the API.

| Name | Formula | `n` required | Used by |
|---|---|---|---|
| **Fisher–Pearson (population / biased)** `g1` | `(1/n)·Σ((x−x̄)/s)^3` with `s` = **population** std (`ddof=0`) | `n >= 2` | Excel `SKEW`, TradingView `ta.skew` |
| **Adjusted Fisher–Pearson** `G1` | `g1 · sqrt(n(n−1)) / (n−2)` | `n >= 3` | `scipy.stats.skew(bias=False)`, `pandas.Series.skew()` |
| **Sample skewness** `b1·b2` | `m₃/m₂^1.5 · sqrt(n(n−1))/(n−2)` with `mₖ` = central moments | `n >= 3` | `scipy.stats.skew(bias=True)` default |

```ts
skewness(returns, { biasCorrected = true } = {}): number | null
```

- Default `biasCorrected = true` (Fisher–Pearson adjusted), matching `pandas.Series.skew()` and
  `scipy` with `bias=False` — i.e. the choice a Python user gets by default.
- `n < 3` when bias-corrected → `null`; `n < 2` otherwise → `null`.
- Uses `m₂`/`m₃` central moments computed with a **shifted** accumulation (§2.5), never
  `E[x³] − 3x̄E[x²] + 2x̄³`.
- `std === 0` (constant series) → `null`.
- Interpretation: `> 0.5` right-skewed, `< −0.5` left-skewed. For PSX equities expect mild
  right skew.

### 3.14 Kurtosis (excess)

| Name | Formula | `n` required | Used by |
|---|---|---|---|
| **Pearson** `β₂` | `m₄ / m₂²` (normal = 3) | `n >= 2` | Excel `KURT` basis |
| **Excess (biased / Fisher)** `g₂` | `((n+1)g₂ − 3(n−1)) / ((n−1)(n−2))` (normal = 0) | `n >= 3` | `scipy.stats.kurtosis(bias=True)`, TradingView |
| **Excess (bias-corrected)** `G₂` | Fisher excess with the `2(n−1)²/((n−3)(n−2))` correction | `n >= 4` | `scipy` default, `pandas.Series.kurt()` |

**We implement and return EXCESS kurtosis (normal = 0)**, bias-corrected, as the default, and
also return `pearson` so nothing is lost.

```ts
export interface Kurtosis {
  /** Bias-corrected excess kurtosis; normal distribution = 0. null if n < 4. */
  excess: number | null;
  /** Uncorrected excess kurtosis (Fisher); normal = 0. null if n < 3. */
  excessUncorrected: number | null;
  /** Pearson beta2; normal = 3. null if n < 2. */
  pearson: number | null;
}
kurtosis(returns): Kurtosis
```

- `std === 0` → all `null`.
- Compute via shifted central moments, not raw powers.
- Interpretation: excess `> 0` fat tails; `> 3` extreme; `< 0` thin tails (common in equity
  returns — the distribution is platykurtic relative to a Gaussian).

### 3.15 Autocorrelation

```
ACF(lag) = cov(r_t, r_{t−lag}) / var(r)      for t = lag .. n−1
```

- `lag` is an integer `>= 1`. `lag === 0` → `1` exactly.
- Requires `n − lag >= 3`. Else `null`.
- `var(r) === 0` → `null`.
- Uses **sample** covariance with `ddof = 1` on the overlapping sub-series
  `[lag..n−1]` vs `[0..n−1−lag]` — i.e. the denominator uses the OVERLAP length, not `n`. Using
  `n` in the denominator is a common bug that biases ACF toward zero; do not do it.
- Interpretation: `ACF(1) > 0` positive serial correlation (momentum/trend persistence);
  `ACF(1) < 0` mean reversion at lag 1. PSX daily closes typically show mild positive ACF(1).
- Optional significance band: `±1.96/sqrt(n)`. Provide `isSignificant` rather than asserting.

### 3.16 Win rate and profit/loss ratio — DIFFERENT INPUT CONTRACT

**These two take a list of TRADES, not OHLCV.** This is a deliberate API split and must be
enforced by types, not by documentation.

```ts
export interface Trade {
  /** Side. Long or short. Short PnL must already be sign-adjusted by the caller,
   *  OR supply `side` and let the function handle it. We require `side` and handle it. */
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  /** Optional. If omitted, quantity is 1. */
  quantity?: number;
  /** Optional fees in price-per-unit terms (commission + slippage). */
  feesPerUnit?: number;
  /** Entry timestamp (ms) — used only for `tradesPerMonth`, not for the ratios. */
  entryTime?: number;
  exitTime?: number;
}

winRate(trades: readonly Trade[]): number | null
profitLossRatio(trades: readonly Trade[]): number | null
```

**PnL per trade:**

```
pnl_i = (exitPrice_i − entryPrice_i) * quantity_i * (side_i === 'long' ? 1 : −1)
        − feesPerUnit_i * quantity_i
```

Default `quantity = 1`, `feesPerUnit = 0`.

**Win rate:**

```
winRate = count(pnl_i > 0) / count(pnl_i != 0)
```

- Returns a fraction in `[0, 1]`.
- **Breakeven trades (`pnl === 0`) are excluded from BOTH numerator and denominator.** This is
  the correct convention; including them in the denominator deflates win rate.
- If no trade has `pnl != 0` (all breakeven, or empty) → `null`.

**Profit/loss ratio (average win ÷ average loss):**

```
grossProfits = Σ pnl_i where pnl_i > 0
grossLosses  = Σ |pnl_i| where pnl_i < 0
avgWin       = grossProfits / count(pnl_i > 0)
avgLoss      = grossLosses  / count(pnl_i < 0)
profitLossRatio = avgWin / avgLoss
```

- Requires `count(wins) >= 1` AND `count(losses) >= 1`. Otherwise `null`.
  - All winners → `null` (undefined: infinite ratio). **Do not return `Infinity`.**
  - All losers → `null`.
- Note: this is the **average win ÷ average loss** definition, which is what `pypsx_toolkit`'s
  stub says: *"Average profit of winning trades / average loss of losing trades."*
- **Divergence** `[AMBIG]`: some platforms report the **gross profit ÷ gross loss** ratio (total
  dollars in ÷ total dollars out). Same numerator and denominator but not divided by counts.
  For a trade list where win sizes are consistent these coincide; when they are not they differ.
  Provide both: `profitLossRatio()` (average, the default) and `grossProfitLossRatio()`.

**Expectancy** (useful, and the reason the input split exists):

```
expectancy = mean(pnl)
profitFactor = grossProfits / grossLosses      // null if grossLosses === 0
```

### 3.17 Performance summary

```ts
performanceSummary(bars: readonly Bar[], opts?: {
  riskFreeRate?: number; periodsPerYear?: number; minYears?: number;
}): PerformanceSummary
```

Returns a flat object: `{ totalReturn, cumulativeReturns (series), cagr, yearsElapsed,
annualizedVolatility, sharpe, sortino, calmar, maxDrawdown, drawdown, drawdownDuration,
recoveryFactor, bestDay, worstDay, positiveDayPct, nBars, firstTimestamp, lastTimestamp }`.

- `bestDay` / `worstDay` = max / min simple return.
- `positiveDayPct` = `count(r > 0) / count(r != 0)`.
- Every field is `number | null` per §2.1.
- Every field carries the same `periodsPerYear` from `opts`. Record it in the output as
  `periodsPerYear` so a consumer can never misread a number.

---

## 4. Part 2 — Technical indicators

### 4.1 Moving averages

#### 4.1.1 SMA

```
sma_t = (1/n) · Σ_{i=0}^{n−1} x_{t−i}
```

- Warmup: `n − 1` leading `null`s. `n >= 1`; `n === 1` returns a copy of the input.
- Accumulate with a **rolling sum**: add `x[t]`, subtract `x[t−n]` when `t >= n`. Do **not**
  recompute the full window per bar (O(n·w)); that is both slow and, with a naive
  running sum of large prices, drifts.
- Floating-point drift: a plain running sum of ~250 values around 500 accumulates ~1e-13
  relative error. Acceptable. If a test needs exactness, compute the window sum fresh
  (O(n·w)) in test builds.
- `SMA(close, 20)` on dataset A is impossible (15 bars) → 20 leading `null`s would be the whole
  array; per §2.2 all-`null` output for insufficient input is `null[]`. See §6.

**Test vector** — Dataset A closes, `n = 5` `[V-TULIP]`:

```
close = [81.59, 81.06, 82.87, 83.00, 83.61, 83.15, 82.84, 83.99, 84.55, 84.36,
         85.53, 86.54, 86.89, 87.77, 87.29]

sma5 = [null, null, null, null,
        82.426000, 82.738000, 83.094000, 83.318000, 83.628000, 83.778000,
        84.254000, 84.994000, 85.574000, 86.218000, 86.804000]
```

Arithmetic, index 4:

```
(81.59 + 81.06 + 82.87 + 83.00 + 83.61) / 5
  = (81.59 + 81.06) + (82.87 + 83.00) + 83.61 = 162.65 + 165.87 + 83.61
  = 412.13 / 5
  = 82.426000                                                            OK
```

Index 5 (the window slides by one — `81.59` leaves, `83.15` enters):

```
(81.06 + 82.87 + 83.00 + 83.61 + 83.15) / 5
  = 413.69 / 5
  = 82.738000                                                            OK
```

Reproduces tulip's published table (`82.43, 82.74, 83.09, 83.32, 83.63, 83.78, 84.25, 84.99,
85.57, 86.22, 86.80`). `[V-TULIP]`

#### 4.1.2 EMA — the seeding question

```
alpha = 2 / (n + 1)
ema_t = alpha·x_t + (1 − alpha)·ema_{t−1}
```

**Two mutually incompatible seeds exist** `[AMBIG]`:

| Seed | Definition | First output | Users |
|---|---|---|---|
| **A. SMA seed** (`adjust=False` in pandas) | `ema_{n−1} = SMA(x[0..n−1])`; recurse from `n` | index `n−1` | **TA-Lib** `[V-TALIB]`, **npm `technicalindicators`** `[V-NPM]`, pandas `ewm(span=n, adjust=False)`, **most trading platforms** |
| **B. First-value seed** | `ema_0 = x_0`; recurse from `1` | index `0` | **tulip / tulipy** `[V-TULIP]`, tulipindicators.org, some Excel ports |

**Evidence for A (TA-Lib), read from source** `[V-TALIB]` (`ta_EMA.c`):
```
optInK_1 = 2.0 / (double)(optInTimePeriod + 1);
...
while( i-- > 0 )  { tempReal += inReal[today++]; }
prevMA = tempReal / optInTimePeriod;      /* <-- SMA of the first `period` inputs */
while( today <= startIdx ) { prevMA = fma(inReal[today++] - prevMA, optInK_1, prevMA); }
outReal[0] = prevMA;
```
with `TA_EMA_Lookback(n) = n − 1`.

**Evidence for B (tulip)**, tulipindicators.org/ema: *"The calculation is started by simply
setting the first ema output to the first input."* with `ti_ema_start() = 0`. `[V-TULIP]`

**Evidence for A (npm technicalindicators)** `[V-NPM]` — the generator explicitly primes from
an SMA before switching to the recursion:
```js
prevEma = sma.nextValue(tick);            // SMA of the first `period` ticks
prevEma = ((tick - prevEma) * exponent) + prevEma;
```

**Our choice: seed A (SMA seed), first output at index `n − 1`.** Rationale: A matches TA-Lib,
which is the reference implementation of Wilder-adjacent indicators and the one most Python
and JS users benchmark against; it matches the npm `technicalindicators` package, which is the
closest JS analogue; and it is the mathematically better-behaved seed (lower transient bias).

```ts
ema(source: readonly number[], n: number): (number | null)[]
```

- Warmup: `n − 1`. `n === 1` → returns a copy of the input.
- **Recursion order matters for bit-exactness.** Use `prev + alpha * (x − prev)`, not
  `(1−alpha)·prev + alpha·x`. These differ in the last ULP. TA-Lib uses the first form; match it.
- `alpha = 2/(n+1)`, computed once.
- Do **not** use `Number.EPSILON`-style clamping.

**Test vector** — Dataset A, `n = 5`. `alpha = 2/6 = 0.3333333333333333`

Seed A (our default) `[V-CALC]`:
```
ema5(A) = [null, null, null, null,
           82.426000, 82.667333, 82.724889, 83.146593, 83.614395, 83.862930,
           84.418620, 85.125747, 85.713831, 86.399221, 86.696147]
```
Arithmetic: seed `= (81.59 + 81.06 + 82.87 + 83.00 + 83.61)/5 = 412.13/5 = 82.426000` at
index 4. Then
`ema[5] = 82.426 + (1/3)(83.15 − 82.426) = 82.426 + 0.241333 = 82.667333` ✔
`ema[6] = 82.667333 + (1/3)(82.84 − 82.667333) = 82.667333 + 0.057556 = 82.724889` ✔

Seed B (tulip), independently verified against the published table `[V-TULIP]`:
```
ema5(B) = [81.5900, 81.4133, 81.8989, 82.2659, 82.7140, 82.8593, 82.8529,
           83.2319, 83.6713, 83.9008, 84.4439, 85.1426, 85.7251, 86.4067, 86.7011]
```
Arithmetic: `ema[0] = 81.59`; `ema[1] = 81.59 + (1/3)(81.06 − 81.59) = 81.59 − 0.176667 =
81.413333` ✔; `ema[2] = 81.413333 + (1/3)(82.87 − 81.413333) = 81.413333 + 0.485556 =
81.898889` ✔

> The two vectors differ from index 5 onward by up to ~1.0 (0.24% of price). Any
> cross-library comparison that mixes these seeds will disagree and is **not** a bug in either.

#### 4.1.3 WMA

```
wma_t = Σ_{i=0}^{n−1} (i+1)·x_{t−n+1+i} / Σ_{i=1}^{n} i
      = Σ_{i=0}^{n−1} (i+1)·x_{t−n+1+i} / (n(n+1)/2)
```

Newest bar gets weight `n`, oldest weight `1`. Warmup `n − 1`.

**Test vector** — Dataset A, `n = 5` `[V-TULIP]` (weights 1..5, denominator 15):
```
wma5 = [null, null, null, null,
        82.824667, 83.066000, 83.100000, 83.398667, 83.809333, 84.053333,
        84.637333, 85.399333, 86.031333, 86.763333, 87.120667]
```
Arithmetic index 4: `(1·81.59 + 2·81.06 + 3·82.87 + 4·83.00 + 5·83.61) / 15
= (81.59 + 162.12 + 248.61 + 332.00 + 418.05)/15 = 1242.37/15 = 82.824667`. ✔

#### 4.1.4 DEMA, TEMA, HMA

```
DEMA(n)  = 2·EMA_n(x) − EMA_n(EMA_n(x))
TEMA(n)  = 3·EMA_n(x) − 3·EMA_n(EMA_n(x)) + EMA_n(EMA_n(EMA_n(x)))
HMA(n)   = WMA_{floor(sqrt n)} ( 2·WMA_{floor(n/2)}(x) − WMA_n(x) )
```

- Each EMA layer uses **seed A** (SMA seed), and the second/third layer's own SMA seed is taken
  over the **first n non-null values of the previous layer** (equivalently input indices
  `n−1 … 2n−2`), not over raw indices `0 … n−1` of a null-padded array. Getting this wrong is the
  classic DEMA bug — summing `null` as `0` yields values off by ~100%.
- Warmups: `DEMA(n)` → `2n − 2`; `TEMA(n)` → `3n − 3`; `HMA(n)` → `n + floor(sqrt n) − 2`.
- `n` is clamped to `>= 4` for HMA (`floor(n/2) >= 2` and `floor(sqrt n) >= 2`).
- `n < 2` for DEMA/TEMA → `RangeError`.

**Test vectors** — Dataset A `[V-CALC]`:
```
dema5 (warmup 8) = [null×8, 84.312948, 84.494322, 85.210008, 86.124756, 86.771894,
                       87.561522, 87.668966]
tema5 (warmup 12)= [null×12, 86.885612, 87.706827, 87.639514]
hma5  (warmup 4) = [null×4, 83.690000, 83.038000, 83.472000, 84.549778, 84.834667,
                    85.359556, 86.552444, 87.346000, 87.965111, 87.916222]
```
And on Dataset B, `dema20` warmup is `2·20 − 2 = 38` (only indices 38–39 have values);
`tema20` warmup is `3·20 − 3 = 57` (no values in 40 bars). This is expected, not a bug.

#### 4.1.5 Bollinger Bands

```
mid_t   = SMA_n(x)
sd_t    = sqrt( (1/n) · Σ_{i=0}^{n−1} (x_{t−i} − mid_t)² )        <-- POPULATION (ddof = 0)
upper_t = mid_t + k·sd_t
lower_t = mid_t − k·sd_t
```

- Defaults `n = 20`, `k = 2`.
- Warmup `n − 1`.
- `sd` uses **population** variance (`ddof = 0`, divisor `n`). This matches TA-Lib
  (`ta_STDDEV.c` → `ta_VAR.c`, which divides by `period`) `[V-TALIB]`, tulip
  (published formula is `(1/n)·Σ(...)²`) `[V-TULIP]`, and npm `technicalindicators`
  (`Math.sqrt(sum / period)`) `[V-NPM]`.
- **Divergence** `[AMBIG]`: pandas `df.rolling(n).std()` defaults to **`ddof = 1`** (sample).
  Python users comparing against `ta.volatility` / `bbands` will see a ~4% band-width
  difference at `n = 20` (`sqrt(20/19) = 1.02598`). **Always pass `ddof=0` when porting pandas
  code.** Document this in the function's docstring.

**Tuple ordering** — this is a genuine API hazard:

```ts
export interface BollingerBands {
  upper: (number | null)[];   // mid + k*sd
  middle: (number | null)[];  // SMA
  lower: (number | null)[];   // mid - k*sd
  /** true when close <= lower */
  squeeze?: boolean;
}
bollingerBands(close, { period = 20, stdDev = 2 } = {}): BollingerBands
```

**We return a named object, not a tuple.** The `pypsx_toolkit` stub returns
`(upper, middle, lower)` `[see analysis/__init__.pyi:98–109]`, while many JS examples return
`(middle, upper, lower)`. Positionally mismatched tuples are the most common Bollinger bug in
the wild. Our object makes the order irrelevant; if a tuple shim is needed it must be
`(upper, middle, lower)` to match the reference stub.

**Test vector** — Dataset A, `n = 5`, `k = 2` `[V-TULIP]`:
```
upper = [null×4, 84.321958, 84.488858, 83.654657, 84.164017, 84.838250, 85.120797,
              85.996669, 86.845382, 87.611512, 88.565676, 88.319129]
middle= [null×4, 82.426000, 82.738000, 83.094000, 83.318000, 83.628000, 83.778000,
              84.254000, 84.994000, 85.574000, 86.218000, 86.804000]
lower = [null×4, 80.530042, 80.987142, 82.533343, 82.471983, 82.417750, 82.435203,
              82.511331, 83.142618, 83.536488, 83.870324, 85.288871]
```
Arithmetic index 4: `mid = 82.426`; deviations
`81.59−82.426 = −0.836`, `81.06−82.426 = −1.366`, `82.87−82.426 = 0.444`,
`83.00−82.426 = 0.574`, `83.61−82.426 = 1.184`.
Squares: `0.698896 + 1.865956 + 0.197136 + 0.329476 + 1.401856 = 4.493320`.
`sd = sqrt(4.493320/5) = sqrt(0.898664) = 0.947979`. `2·sd = 1.895958`.
`upper = 82.426 + 1.895958 = 84.321958`. ✔ `lower = 82.426 − 1.895958 = 80.530042`. ✔

### 4.2 Donchian channels

```
upper_t = max(high[t−n+1 .. t])
lower_t = min(low [t−n+1 .. t])
mid_t   = (upper_t + lower_t) / 2
```

- Default `n = 20`. Window **includes the current bar** (matches TA-Lib's Aroon convention,
  §4.11, and tulip's channel convention).
- Warmup `n − 1`.
- `upper === lower` (flat market): no breakout can occur; the channel is still returned.
- Breakout signal: `close[t] > upper[t−1]` (channel **excluding** the current bar, otherwise a
  new high can never exceed its own channel). This off-by-one is universal.

**Test vector** — Dataset A, `n = 10` `[V-CALC]`, indices 9–14:
```
upper = [85.0000, 85.9000, 86.5800, 86.9800, 88.0000, 88.0000]
lower = [80.6400, 80.6400, 81.3100, 82.3000, 82.3000, 82.3000]
```

### 4.3 ATR — the true-range seed question

```
TR_t = max( high_t − low_t,  |high_t − close_{t−1}|,  |low_t − close_{t−1}| )
ATR_t = ( (n−1)·ATR_{t−1} + TR_t ) / n                Wilder smoothing
```

**Two TR conventions** `[AMBIG]`:

| | TR at bar 0 | First ATR output | Requires |
|---|---|---|---|
| **A. Wilder / TA-Lib** (our default) | `undefined` (no prior close) | index `n` | `n + 1` bars |
| **B. Wilder's book / tulip** | `high[0] − low[0]` | index `n − 1` | `n` bars |

- **Evidence for A (TA-Lib)** `[V-TALIB]`: `TA_ATR_Lookback(n) = n`; the core reads
  `prevClose = close[0]` then loops `for(i = n; i > 0; i--) { ... }` reading bars `1..n`, i.e.
  it consumes `TR[1..n]` and emits at index `n`.
- **Evidence for B (tulip)** `[V-TULIP]`: tulipindicators.org/atr gives `ti_atr_start = period`
  and its published `n = 5` table's first ATR (1.12) lands on bar index 4, which requires
  `TR[0] = high[0] − low[0] = 82.15 − 81.29 = 0.86`. Sum of `TR[0..4] =
  0.86 + 1.25 + 1.97 + 0.65 + 0.85 = 5.58`, `/5 = 1.116` → `1.12`. ✔
- Wilder's *book* does say "the True Range for the first day is simply High minus Low", so B is
  arguably more faithful to the text; but TA-Lib (A) is the dominant implementation.

**Our choice: A** (`TR_1` is the first true range; first ATR at index `n`).

```ts
atr(bars: readonly Bar[], n = 14): (number | null)[]
```

- Warmup `n` leading `null`s.
- `n >= 2`. `n === 1` → ATR equals TR, warmup 1.
- Seed: `ATR_n = (Σ_{k=1..n} TR_k) / n` — a **simple average of the first n true ranges**, i.e.
  a special case of Wilder smoothing with `ATR_0 = 0`.
- `high < low` in any bar → `DataError` (caught at ingest).

**Test vector A (our default) — Dataset A, `n = 5`** `[V-CALC]`:

```
TR   = [null, 1.2500, 1.9700, 0.6500, 0.8500, 0.7900, 0.8400, 2.0000, 0.8500, 0.8900,
        1.8700, 1.1900, 1.2200, 1.1100, 0.8600]

ATR5 = [null, null, null, null, null,
        1.102000, 1.049600, 1.239680, 1.161744, 1.107395, 1.259916, 1.245933,
        1.240746, 1.214597, 1.143678]
```

**Arithmetic — TR derivation, bar by bar.** `close[i-1]` is the prior close; the middle
column is frequently larger than the intrabar range, which is the whole point of the true range.

| i | high | low | close | `high-low` | `\|high-close[i-1]\|` | `\|low-close[i-1]\|` | `TR` |
|---|---|---|---|---|---|---|---|
| 0 | 82.15 | 81.29 | 81.59 | 0.86 | — | — | **null** |
| 1 | 81.89 | 80.64 | 81.06 | 1.25 | 0.30 | 0.95 | **1.25** |
| 2 | 83.03 | 81.31 | 82.87 | 1.72 | **1.97** | 1.56 | **1.97** |
| 3 | 83.30 | 82.65 | 83.00 | 0.65 | 0.13 | 0.65 | **0.65** |
| 4 | 83.85 | 83.07 | 83.61 | 0.78 | **0.85** | 0.54 | **0.85** |
| 5 | 83.90 | 83.11 | 83.15 | 0.79 | 0.29 | 0.50 | **0.79** |
| 6 | 83.33 | 82.49 | 82.84 | 0.84 | 0.18 | 0.66 | **0.84** |
| 7 | 84.30 | 82.30 | 83.99 | 2.00 | 0.31 | 1.69 | **2.00** |
| 8 | 84.84 | 84.15 | 84.55 | 0.69 | **0.85** | 0.16 | **0.85** |
| 9 | 85.00 | 84.11 | 84.36 | 0.89 | 0.45 | 0.44 | **0.89** |
| 10 | 85.90 | 84.03 | 85.53 | 1.87 | 1.54 | 0.33 | **1.87** |
| 11 | 86.58 | 85.39 | 86.54 | 1.19 | 1.05 | 0.14 | **1.19** |
| 12 | 86.98 | 85.76 | 86.89 | 1.22 | 0.44 | 0.78 | **1.22** |
| 13 | 88.00 | 87.17 | 87.77 | 0.83 | **1.11** | 0.28 | **1.11** |
| 14 | 87.87 | 87.01 | 87.29 | 0.86 | 0.10 | 0.76 | **0.86** |

Spot-checks of the three non-obvious bars:

```
i = 2:  |83.03 - 82.87| = 0.16 ; |81.31 - 82.87| = 1.56 ; 83.03 - 81.31 = 1.72
        max(1.72, 0.16, 1.56) = 1.72            <-- range wins, TR = 1.72
        BUT |83.03 - close[1]| = |83.03 - 81.06| = 1.97
        max(1.72, 1.97, 1.56) = 1.97            <-- gap-up, TR = 1.97  OK
i = 4:  83.85 - 83.07 = 0.78 ; |83.85 - 83.00| = 0.85 ; |83.07 - 83.00| = 0.07
        max(0.78, 0.85, 0.07) = 0.85             OK
i = 8:  84.84 - 84.15 = 0.69 ; |84.84 - 83.99| = 0.85 ; |84.15 - 83.99| = 0.16
        max(0.69, 0.85, 0.16) = 0.85             OK
```

**Arithmetic — Wilder smoothing.** Seed is the simple average of the first `n` true ranges:

```
ATR_5 = (1.25 + 1.97 + 0.65 + 0.85 + 0.79) / 5 = 5.51 / 5 = 1.102000
ATR_t = ( (t-1) * ATR_{t-1} + TR_t ) / t

ATR_6 = (4 * 1.102000 + 0.84) / 5 = (4.408000 + 0.84) / 5 = 1.049600
ATR_7 = (4 * 1.049600 + 2.00) / 5 = (4.198400 + 2.00) / 5 = 1.239680
ATR_8 = (4 * 1.239680 + 0.85) / 5 = (4.958720 + 0.85) / 5 = 1.161744
ATR_9 = (4 * 1.161744 + 0.89) / 5 = (4.646976 + 0.89) / 5 = 1.1073952   OK
```

This is the **authoritative ATR regression fixture.** It is internally consistent at every step
and satisfies the documented recursion.

**Test vector B (tulip seeding, `TR_0 = high[0] - low[0] = 0.8600`, warmup `n - 1 = 4`)** `[V-TULIP]`:

```
ATR5_B = [null, null, null, null,
          1.116000, 1.050800, 1.008640, 1.206912, 1.135530, 1.086424, 1.243139,
          1.232511, 1.230009, 1.206007, 1.136806]
```

Arithmetic: `ATR_4 = (0.86 + 1.25 + 1.97 + 0.65 + 0.85)/5 = 5.58/5 = 1.116000`.
This reproduces tulip's published table (`1.12, 1.05, 1.01, 1.21, 1.14, 1.24, 1.23, 1.23,
1.21, 1.14`) to two decimals, which independently confirms that tulip seeds `TR` at index 0 with
`high[0] - low[0]` and emits its first ATR at index `n - 1`.

Note that vector B is **not** vector A shifted by one bar. The two windows overlap in only four
of five TRs, so values differ in the third decimal. Implement both if you offer both seeds, and
label which one a consumer is getting.

**Convention A on Dataset B, `n = 14`** `[V-CALC]` — the fixture to use for ADX:

```
TR    = [null, 4.2000, 3.3800, 2.4500, 2.0500, 2.6200, 2.6300, 1.7500, 3.5500, 4.4700,
          3.9200, 3.5300, 2.6700, 2.1600, 2.1900, 2.5000, 2.3700, 3.6800, 4.3000, 4.1900,
          3.5600, 1.9000, 2.4500, 2.7700, 2.0100, 2.3200, 3.6900, 4.0500, 4.3900, 3.4600,
          2.1800, 2.3600, 2.3800, 2.2900, 2.6100, 3.5700, 4.1600, 4.4700, 3.2400, 2.1900]

ATR14 = [null x14,
         2.969286, 2.935765, 2.895353, 2.951400, 3.047728, 3.129319, 3.160082, 3.070076,
         3.025785, 3.007515, 2.936264, 2.892245, 2.949227, 3.027854, 3.125150, 3.149068,
         3.079849, 3.028431, 2.982115, 2.932678, 2.909629, 2.956799, 3.042742, 3.144689,
         3.151497, 3.082818]
```

```
ATR_14 = (4.20+3.38+2.45+2.05+2.62+2.63+1.75+3.55+4.47+3.92+3.53+2.67+2.16+2.19) / 14
       = 41.57 / 14 = 2.969286                                                    OK
ATR_15 = (13 * 2.969286 + 2.50) / 14 = (38.600718 + 2.50) / 14 = 2.9357651         OK
```

### 4.4 Keltner Channels

**Three historically distinct definitions exist** `[AMBIG]`. This is one of the most
frequently mis-implemented indicators because people conflate them.

| Variant | Definition | Notes |
|---|---|---|
| **Original (Chester Keltner, 1960s)** | `middle = SMA_10(typical price)`, bands at `SMA_10 +/- 10% of SMA_10`; some versions use SMA_20 with 10% | A 10% constant, not an ATR multiple. Rarely implemented today. |
| **Modern / standard (most platforms)** | `middle = EMA_20(close)`, `upper = EMA_20 + 2*ATR_10`, `lower = EMA_20 - 2*ATR_10` | TradingView, StockCharts, QuantConnect, `pandas_ta.keltner`. **This is what we implement.** |
| Linda Raschke variant | `EMA_20 +/- 1.5*ATR_10` with a 2-period EMA first-stage smoothing | Occasionally seen. |

```ts
export interface KeltnerChannel {
  upper: (number | null)[];
  middle: (number | null)[];   // EMA of close
  lower: (number | null)[];
}
keltnerChannel(bars, {
  emaPeriod = 20, atrPeriod = 10, multiplier = 2.0, emaSeed = 'sma'
} = {}): KeltnerChannel
```

- `emaSeed`: `'sma'` (default, matches §4.1.2 seed A and TA-Lib) or `'first'` (tulip).
- Warmup = `max(emaPeriod - 1, atrPeriod)`. For the defaults that is `19`; the ATR's warmup is
  `10` so the EMA dominates.
- `atrPeriod === emaPeriod` gives warmup `emaPeriod - 1`; unequal periods use the max.
- No zero-denominator risk; no division occurs.
- **Trend indicator, not a volatility channel.** Keltner is *narrow* in a trend and *wide* in a
  range; Bollinger is the opposite. Do not treat them interchangeably.

**Test vector** — Dataset B, defaults `[V-CALC]`:
```
middle = [null x19, 111.5030, 112.9760, 114.3821, 115.6134, 116.6454, 117.5497, 118.4564,
          119.4977, 120.7407, 122.1607, 123.6482, 125.0636, 126.3014, 127.3403, 128.2517,
          129.1687, 130.2221, 131.4772, 132.9060, 134.3988, 135.8160]
upper  = [null x19, 117.8359, 119.3876, 120.5325, 121.6387, 122.6223, 123.3308, 124.1234,
          125.3360, 126.8052, 128.4967, 130.0427, 131.2546, 132.3453, 133.2558, 134.0337,
          134.8944, 136.0893, 137.5896, 139.3012, 140.8025, 142.0174]
lower  = [null x19, 105.1701, 106.5645, 108.2317, 109.5880, 110.6686, 111.7685, 112.7893,
          113.6593, 114.6762, 115.8246, 117.2538, 118.8726, 120.2575, 121.4248, 122.4697,
          123.4429, 124.3550, 125.3647, 126.5108, 127.9951, 129.6147]
```
Spot check index 19: `EMA20[19] = 111.5030`, `ATR10[19] = 3.16645`;
`upper = 111.5030 + 2*3.16645 = 117.8359`. OK

### 4.5 RSI

```
gain_t = max(close_t - close_{t-1}, 0)
loss_t = max(close_{t-1} - close_t, 0)

Wilder smoothing:  avg_t = ( (n-1) * avg_{t-1} + value_t ) / n

RS = avgGain / avgLoss
RSI = 100 - 100/(1 + RS)          ==        100 * avgGain / (avgGain + avgLoss)
```

The second form is algebraically identical and is what TA-Lib uses `[V-TALIB]`. It avoids one
division and one `1/avgLoss` overflow for very small `avgLoss`. **We use the second form.**

- Default `n = 14`. `n >= 2`.
- Warmup: **`n`** leading `null`s. First output at index `n`, requiring `n + 1` bars. This is
  what both TA-Lib (`TA_RSI_Lookback(n) = n`) and tulip (`ti_rsi_start = period`) do. `[V-*]`
- **Seeding** `[V-TALIB]`: `avgGain_n = (Σ_{i=1..n} gain_i)/n`, `avgLoss_n = (Σ loss_i)/n` — a
  simple average of the first `n` gains and losses, equivalently a special case of the Wilder
  recursion started from zero. Then recurse.
- **`avgGain + avgLoss === 0`** (a completely flat window) -> `null`. Not `0`, not `50`. See the
  TA-Lib issue note below.
- Output range `[0, 100]` inclusive; `RSI = 100` when `avgLoss = 0` and `avgGain > 0`;
  `RSI = 0` when `avgGain = 0` and `avgLoss > 0`.

**Divergences** `[V-NPM]`:
- npm `technicalindicators` checks `lastAvgLoss === 0` **first** and returns `100`, then
  `lastAvgGain === 0` returns `0`. On a fully flat window (both zero) it returns **100**; our
  formula returns `null` and TA-Lib returns **0**. Three different answers for the same input.
  We pick `null` per §2.4 and document it.
- npm `technicalindicators` rounds to 2 decimals internally. We do not (§2.8).
- **Cutler's RSI** (Tushar Chande) is a genuinely different indicator: a simple (not Wilder)
  moving average of gains and losses, giving a fast, noisy oscillator. It is **not** a variant of
  Wilder's RSI and must be a separate function, not an option.

**Interpretation** (convention): `> 70` overbought, `< 30` oversold, `50` neutral. Wilder's
own caution: in a strong trend RSI can sit above 70 or below 30 indefinitely; treat those as
"strong", not "about to reverse".

**Test vector** — Dataset A, `n = 5` `[V-TULIP]`:

```
RSI5 = [null, null, null, null, null,
        72.0339, 64.9268, 75.9362, 79.7965, 74.7134, 83.0329, 87.4783, 88.7545,
        91.4829, 78.4978]
```
Reproduces the published table (`72.03, 64.93, 75.94, 79.80, 74.71, 83.03, 87.48, 88.75,
91.48, 78.50`). `[V-TULIP]`

**Arithmetic, RSI at index 5** (`n = 5`, five returns from bars 1..5):

```
close  = 81.59, 81.06, 82.87, 83.00, 83.61, 83.15
gains  = [ -,  0,  1.81, 0.13, 0.61, 0    ]   (close[0] has no prior -> not counted)
losses = [ -,  0.53, 0, 0, 0, 0.46        ]

avgGain_5 = (0 + 1.81 + 0.13 + 0.61 + 0) / 5 = 2.55 / 5 = 0.510
avgLoss_5 = (0.53 + 0 + 0 + 0 + 0.46) / 5 = 0.99 / 5 = 0.198

RS_5 = 0.510 / 0.198 = 2.575757...
RSI_5 = 100 - 100/(1 + 2.575757) = 100 - 27.9661 = 72.0339      OK
```
Equivalent form: `100 * 0.510 / (0.510 + 0.198) = 100 * 0.510 / 0.708 = 72.0339`. OK

Next step, index 6 (`n = 5`):

```
close[6] = 82.84 ; delta = 82.84 - 83.15 = -0.31 -> gain 0, loss 0.31
avgGain_6 = (4 * 0.510 + 0) / 5 = 2.040 / 5 = 0.408
avgLoss_6 = (4 * 0.198 + 0.31) / 5 = (0.792 + 0.31) / 5 = 1.102 / 5 = 0.2204
RSI_6 = 100 * 0.408 / (0.408 + 0.2204) = 40.8 / 0.6284 = 64.9268   OK
```

TA-Lib note worth copying verbatim into a code comment `[V-TALIB]`: `prevGain + prevLoss` is a
sum of non-negative magnitudes, so it is zero only when every change since the seed was exactly
zero — test it *exactly*, never against a fixed `TA_IS_ZERO` band, because a gain carries the
quote unit and a constant band zeroes the oscillator for any instrument quoted below it
(TA-Lib issue #253).

### 4.6 Stochastic Oscillator

```
rawK_t  = 100 * (close_t - lowestLow(n)) / (highestHigh(n) - lowestLow(n))
fast%K   = rawK
slow%K   = SMA_m(fast%K)                m = 3 by default
%D        = SMA_p(slow%K)               p = 3 by default
```

```ts
export interface Stochastic {
  /** Unsmoothed %K, period `kPeriod` only. Warmup kPeriod-1. */
  fastK: (number | null)[];
  /** SMA_m(fastK). Warmup (kPeriod-1) + (m-1) = kPeriod + m - 2. */
  slowK: (number | null)[];
  /** SMA_p(slowK). Warmup kPeriod + m + p - 3. */
  percentD: (number | null)[];
}
stochastic(bars, { kPeriod = 14, slowingK = 3, dPeriod = 3 } = {}): Stochastic
```

- Window `high[t-n+1 .. t]` and `low[t-n+1 .. t]`, **including the current bar** (matches TA-Lib
  and tulip). `[V-*]`
- `highestHigh === lowestLow` (flat range) -> `null` for that bar (§2.4). Do not return `50`.
- Slowing MA type: **SMA**, matching the tulip formula and TA-Lib's default `TA_MAType_SMA`.
  Expose `{ maType: 'sma' | 'ema' }` for users who want EMA smoothing; default `'sma'`.
- Warmups: with `kPeriod = 14, slowingK = 3, dPeriod = 3`, slow `%K` starts at index 15 and
  `%D` at index 16.
- **Crossover comparisons must use consecutive, non-null values.** Comparing `%K[t]` with `%D[t-1]`
  is a different (and noisier) rule. State which you implement.

**Interpretation**: `%K`/`%D` above 80 = overbought zone, below 20 = oversold zone. Crossover of
`%K` above `%D` from below 20 is the classic (George Lane) buy.

**Test vector** — Dataset A, `kPeriod = 5, slowingK = 3, dPeriod = 3` `[V-TULIP]`:
```
fastK  = [null x4,  92.523364, 76.993865, 59.073359, 84.500000, 88.582677, 76.296296,
           89.722222, 99.065421, 96.949153, 94.206549, 82.115869]
slowK  = [null x6,  76.196863, 73.522408, 77.385345, 83.126324, 84.867065, 88.361313,
           95.245598, 96.740374, 91.090524]
%D     = [null x8,  75.701539, 78.011359, 81.792912, 85.451568, 89.491326, 93.449095,
           94.358832]
```
Reproduces the published table (`%K = 77.39, 83.13, 84.87, 88.36, 95.25, 96.74, 91.09`;
`%D = 75.70, 78.01, 81.79, 85.45, 89.49, 93.45, 94.36`). `[V-TULIP]`

Arithmetic, `fastK[4]`:

```
window = bars 0..4
highestHigh = max(82.15, 81.89, 83.03, 83.30, 83.85) = 83.85
lowestLow   = min(81.29, 80.64, 81.31, 82.65, 83.07) = 80.64
fastK[4]    = 100 * (83.61 - 80.64) / (83.85 - 80.64)
            = 100 * 2.97 / 3.21 = 92.5234      OK
```
And `slowK[6] = (92.523364 + 76.993865 + 59.073359)/3 = 228.590588/3 = 76.196863`. OK

### 4.7 Williams %R

```
%R_t = -100 * (highestHigh(n) - close_t) / (highestHigh(n) - lowestLow(n))
```

- Identical window to Stochastic `%K`; in fact `%R = fast%K - 100`. Provide a fast path for that.
- Range `[-100, 0]`. Warmup `n - 1`.
- `highestHigh === lowestLow` -> `null`.
- `>= -80` overbought, `<= -20` oversold (standard zones).

**Test vector** — Dataset A, `n = 5` `[V-TULIP]`:
```
%R = [null x4, -7.4766, -23.0061, -40.9266, -15.5000, -11.4173, -23.7037,
      -10.2778,  -0.9346,  -3.0508,  -5.7935, -17.8841]
```
`-100 * (83.85 - 83.61)/(83.85 - 80.64) = -100 * 0.24/3.21 = -7.4766`. OK

### 4.8 CCI

```
typicalPrice_t = (high_t + low_t + close_t) / 3
atp_t          = SMA_n(typicalPrice)
meanDev_t      = (1/n) * SUM_{i=0..n-1} |typicalPrice_{t-i} - atp_t|
CCI_t          = (typicalPrice_t - atp_t) / (0.015 * meanDev_t)
```

- Default `n = 20`. Warmup `n - 1`.
- `meanDev === 0` (flat typical price) -> `null`. Do not return `0`.
- `0.015` is a fixed constant, not tunable. It scales CCI so that +/-100 corresponds to roughly
  one standard deviation of typical price from its moving average.
- Mean deviation uses `1/n` (**not** `1/(n-1)`), matching the tulip formula `[V-TULIP]` and
  Wilder's original. `[AMBIG]` — some ports use `1/(n-1)`; that inflates CCI by `n/(n-1)`
  (5% at `n = 20`).

**Test vector** — Dataset A, `n = 5` `[V-CALC, cross-checked against V-TULIP]`:
```
CCI5 = [null x4, 105.0145, 64.2361, -29.6326, 69.5444, 166.6667, 82.0201, 95.5008,
        130.9123, 99.1633, 116.3415, 71.9280]
```
Reproduces tulip's published values from index 8 onward
(`166.67, 82.02, 95.50, 130.91, 99.16, 116.34, 71.93`). `[V-TULIP]`

Arithmetic, `CCI[8]`:

```
typicalPrice[4..8] = 83.510000, 83.386667, 82.886667, 83.530000, 84.513333
atp = (83.51 + 83.386667 + 82.886667 + 83.53 + 84.513333)/5
    = 417.826667/5 = 83.565333
md  = (|83.51-83.565333| + |83.386667-83.565333| + |82.886667-83.565333|
       + |83.53-83.565333| + |84.513333-83.565333|)/5
    = (0.055333 + 0.178667 + 0.678667 + 0.035333 + 0.948)/5
    = 1.896/5 = 0.3792
CCI = (84.513333 - 83.565333)/(0.015 * 0.3792) = 0.948/0.005688 = 166.6667   OK
```

### 4.9 ROC, Momentum

```
ROC_n(t) = 100 * (close_t - close_{t-n}) / close_{t-n}
MOM_n(t) = close_t - close_{t-n}
```

- Warmup `n`. `n >= 1`.
- `close_{t-n} === 0` -> `null`.
- ROC is a percentage (×100), MOM is an absolute price difference. **They are not
  interchangeable.** Several platforms label MOM as a percentage; be explicit.
- Default `n = 12` for ROC, `n = 10` for MOM (the common platform defaults).

**Test vector** — Dataset B `[V-CALC]`:
```
ROC12 = [null x12, 16.960000, 13.022399,  9.813971,  8.635465,  9.886578, 12.958552,
          16.359117, 18.359412, 17.881348, 15.236806, 11.704835,  8.858471,  7.848837,
           9.016815, 11.832325, 14.901179, 16.678135, 16.221004, 13.812654, 10.616137,
           8.064897,  7.178644,  8.302569, 10.897588, 13.683209, 15.275045, 14.831131,
          12.621652]
MOM10 = [null x10, 13.9700, 13.0300, 11.6000, 10.3700,  9.9000, 10.4100, 11.6700,
          13.1000, 13.9900, 13.9600, 13.0000, 11.5800, 10.3500,  9.8900, 10.4400,
          11.7100, 13.1300, 14.0000, 13.9500, 12.9700, 11.5400, 10.3200,  9.9000,
          10.4600, 11.7400, 13.1600, 14.0100, 13.9300, 12.9300, 11.5000]
```

### 4.10 TRIX

```
EMA1 = EMA_n(close)
EMA2 = EMA_n(EMA1)
EMA3 = EMA_n(EMA2)
TRIX_t = 100 * (EMA3_t - EMA3_{t-1}) / EMA3_{t-1}
```

- Default `n = 15`. All three EMAs use **seed A** (SMA seed), each subsequent layer seeded from
  the first `n` non-null values of the previous layer.
- Warmup = `3n - 3` (the value at index `3n - 3` is the first, because it needs a previous
  `EMA3`). For `n = 15` that is index 42; for `n = 5` it is index 12.
- `EMA3_{t-1} === 0` -> `null`.
- Output is a percentage rate of change of a triple-smoothed average — near-zero for a stable
  trend, large spikes at turning points. Scaled by 100.
- TRIX is also commonly used with a signal line (`SMA(TRIX, 9)`); expose the TRIX series and let
  the caller smooth it rather than baking the signal in.

**Test vector** — Dataset B, `n = 5` `[V-CALC]`:
```
TRIX5 = [null x12, 1.383206, 1.243272, 1.053100, 0.889071, 0.817703, 0.863410, 0.997603,
          1.150749, 1.246042, 1.235484, 1.122106, 0.956858, 0.812506, 0.751315, 0.795796,
          0.919701, 1.059365, 1.144765, 1.132982, 1.027878, 0.876095, 0.744964, 0.691202,
          0.734601, 0.849987, 0.978579, 1.056259]
```

### 4.11 MACD

```
fast   = EMA_fast(close)          fast default 12
slow   = EMA_slow(close)          slow default 26
macd   = fast - slow
signal = EMA_signal(macd)         signal default 9
hist   = macd - signal
```

**Everything about MACD is a seeding and warmup question.** Here is exactly what TA-Lib does,
read from `ta_MACD.c` `[V-TALIB]`, and it is what we implement:

```
lookbackTotal = (slowPeriod - 1) + (signalPeriod - 1)
               = slowPeriod + signalPeriod - 2
             -> for 12/26/9: 33, so the FIRST output is at index 33 (the 34th bar)
```

Seeding, per TA-Lib's own in-source comment:

> Each EMA is seeded with the sum of its first `period` inputs, accumulated from 0.0 in input
> order, divided by the period. **The fast and slow seed windows end on the same bar.** The
> signal EMA is seeded the same way from the first `signal period` MACD-line values.

Concretely:

```
1. fastK   = 2/(fastPeriod+1)          slowK = 2/(slowPeriod+1)        signalK = 2/(signalPeriod+1)
2. prevFast = (sum of close[fastPeriod-1 .. slowPeriod-1]) / fastPeriod   <-- wait, no:
```

Stated precisely, from the source:

```
today = 0
consume (slowPeriod - fastPeriod) bars into tempReal          // the slow-only prefix
prevFast = 0
consume the next fastPeriod bars into BOTH prevFast and tempReal
prevSlow = tempReal / slowPeriod
prevFast = prevFast  / fastPeriod
// so: prevFast = SMA(close[fastPeriod-1 .. slowPeriod-1])
//     prevSlow = SMA(close[0          .. slowPeriod-1])
// Both seeds land on bar slowPeriod - 1.  OK
```

3. Advance both EMAs through bars `slowPeriod .. slowPeriod + signalPeriod - 2`, producing the
   first `signalPeriod` MACD-line values.
4. `prevSignal = (sum of those signalPeriod MACD values) / signalPeriod`.
5. Advance all three in lockstep to index `lookbackTotal` and emit.

Arithmetic order is a bit-exactness contract: `prev = (x - prev) * k + prev` (TA-Lib's form),
never `(1-k)*prev + k*x`.

```ts
export interface Macd {
  macd: (number | null)[];      // fast EMA - slow EMA
  signal: (number | null)[];
  histogram: (number | null)[];
  fastEma?: (number | null)[];  // optional, for chart overlay
  slowEma?: (number | null)[];
}
macd(bars, { fastPeriod = 12, slowPeriod = 26, signalPeriod = 9,
             emaSeed = 'sma' } = {}): Macd
```

- `fastPeriod >= 2`, `slowPeriod >= 2`, `signalPeriod >= 1`. Throws `RangeError` otherwise.
- If `slowPeriod < fastPeriod`, TA-Lib **swaps them silently**. We **throw** instead — silently
  swapping a caller's arguments is a footgun. Document this deliberate divergence.
- Warmup `slowPeriod + signalPeriod - 2` for all three outputs (they start together).
- With `emaSeed: 'first'` (tulip), the MACD line starts at index `slowPeriod - 1` and the signal
  line is seeded with the **first MACD value** rather than the SMA of `signalPeriod` values, so
  it also starts at `slowPeriod - 1`. See §8.

**Test vector A — Dataset B, 12/26/9, TA-Lib SMA seeding** `[V-CALC]`:
```
EMA12 = [null x11, 107.013333, 108.543590, 109.776884, 110.688132, 111.406881, 112.153515,
          113.137589, 114.454883, 116.047978, 117.728289, 119.268552, 120.505698,
          121.420206, 122.146328, 122.903816, 123.901691, 125.232200, 126.834938,
          128.518794, 130.055903, 131.287302, 132.198486, 132.923335, 133.685899,
          134.692683, 136.032271, 137.639614, 139.322750, 140.854635]
EMA26 = [null x25, 115.066923, 116.127892, 117.344344, 118.700319, 120.113628, 121.476323,
          122.704743, 123.779207, 124.751858, 125.724313, 126.798808, 128.028526,
          129.395302, 130.816391, 132.184066]

macd      = [null x25, 7.836893, 7.773799, 7.887856, 8.134620, 8.405166, 8.579580, 8.582559,
             8.419280, 8.171477, 7.961586, 7.893875, 8.003744, 8.244312]
signal    = [null x33, 8.199025, 8.151537, 8.100005, 8.080753, 8.113465, 8.192044]
histogram = [null x33, -0.027549, -0.189952, -0.206130, -0.077008, 0.130847, 0.314316, 0.382820]
```
Spot check: `macd[25] = EMA12[25] - EMA26[25] = 122.903816 - 115.066923 = 7.836893`. OK

**Test vector B — Dataset A, `fast=2, slow=5, signal=9`, tulip seeding** `[V-TULIP]`:
```
macd   = [0.000000, -0.176667, 0.426667, 0.509259, 0.617777, 0.351274, 0.110674,
          0.415877, 0.578047, 0.422172, 0.683757, 0.926626, 0.891268, 0.978816, 0.620681]
signal = [null x4, 0.617777, 0.564498, 0.473734, 0.462172, 0.485338, 0.472709,
          0.514869, 0.597294, 0.656110, 0.720592, 0.700648]
hist   = [null x4, 0.000000, -0.213224, -0.363060, -0.046295, 0.092709, -0.050537,
          0.168889, 0.329412, 0.235339, 0.258058, -0.079967]
```
Reproduces tulip's published table (`macd = 0.62, 0.35, 0.11, 0.42, 0.58, 0.42, 0.68, 0.93,
0.89, 0.98, 0.62`; `signal = 0.62, 0.56, 0.47, 0.46, 0.49, 0.47, 0.51, 0.60, 0.66, 0.72,
0.70`; `hist = 0.00, -0.21, -0.36, -0.05, 0.09, -0.05, 0.17, 0.33, 0.24, 0.26, -0.08`). `[V-TULIP]`

Arithmetic, `macd[4]`:

```
EMA2  : seed e0 = 81.59 ; e1 = 81.59 + (2/3)(81.06-81.59) = 81.236667
        e2 = 81.236667 + (2/3)(82.87-81.236667) = 82.325556
        e3 = 82.325556 + (2/3)(83.00-82.325556) = 82.775185
        e4 = 82.775185 + (2/3)(83.61-82.775185) = 83.331728
EMA5  : seed s0 = 81.59 ; s1 = 81.59 + (1/3)(81.06-81.59) = 81.413333
        s2 = 81.413333 + (1/3)(82.87-81.413333) = 81.898889
        s3 = 81.898889 + (1/3)(83.00-81.898889) = 82.265926
        s4 = 82.265926 + (1/3)(83.61-82.265926) = 82.713951
macd[4] = 83.331728 - 82.713951 = 0.617777      OK
```
Note `signal[4] = macd[4] = 0.617777` because tulip seeds the signal EMA with the first MACD
value. TA-Lib's SMA seeding would instead start the signal at index `slow + signal - 2 = 12`.
Different instruments, not a bug.

### 4.12 Ultimate Oscillator

```
bp_t  = close_t - min(low_t, close_{t-1})
tr_t  = max(high_t - low_t, |high_t - close_{t-1}|, |low_t - close_{t-1}|)   // same TR as ATR
avg_n = SUM_{i=t-n+1..t} (bp_i - tr_i) / SUM_{i=t-n+1..t} tr_i

UO_t = 100 * ( 4*avg_p1 + 2*avg_p2 + 1*avg_p3 ) / 7
```

- Defaults `p1 = 7, p2 = 14, p3 = 28` (Larry Williams). `p1 < p2 < p3` required.
- Warmup `p3` (= 28) leading `null`s. First output at index `p3`.
- `SUM tr_i === 0` in any of the three windows -> `null` for that bar.
- Range `[0, 100]` in theory; **can exceed 100 or go below 0 in practice** because `bp` can be
  negative on a gap down. Do not clamp.
- Overbought `> 70`, oversold `< 30`.

**Test vector** — Dataset B, `7/14/28` `[V-CALC]`:
```
UO = [null x28, -38.142485, -37.528374, -36.551233, -37.431930, -38.117918, -38.624785,
       -41.840579, -42.224258, -39.658406, -38.332734, -36.880640, -36.528728]
```
All-negative and outside `[0, 100]` because the synthetic dataset trends steadily upward, so
`close_t < min(low_t, close_{t-1})` almost never binds but `bp - tr` is systematically negative.
This is a deliberate demonstration that the raw formula is unbounded — do **not** clamp.

### 4.13 ADX / DMI

Wilder's exact definition, transcribed from `ta_ADX.c`'s in-source documentation `[V-TALIB]`,
which reproduces the original book almost verbatim:

```
Case 1 (up move, close inside yesterday's range):
    +DM1 = (C - A)      -DM1 = 0
Case 2 (down move, close inside yesterday's range):
    +DM1 = 0           -DM1 = (B - D)
Case 3/4 (move exceeds yesterday's range):
    the SMALLER delta of (C-A) and (B-D) determines which of +DM/-DM is zero
Case 5/6/7 (inside bar, or equal moves):
    +DM = -DM = 0
```

Implemented as:

```
upMove   = high_t - high_{t-1}
downMove = low_{t-1} - low_t
+DM1_t   = (upMove > downMove && upMove > 0) ? upMove : 0
-DM1_t   = (downMove > upMove && downMove > 0) ? downMove : 0
```

Strict `>` in both: if `upMove === downMove` (including both zero), **both DMs are 0**. If
`upMove > 0` but `upMove < downMove`, `+DM = 0` and `-DM = downMove`.

Wilder smoothing of DM and TR (the "period-1 copy-through" form):

```
+DM_n   = SUM_{i=1..n} +DM1_i                                  (seed)
+DM_t   = +DM_{t-1} - (+DM_{t-1} / n) + +DM1_t                 (t > n)
same for -DM and TR
```

Directional indicators:

```
+DI_t = 100 * +DM_t / TR_t
-DI_t = 100 * -DM_t / TR_t
DX_t  = 100 * |+DI_t - (-DI_t)| / (+DI_t + (-DI_t))
```

ADX seed and recursion:

```
ADX_{2n-1} = (1/n) * SUM_{i=n..2n-1} DX_i                      (mean of the first n DX)
ADX_t      = ( (n-1)*ADX_{t-1} + DX_t ) / n                    (t > 2n-1)
```

Warmups (`n = 14`):

| Output | First index | Bars needed |
|---|---|---|
| `TR` | 1 | 2 |
| smoothed `TR`, `+DM`, `-DM` | `n` = 14 | 15 |
| `+DI`, `-DI` | `n` = 14 | 15 |
| `DX` | `n` = 14 | 15 |
| **`ADX`** | **`2n - 1` = 27** | **28** |

`TA_ADX_Lookback(n) = 2n - 1` `[V-TALIB]`. Warmup is `2n − 1`, not `2n − 2`; a common
off-by-one.

Edge cases:

- `TR_n === 0` (no price movement in the whole window) -> `+DI = -DI = null`, `DX = null`.
- `+DI + -DI === 0` -> `DX = null`. Do not return `0`.
- ADX is in `[0, 100]` by construction (it is a smoothed mean of DX, and DX is in `[0,100]`).
- **Rounding**: Wilder's original did integer rounding because the book was hand-calculated.
  TA-Lib explicitly does not round, and says so. **We do not round.** `[V-TALIB]`

**Crossover convention** `[AMBIG]` — state yours explicitly:

```
bullish cross: +DI_{t-1} <= -DI_{t-1}  AND  +DI_t > -DI_t
bearish cross: +DI_{t-1} >= -DI_{t-1}  AND  +DI_t < -DI_t
```

Using strict `>` / `<` on the second condition and `<=` / `>=` on the first means a
`+DI == -DI` bar does not register a crossover. Widely used; use it.

```ts
export interface Adx {
  adx: (number | null)[];        // warmup 2n-1
  plusDi: (number | null)[];     // warmup n
  minusDi: (number | null)[];    // warmup n
  dx: (number | null)[];         // warmup n
}
adx(bars, n = 14): Adx
```

**Test vector — Dataset B, `n = 14`** `[V-CALC]`:
```
+DI14 = [null x14, 44.4070, 41.7059, 40.9203, 43.7861, 46.1935, 48.7146, 50.4003, 49.1960,
          46.3507, 43.3014, 41.1841, 41.7386, 43.9665, 46.0881, 49.4633, 50.5035, 48.4371,
          45.7409, 43.1334, 40.7276, 41.6531, 43.3755, 46.0413, 49.2711, 49.8459, 48.7995]
-DI14 = [null x14,  5.9899,  7.5720,  7.1293,  6.4943,  5.8398,  5.2813,  4.8563,  4.6417,
          6.4742,  8.3045,  7.8985,  7.4459,  6.7805,  6.1327,  5.5173,  5.0843,  4.8273,
          4.7944,  6.7487,  7.8093,  7.3089,  6.6786,  6.0264,  5.4145,  5.0169,  4.7623]
DX14  = [null x14, 76.2291, 69.2682, 70.3254, 74.1676, 77.5535, 80.4381, 82.4226, 82.7568,
          75.4881, 67.8156, 67.8156, 69.7225, 73.2773, 76.5125, 79.9299, 81.7071, 81.8743,
          81.0255, 72.9415, 67.8213, 70.1446, 73.3146, 76.8518, 80.1977, 81.7111, 82.2175]
ADX14 = [null x27,
         74.5566, 74.9404, 75.4238, 75.8845, 76.2517, 76.0153, 75.4300, 75.0525,
         74.9283, 75.0657, 75.4323, 75.8808, 76.3334]
```

**Arithmetic — the ADX seed.** The seed is the mean of exactly `n` DX values, `DX[n .. 2n-1]`
(14 values for `n = 14`):

```
DX14[14..27] = 76.2291, 69.2682, 70.3254, 74.1676, 77.5535, 80.4381, 82.4226,
              82.7568, 75.4881, 67.8156, 67.8156, 69.7225, 73.2773, 76.5125

sum = 1043.7927
ADX14[27] = 1043.7927 / 14 = 74.556625                                            OK
```

Note the indexing subtlety: the seed lands at index `2n - 1 = 27`, and the DX values it averages
start at index `n = 14`, not at index `0`. Averaging `DX[0 .. 13]` (all `null`) or averaging over
a window longer than `n` both give a wrong seed. Sum-over-a-fixed-`n`-window starting at `n` is
the rule.

**Arithmetic — the ADX recursion** (Wilder smoothing, `n = 14`):

```
ADX14[t] = (13 * ADX14[t-1] + DX14[t]) / 14

ADX14[28] = (13 * 74.556625 + 79.9299) / 14 = (969.236125 + 79.9299) / 14
          = 1049.166025 / 14 = 74.940430                                         OK
ADX14[29] = (13 * 74.940430 + 81.7071) / 14 = (974.225590 + 81.7071) / 14
          = 1055.932690 / 14 = 75.423621                                         OK
ADX14[30] = (13 * 75.423621 + 81.8743) / 14 = (980.507073 + 81.8743) / 14
          = 1062.381373 / 14 = 75.884384                                         OK
```

**Interpretation**: `ADX > 25` trending, `ADX < 20` ranging, the 20-25 band is transitional. Use
`+DI > -DI` for direction, **never** ADX alone. `ADX` is directionless.

### 4.14 Aroon

```
AroonUp_t   = 100 * (n - (t - argmaxHigh)) / n      argmaxHigh over high[t-n .. t]
AroonDown_t = 100 * (n - (t - argminLow))  / n      argminLow  over low [t-n .. t]
```

- Default `n = 14`. Warmup `n`.
- **Window is `n + 1` bars, INCLUDING the current bar** `[V-TALIB]`: `TA_AROON_Lookback(n) = n`
  and the code walks `trailingIdx = today - n` up to `today`. tulip does the same, and its
  published `n = 5` table can only be reproduced with a 6-bar window. `[V-TULIP]`
- **Tie-breaking: most recent wins.** TA-Lib's loop uses `if (tmp <= lowest)` / `if (tmp >= highest)`,
  which updates the index on an equal value, so a flat market yields `AroonUp = 100`.
- `AroonUp + AroonDown <= 200` always (equal to 200 exactly when both extremes are current).
- Range `[0, 100]`.

**Test vector** — Dataset A, `n = 5` `[V-TULIP]`:
```
AroonUp   = [null x5, 100.0000,  80.0000, 100.0000, 100.0000, 100.0000, 100.0000,
             100.0000, 100.0000, 100.0000,  80.0000]
AroonDown = [null x5,  20.0000,   0.0000,   0.0000,  80.0000,  60.0000,  40.0000,
              20.0000,   0.0000,  40.0000,  20.0000]
```
Reproduces the published table. `[V-TULIP]` Arithmetic, index 5: window is bars 1..5.
`highestHigh = 83.90` at bar 5 -> `Up = 100*(5-0)/5 = 100`.
`lowestLow = 80.64` at bar 1 -> `Down = 100*(5-4)/5 = 20`. OK

### 4.15 Parabolic SAR

Wilder's PSAR, transcribed from `ta_SAR.c` `[V-TALIB]`. Defaults `acceleration = 0.02`,
`maximum = 0.2`.

```
initial direction: isLong = (minusDM_1 <= 0)
if isLong:  ep = high[1],  sar = low[0]
else:       ep = low[1],   sar = high[0]
```

Note the SAR is initialised from **bar 0's** low/high but the extreme point comes from **bar 1**.
`minusDM_1` is the one-period `-DM` at bar 1 (§4.13's formula).

Per-bar loop, starting at bar 1. **The value emitted for bar `t` is the SAR computed during bar
`t-1`** — the SAR leads the bar by one.

```
LONG branch:
  if low_t <= sar:                        // reversal to short
     sar = ep
     sar = max(sar, high_{t-1}, high_t)    // keep inside the two-bar range
     EMIT sar;  direction := 'short'
     af = acceleration;  ep = low_t
     sar = sar + af*(ep - sar)
     sar = max(sar, high_{t-1}, high_t)
  else:
     EMIT sar
     if high_t > ep: ep = high_t; af = min(af + acceleration, maximum)
     sar = sar + af*(ep - sar)
     sar = min(sar, low_{t-1}, low_t)

SHORT branch: mirror image with min/max swapped and ep tracking lows.
```

```ts
export interface Psar {
  psar: (number | null)[];              // warmup 1
  /** 1 = long, -1 = short, 0 = reversal bar. null before index 1. */
  direction: (1 | -1 | 0 | null)[];
  /** Reversal indices: bar where direction flipped 0. */
  reversals: number[];
}
psar(bars, { acceleration = 0.02, maxAcceleration = 0.2 } = {}): Psar
```

- `acceleration > maxAcceleration` -> TA-Lib clamps the acceleration to the max. We **throw**
  `RangeError` instead. Same reasoning as the MACD period swap.
- The two-bar "keep the SAR inside the recent range" clamp is essential — omitting it produces
  SARs that jump outside the price on gap moves and is the #1 PSAR implementation bug.
- `af` increments only on **new extremes in the trend direction**, and resets to
  `acceleration` on every reversal.

**PSAR is the least standardized indicator in this document** `[AMBIG]`. Every retail platform
differs somewhere in the seed or the clamp order. If a user complains that our PSAR "looks
wrong", the first question is which platform they are comparing against, not whether our code has
a bug.

**Test vector** — Dataset B `[V-CALC]`:
```
psar  = [null, 99.2000, 99.2000, 99.4924, 99.9777, 100.4338, 100.8626, 101.2656, 101.6445,
         102.2329, 103.2276, 104.6127, 106.4169, 108.3086, 109.8976, 111.2324, 112.3536,
         113.2955, 114.4915, 116.1632, 118.1085, 120.1608, 121.8907, 123.2745, 124.3816,
         125.0700, 125.1100, 125.9800, 127.4720, 129.3656, 131.3145, 132.9156, 134.2125,
         135.2500, 135.5200, 135.5200, 136.6400, 138.1900, 140.1260, 142.0448]
```
This synthetic series trends upward monotonically, so no reversal ever fires and the vector
exercises only the long branch. **Add a reversal to the fixture** when testing the short branch.

### 4.16 Supertrend

Supertrend is **not** a Wilder indicator and has no canonical source. It is a TradingView
community script that became a de-facto standard. The Pine implementation is public, and we
reproduce it faithfully.

```
atr      = ATR(atrPeriod)                             (Wilder, §4.3)
midline  = (high + low)/2
upper0   = midline + mult*atr
lower0   = midline - mult*atr

finalUpper_t = (upper0_t < finalUpper_{t-1} || close_{t-1} > finalUpper_{t-1})
                  ? upper0_t : finalUpper_{t-1}
finalLower_t = (lower0_t > finalLower_{t-1} || close_{t-1} < finalLower_{t-1})
                  ? lower0_t : finalLower_{t-1}

if (atr_{t-1} is na):  direction_t = +1
else if (superTrend_{t-1} === finalUpper_{t-1}):
     direction_t = (close_t > finalUpper_t) ? -1 : +1
else:
     direction_t = (close_t < finalLower_t) ? +1 : -1

superTrend_t = (direction_t === -1) ? finalLower_t : finalUpper_t
```

Defaults: `atrPeriod = 10`, `multiplier = 3`. Warmup `atrPeriod`. First direction is forced to
`+1` on the first bar with a defined ATR (the Pine `na(atr[1])` branch) — it is **not**
inferred from price.

**Variants** `[AMBIG]`, all in active use:

| Variant | `atrPeriod` | `multiplier` | Base |
|---|---|---|---|
| **TradingView "Supertrend" strategy** (ours) | 10 | 3 | `(H+L)/2` |
| TradingView "Supertrend" (older builds) | 10 | 3 | `H` for upper, `L` for lower |
| Popular YouTube/manual variant | 10 | 3 | `H + 3·ATR`, `L − 3·ATR` |
| DGT / Sierra variant | 10 | 3 | `H + 3·ATR`, `L − 3·ATR` |
| HalfTrend-style variants | 10 | 2 | various |

**The `midline` vs `high/low` base choice changes the line by up to half the intrabar range and
can flip a signal.** Expose it as `{ base: 'hl2' | 'hl' }`, default `'hl2'`.

```ts
export interface Supertrend {
  line: (number | null)[];                          // the active trailing line
  direction: (1 | -1 | null)[];                     // 1 = uptrend (buy on close)
  finalUpperBand: (number | null)[];
  finalLowerBand: (number | null)[];
  /** true on bars where close crossed the OPPOSITE band: the entry signal. */
  crossed: boolean[];
}
supertrend(bars, { atrPeriod = 10, multiplier = 3, base = 'hl2' } = {}): Supertrend
```

**Test vector** — Dataset B, `10 / 3 / hl2` `[V-CALC]`:
```
direction = [null x10, 1,1,1,1,1,1,1,1,1, -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1]
line      = [null x10,
             123.1510, 123.1510, 123.1510, 123.1510, 123.1510, 123.1510, 123.1510, 123.1510,
             123.1510, 115.1557, 117.4277, 118.6344, 118.6344, 118.6344, 118.6344, 118.6395,
             120.6225, 123.2783, 126.3709, 128.2083, 128.9435, 129.1542, 129.1542, 129.1542,
             129.3564, 131.6142, 134.0763, 136.8972, 139.0395, 139.9630]
```
Direction flips up -> down at index 19 (the 20th bar) when `close[19] = 126.97` crosses below
`finalLower[19]`.

### 4.17 Volume indicators

#### OBV

```
obv_0 = 0
obv_t = obv_{t-1} + volume_t    if close_t >  close_{t-1}
obv_t = obv_{t-1} - volume_t    if close_t <  close_{t-1}
obv_t = obv_{t-1}               if close_t == close_{t-1}
```

- Warmup **0**. `obv[0] = 0` by definition. There is no `null` in the array.
- **Flat close -> no change**, not `+volume`. Equal closes contribute nothing. Getting this
  wrong makes OBV drift upward in a range.
- Seed choice: tulip and `technicalindicators` both seed at `0`; **TA-Lib seeds
  `prevOBV = inVolume[startIdx]`,** i.e. `obv[0] = volume[0]` `[V-TALIB]`. That is a genuine
  disagreement of one bar's worth of volume. **We seed at `0`** (Wilder's and the majority
  convention), and document the TA-Lib divergence.
- OBV is **not** scale-invariant and **not** comparable across symbols. It is a within-symbol
  cumulative measure only.
- Optional `signal` line: `EMA_10(obv)` or `SMA_20(obv)`. Do not bake it in.

**Test vector** — Dataset A `[V-TULIP]`:
```
obv = [0, -6447400, 1243500, 5074900, 9530000, 5732000, 1795800, 6527800, 11369100,
       7453800, 14284600, 20978700, 26272300, 34258100, 29450200]
```
Reproduces the published table exactly. Arithmetic: bar 2 `close` rose `82.87 > 81.06`, so
`obv_2 = 0 + 7690900 = 7690900`? **No** — the table shows `1243500`. Chain: `obv_0 = 0`;
`obv_1 = 0 - 6447400 = -6447400`; `obv_2 = -6447400 + 7690900 = 1243500`. OK

#### VWAP

```
cumulative: vwap_t = SUM_{k<=t} (typicalPrice_k * volume_k) / SUM_{k<=t} volume_k
anchored:   reset the two accumulators at a chosen anchor index, then the same formula
```

- `typicalPrice = (high + low + close) / 3` (the standard). Some venues use `(open+high+low+close)/4`.
  State which.
- Warmup **0** for the cumulative form; `null` for every bar before the anchor in the anchored
  form.
- **`SUM volume === 0`** -> `null`.
- **Reset semantics** — the single most important documented decision here:

| Form | Anchor | Use |
|---|---|---|
| `anchor: 'session'` (**default**) | first bar of each calendar trading day | Intraday chart annotation. **On daily PSX data every bar is its own session, so VWAP equals that bar's typical price** — which is useless. |
| `anchor: 'period'` | first bar of the whole input series | A running VWAP line on a daily chart. This is the useful daily default. |
| `anchor: 'index'` | caller-supplied bar index | Custom. |
| `anchor: 'month'` | first bar of each calendar month | Monthly-reset VWAP. |

**On daily data, default `anchor` to `'period'`.** Resetting per "session" is only meaningful for
intraday bars, and PSX history from the DPS API is daily only.

```ts
vwap(bars, { anchor = 'period', anchorIndex?, typicalPrice = 'hlc' } = {}): (number | null)[]
```

**Test vector** — Dataset A, cumulative from index 0 `[V-CALC]`:
```
vwap = [81.676667, 81.420913, 81.802679, 81.994171, 82.234686, 82.371944, 82.428519,
        82.557075, 82.765751, 82.902685, 83.176573, 83.495524, 83.732372, 84.143104,
        84.336037]
```
Arithmetic, index 0: `typicalPrice = (82.15 + 81.29 + 81.59)/3 = 245.03/3 = 81.676667`;
`volume = 5653100`; with one bar the ratio is the typical price itself. OK

Anchored at index 5:
```
vwap@5 = [null, null, null, null, null, 83.386667, 83.132199, 83.283199, 83.627296,
          83.786452, 84.119275, 84.514345, 84.782584, 85.258815, 85.452750]
```

#### MFI

```
tp_t   = (high_t + low_t + close_t)/3
rawMF_t = tp_t * volume_t
positive flow  = SUM rawMF over the last n bars where tp_t > tp_{t-1}
negative flow  = SUM rawMF over the last n bars where tp_t < tp_{t-1}
                 (bars with tp_t == tp_{t-1} contribute to NEITHER)
MFI_t  = 100 - 100 / (1 + positiveFlow / negativeFlow)
```

- Default `n = 14`. Warmup `n + 1` (needs `tp` at `t-1` for the first comparison). For `n = 5`
  that is 5 leading `null`s, first output at index 5 — matches tulip.
- `negativeFlow === 0` -> **MFI = 100** (all money flowing in). This matches tulip and
  Wilder. Do **not** return `null` here; unlike a mean/SD ratio, `x/0` with `x > 0` is a
  well-defined limit and the literature says 100.
- `positiveFlow === 0 && negativeFlow === 0` (no volume, or no change in typical price over the
  window) -> `null`.
- Range `[0, 100]`. Same interpretation bands as RSI.

**Test vector** — Dataset A, `n = 5` `[V-TULIP]`:
```
mfi = [null x5, 61.1725, 67.3077, 62.7962, 64.6613, 45.2382, 67.8407, 85.5778,
       85.9626, 87.5044, 84.6472]
```
Reproduces the published table. OK

#### Accumulation / Distribution Line (Chaikin)

```
mfm_t = ((close_t - low_t) - (high_t - close_t)) / (high_t - low_t)
      = (2*close_t - high_t - low_t) / (high_t - low_t)
ad_t  = ad_{t-1} + mfm_t * volume_t          ad_0 = mfm_0 * volume_0
```

- Warmup **0**. `ad_0 = mfm_0 * volume_0`, not `0` — the first bar contributes its money-flow
  multiplier.
- **`high_t === low_t`** -> `mfm_t = 0` for that bar, so `ad_t = ad_{t-1}`. Do **not** return
  `null` and do not divide. A zero-range bar carries no directional information but is not an
  error.
- Chaikin Oscillator: `EMA_3(ad) - EMA_10(ad)`.
- ADL is unbounded and not scale-invariant, exactly like OBV.

**Test vector** — Dataset A `[V-TULIP]`:
```
ad = [-1709076.74, -3823823.94, 2436210.94, 2730934.02, 4444434.02, 1031041.61,
      375008.28, 3640088.28, 4411889.73, 2696196.47, 6823899.14, 13067975.61,
      17580552.66, 21140487.60, 19463313.18]
```
Reproduces the published table exactly. Arithmetic, index 0:
```
mfm_0 = ((81.59 - 81.29) - (82.15 - 81.59)) / (82.15 - 81.29)
      = (0.30 - 0.56) / 0.86 = -0.26 / 0.86 = -0.302325581
ad_0  = -0.302325581 * 5653100 = -1709076.744                                        OK
```

#### CMF (Chaikin Money Flow)

```
cmf_t = SUM_{i=t-n+1..t} (mfm_i * volume_i) / SUM_{i=t-n+1..t} volume_i
```

- Default `n = 20`. Warmup `n - 1`.
- Range `[-1, 1]`.
- `SUM volume === 0` -> `null`.
- CMF is a **volume-weighted oscillator**, unlike ADL which is a cumulative line. They answer
  different questions; do not conflate.

**Test vector** — Dataset A, `n = 5` `[V-CALC]`:
```
cmf = [null x4, 0.158289, 0.104494, 0.177079, 0.058011, 0.077241, -0.082375,
       0.238826, 0.469875, 0.505545, 0.544558, 0.530400]
```

### 4.18 Support and resistance detection

This is a **clustering** problem, not a formula, so the algorithm must be fully specified for
reproducibility. Ours:

```
1. FRACTAL PIVOTS. For k = pivotLookback (default 5):
     pivotHigh(i)  <=>  high[i] == max(high[i-k .. i+k])  AND  strict > on at least one side
     pivotLow(i)   <=>  low[i]  == min(low [i-k .. i+k])  AND  strict > on at least one side
   The +/-k window requires i >= k and i < len-k; the first and last k bars can never be pivots.

2. CLUSTER. Take all pivot prices in the window, sort ascending, and greedily group:
     new group iff  price - currentGroupMax > tolerancePct * currentGroupMax
     (default tolerancePct = 0.01, i.e. 1%)
   Cluster level = volume-weighted mean of its pivot prices:
     level = SUM(pivotPrice * volumeAtPivot) / SUM(volumeAtPivot)

3. CLASSIFY relative to close_t:
     resistance: level > close_t * (1 + tolerancePct)
     support:    level < close_t * (1 - tolerancePct)
     at level:   within tolerance -> reported in BOTH lists (this is the "price is sitting on
                 support" case and must not be dropped)

4. RANK by (a) number of pivots in the cluster, then (b) most recent pivot, then
   (c) level distance. Return the top `maxLevels` (default 5) per side, sorted strongest first.
```

Every threshold above is a parameter with the stated default. No hidden heuristics.

```ts
export interface Level {
  price: number;
  kind: 'support' | 'resistance';
  touches: number;        // pivots in the cluster
  lastTouchIndex: number;
  /** bars since lastTouchIndex */
  recencyBars: number;
  /** touches * exp(-recencyBars / recencyHalfLifeBars), recencyHalfLifeBars default 20 */
  strength: number;
}
supportResistance(bars, {
  pivotLookback = 5, tolerancePct = 0.01, maxLevels = 5, recencyHalfLifeBars = 20
} = {}): { support: Level[]; resistance: Level[]; atLevel: Level[] }
```

Honest limitation: fractal-pivot + clustering is a defensible deterministic method, but it is
**not** a standard with a reference implementation, unlike the indicators above. Treat the output
as "levels of interest", not as authoritative support/resistance. Do not describe it as
"AI-powered" (§5.6).

### 4.19 Chart pattern detection

Same honesty rule: these are **rule-based detectors with stated thresholds**, not recognizers.
Each returns a list of occurrences with the numeric evidence, so a user can see exactly why a
pattern was flagged.

#### Double top / double bottom

```
doubleTop(t):
  find pivotHigh p1 at index i1, pivotHigh p2 at index i2, with i1 < i2, 2 <= i2-i1 <= maxSpan
                                      (default maxSpan = 60)
  |high[i1] - high[i2]| / high[i1] <= symmetryTolerance   (default 0.02, 2%)
  the minimum LOW between i1 and i2 is at least necklineDepthPct below min(high[i1],high[i2])
                                      (default 0.03, 3%)
  confirm only if close[t] <= neckline (the intervening low)
  target = 2*neckline - min(high[i1],high[i2])      // measured-move projection
doubleBottom: mirror with pivot lows and a HIGH intervening, confirm on close >= neckline
```

```ts
export interface PatternMatch {
  pattern: 'double-top' | 'double-bottom' | 'head-and-shoulders' |
           'inverse-head-and-shoulders' | 'ascending-triangle' | 'descending-triangle' |
           'symmetrical-triangle';
  /** Bar indices of the pattern's structural points, ascending. */
  indices: number[];
  neckline: number | null;
  target: number | null;
  /** 0..1. Defined in the table below. NOT a probability. */
  score: number;
}
detectPatterns(bars, opts?): PatternMatch[]
```

**Confidence scores must be defined, not vibes.** Ours:

```
symmetryScore   = 1 - |p1 - p2| / min(p1, p2) / symmetryTolerance        clipped to [0,1]
depthScore      = min(1, actualDepth / (2 * necklineDepthPct))
recencyScore    = exp(-(t - confirmationIndex) / recencyHalfLifeBars)
recencyHalfLifeBars default 20

score = 0.40*symmetryScore + 0.30*depthScore + 0.30*recencyScore
```

Weights are stated constants and are configurable. The score is a **heuristic strength measure,
not a probability**, and must be documented as such in the API docs.

#### Head and shoulders

```
headAndShoulders(t):
  three consecutive pivotHighs i1 < i2 < i3 with i3 - i1 <= maxSpan
  high[i2] > high[i1] * (1 + prominencePct)   and   high[i2] > high[i3] * (1 + prominencePct)
                                      (default prominencePct = 0.02)
  |high[i1] - high[i3]| / high[i1] <= symmetryTolerance
  neckline = the line through the two pivot lows between i1-i2 and i2-i3
             (simple linear interpolation on bar index, or the mean of the two lows when they
             are on adjacent bars)
  confirm on close[t] <= neckline(t) - 0   (a close below the interpolated neckline)
  target = neckline - (high[i2] - neckline)
inverse: mirror, confirm on a close above the neckline
```

#### Triangles

```
For the window W = last `windowLength` bars (default 60):
  fit OLS lines to the highs and to the lows against bar index.
  ascendingTriangle:   slope(high) in [0, +flatSlopeMax]  AND  slope(low) > 0
  descendingTriangle:  slope(low) in [0, -flatSlopeMax]   AND  slope(high) < 0
                                      (default flatSlopeMax = 0.02 per bar, ~flat)
  symmetricalTriangle: slope(high) < 0  AND  slope(low) > 0
  ALL additionally require convergence:
     |slope(high) - slope(low)| <= maxConvergence
                                      (default maxConvergence = 0.08 per bar)
     AND the fitted lines intersect within or just after the window:
        barsToIntersection >= -barsAfterWindow   (default barsAfterWindow = 10)
  score = 0.5*convergenceComponent + 0.5*flatnessComponent
```

- Requires `bars.length >= windowLength`. Else return `[]`.
- OLS slope is per bar (not per period, not annualized).
- Triangles are **continuation patterns in the prevailing direction**; they are not directional
  signals on their own.

### 4.20 Indicator warmup reference

| Indicator | Default params | First output index | Bars needed |
|---|---|---|---|
| SMA | 20 | 19 | 20 |
| EMA | 20 | 19 | 20 |
| WMA | 20 | 19 | 20 |
| DEMA | 20 | 38 | 39 |
| TEMA | 20 | 57 | 58 |
| HMA | 20 | 22 | 23 |
| Bollinger | 20, 2 | 19 | 20 |
| Donchian | 20 | 19 | 20 |
| Keltner | 20/10, 2 | 19 | 20 |
| ATR | 14 | 14 | 15 |
| RSI | 14 | 14 | 15 |
| MACD | 12/26/9 | 33 | 34 |
| Stochastic `%K` | 14 | 13 | 14 |
| Stochastic slow `%K` | 14, 3 | 15 | 16 |
| Stochastic `%D` | 14, 3, 3 | 16 | 17 |
| CCI | 20 | 19 | 20 |
| Williams %R | 14 | 13 | 14 |
| ROC | 12 | 12 | 13 |
| Momentum | 10 | 10 | 11 |
| TRIX | 15 | 42 | 43 |
| Ultimate Osc | 7/14/28 | 28 | 29 |
| OBV | — | 0 | 1 |
| ADL | — | 0 | 1 |
| VWAP | period anchor | 0 | 1 |
| MFI | 14 | 14 | 15 |
| CMF | 20 | 19 | 20 |
| ADX | 14 | 27 | 28 |
| `+DI`/`-DI`/`DX` | 14 | 14 | 15 |
| Aroon | 14 | 14 | 15 |
| PSAR | 0.02/0.2 | 1 | 2 |
| Supertrend | 10, 3 | 10 | 11 |

---

## 5. Part 3 — Signal generation and the insights layer

### 5.1 What this layer is, and what it is not

The Python reference advertised `interpret_stock`, `detect_patterns`, `generate_trading_signals`
and `market_sentiment_analysis` with docstrings and **no bodies** — pure stubs. Whatever we build
here is our design.

Constraints we impose on ourselves:

1. **Deterministic.** Same input, same output, every time. No randomness, no sampling, no
   `Date.now()`, no hidden state. Two runs on the same bars produce byte-identical JSON.
2. **Explainable.** Every signal carries the list of rules that fired, their numeric evidence, and
   the exact threshold each was compared against. A user must be able to reconstruct the decision
   by hand from the published indicator values.
3. **No "AI-powered" claims.** These are threshold rules. Marketing copy calling them AI is a lie
   we decline to tell. The docstrings must say `rule-based`.
4. **Not advice.** Outputs are descriptive classifications of indicator state. There is no
   position sizing, no entry/exit price, no P&L projection.

### 5.2 The scoring model

A single mechanism underlies every signal, so there is one thing to audit.

```
SCORE = sum over fired rules of (direction * weight * strength)
       -----------------------------------------------
       sum over ALL rules of weight        (fired or not)

direction in {-1, +1};  strength in [0, 1];  weight > 0 per rule
score in [-1, +1]
```

Then:

```
signal     = BUY    if score >= +0.35
           = SELL   if score <= -0.35
           = HOLD   otherwise

confidence = min(|score| / 0.35, 1.0) * agreementFactor
```

`agreementFactor = firedRules / totalRules` — a signal backed by 3 of 14 rules is weak evidence
no matter how extreme those three were, and confidence must reflect that.

`confidence ∈ [0, 1]`, and is `0` when `signal === 'HOLD'`.

**Why 0.35?** With 14 rules, a score of 0.35 requires roughly 5 same-direction rules of full
strength, or 7 of half strength. It is a deliberate majority threshold: no single family can
trigger a signal on its own. The number is a design choice, stated here so it can be argued
with, not a discovered constant.

### 5.3 The rule table

Every row is evaluated independently. `strength` is a normalised ramp in `[0, 1]`, linear
between the two anchor points.

| # | Family | Indicator | Condition | Dir | Weight | Strength |
|---|---|---|---|---|---|---|
| R01 | trend | SMA50 vs SMA200 | `SMA50 > SMA200` | +1 | 2.0 | 1.0 |
| R02 | trend | SMA50 vs SMA200 | `SMA50 < SMA200` | −1 | 2.0 | 1.0 |
| R03 | trend | close vs SMA200 | `close > SMA200 * 1.02` | +1 | 1.5 | `min((close/SMA200 − 1)/0.05, 1)` |
| R04 | trend | close vs SMA200 | `close < SMA200 * 0.98` | −1 | 1.5 | `min((1 − close/SMA200)/0.05, 1)` |
| R05 | trend | SMA50 slope | `SMA50[t] > SMA50[t−5]` | +1 | 1.0 | `min((sma50[t]−sma50[t−5])/(0.02*sma50[t]), 1)` |
| R06 | trend | SMA50 slope | `SMA50[t] < SMA50[t−5]` | −1 | 1.0 | same, mirrored |
| R07 | momentum | MACD line vs signal | `macd > signal` | +1 | 2.0 | 1.0 |
| R08 | momentum | MACD line vs signal | `macd < signal` | −1 | 2.0 | 1.0 |
| R09 | momentum | MACD histogram slope | `hist[t] > hist[t−3]` | +1 | 1.0 | `min(|hist[t]−hist[t−3]| / (0.005*close[t]), 1)` |
| R10 | momentum | MACD histogram slope | `hist[t] < hist[t−3]` | −1 | 1.0 | same, mirrored |
| R11 | mean-reversion | RSI(14) | `RSI < 30` | +1 | 1.5 | `min((30 − RSI)/10, 1)` |
| R12 | mean-reversion | RSI(14) | `RSI > 70` | −1 | 1.5 | `min((RSI − 70)/10, 1)` |
| R13 | mean-reversion | RSI(14) trend | `RSI[t] > RSI[t−3]` and `RSI[t] < 50` | +1 | 0.5 | `min((RSI[t]−RSI[t−3])/10, 1)` |
| R14 | mean-reversion | RSI(14) trend | `RSI[t] < RSI[t−3]` and `RSI[t] > 50` | −1 | 0.5 | same, mirrored |
| R15 | trend strength | ADX(14) | `ADX > 25 and +DI > −DI` | +1 | 1.5 | `min((ADX − 25)/25, 1)` |
| R16 | trend strength | ADX(14) | `ADX > 25 and −DI > +DI` | −1 | 1.5 | same, mirrored |
| R17 | trend strength | ADX(14) | `ADX < 20` | 0 | 0.5 | `min((20 − ADX)/10, 1)` — fires as a **dampener**, see 5.4 |
| R18 | breakout | close vs Donchian(20) | `close > max(high[0..19])` | +1 | 1.5 | 1.0 |
| R19 | breakout | close vs Donchian(20) | `close < min(low[0..19])` | −1 | 1.5 | 1.0 |
| R20 | volatility | Bollinger %B | `%B > 1` (close above upper band) | +1 | 1.0 | `min((%B − 1)/0.2, 1)` |
| R21 | volatility | Bollinger %B | `%B < 0` (close below lower band) | −1 | 1.0 | `min((1 − %B)/0.2, 1)` |
| R22 | volatility | Bollinger squeeze | `bandwidth < 0.10` | 0 | 0.5 | **dampener**, see 5.4 |
| R23 | volume | OBV confirmation | `OBV[t] > OBV[t−5]` and `close[t] > close[t−5]` | +1 | 1.0 | `min(((OBV[t]−OBV[t−5])/OBV[t−5])/0.10, 1)` |
| R24 | volume | OBV confirmation | `OBV[t] < OBV[t−5]` and `close[t] < close[t−5]` | −1 | 1.0 | same, mirrored |
| R25 | volume | CMF(20) | `CMF > 0.10` | +1 | 1.0 | `min(CMF/0.30, 1)` |
| R26 | volume | CMF(20) | `CMF < −0.10` | −1 | 1.0 | `min(−CMF/0.30, 1)` |
| R27 | volume | volume spike | `volume[t] > 2 * mean(volume[t−20..t−1])` | 0 | 0.5 | **context flag** only, contributes no direction |
| R28 | oscillator | Stochastic %K/%D | `%K > %D and %K > 80` | −1 | 0.75 | `min((%K − 80)/20, 1)` (overbought) |
| R29 | oscillator | Stochastic %K/%D | `%K < %D and %K < 20` | +1 | 0.75 | `min((20 − %K)/20, 1)` (oversold) |

`%B = (close − lower) / (upper − lower)`.
`bandwidth = (upper − lower) / middle`.

**Threshold justification.** `70`/`30` for RSI, `80`/`20` for Stochastic, `25`/`20` for ADX, and
`2.0` for Bollinger are the standard published levels (Wilder; John Bollinger's own rules;
J. Welles Wilder / CMT). `0.02` (2%) for the SMA200 buffer, `0.05` for the strength ramps, and
`0.35` for the decision threshold are our choices; each is a named constant in the source, not a
tuned magic number. **`2 * mean(volume[20])`** for the volume spike follows the conventional
"double the average volume" rule of thumb.

Total weight, non-dampener directional rules: `2+2+1.5+1.5+1+1+2+2+1+1+1.5+1.5+0.5+0.5+1.5+1.5+1.5+1.5+1+1+1+1+1+1+0.75+0.75 = 34.5`.
Confidence therefore cannot saturate from one family alone.

### 5.4 Dampeners

Three conditions **reduce** confidence rather than adding direction. Without them, a strong
signal inside a chop regime gets full confidence, which is precisely when signals fail.

```
rangeRegime  = ADX < 20                                   (R17)
squeeze      = Bollinger bandwidth < 0.10                 (R22)
thinHistory  = bars.length < 210                          (cannot assess R01/R02 at all)

finalConfidence = confidence * (1 - 0.40*[rangeRegime]) * (1 - 0.25*[squeeze])
finalConfidence = 0 if signal === 'HOLD'
```

The dampener penalties (`0.40`, `0.25`) are constants, stated here, and configurable. R27
(volume spike) is reported in the output as `volumeSpike: true` but never moves the score — a
volume spike is context, and letting it vote would double-count the information already carried
by OBV and CMF.

**Insufficient data** is handled by refusing to answer, not by guessing:

```
if bars.length < 60:
    return { signal: 'HOLD', confidence: 0, reason: 'INSUFFICIENT_DATA',
             requiredBars: 60, actualBars: bars.length }
```

`60` is the minimum that lets RSI(14), MACD, ADX(14), Stochastic, Bollinger(20), Donchian(20)
and CMF(20) all be defined with at least 20 bars of context each. Rules requiring SMA200 are
simply skipped (not fired, not penalised) when history is short; the output records
`rulesSkipped: ['R01','R02','R03','R04']`.

### 5.5 Output shape

```ts
export type Signal = 'BUY' | 'SELL' | 'HOLD';

export interface SignalRule {
  id: string;                  // 'R07'
  family: string;              // 'momentum'
  indicator: string;           // 'MACD(12,26,9)'
  direction: 1 | -1 | 0;
  fired: boolean;
  strength: number;            // 0..1
  weight: number;
  /** Human-readable numeric evidence, e.g. "macd=8.5826 > signal=8.1990". */
  evidence: string;
  /** The exact threshold used, e.g. "RSI(14)=78.4978 vs 70". */
  threshold: string;
}

export interface TradingSignal {
  symbol: string;
  timestamp: number;           // last bar
  signal: Signal;
  /** Signed score in [-1, 1] before damping. */
  score: number;
  confidence: number;          // 0..1, after damping
  dampeners: { rangeRegime: boolean; squeeze: boolean };
  rules: SignalRule[];         // ALL rules, fired or not — auditability
  rulesFired: number;
  rulesTotal: number;
  rulesSkipped: string[];
  reason: string;              // machine-readable slug, e.g. 'INSUFFICIENT_DATA' | 'OK'
}
generateTradingSignals(bars: readonly Bar[], symbol: string, opts?): TradingSignal
```

`rules` always contains every rule with `fired: false` where it did not fire. A user who
disagrees with the call has the full evidence in hand.

### 5.6 `interpretStock`

Narrative text assembled **only** from thresholds. No free-form generation.

```ts
export interface StockInterpretation {
  symbol: string;
  asOf: number;
  trend: 'STRONG_UPTREND' | 'UPTREND' | 'SIDEWAYS' | 'DOWNTREND' | 'STRONG_DOWNTREND' | 'UNKNOWN';
  momentum: 'STRONG_BULLISH' | 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'STRONG_BEARISH' | 'UNKNOWN';
  volatility: 'LOW' | 'MODERATE' | 'HIGH' | 'VERY_HIGH' | 'UNKNOWN';
  support: Level[];       // from §4.18
  resistance: Level[];
  signals: TradingSignal;
  outlook: string;        // fixed template, e.g. "Uptrend with weakening momentum (rule-based)."
  indicators: Record<string, number | null>;   // every value used, for transparency
  narrative: string[];    // bullet points, one per fired rule, each citing its id
}
```

Classification thresholds:

```
trend:   close vs SMA200 and SMA50 vs SMA200
         STRONG_UPTREND  if SMA50 > SMA200 * 1.05 and close > SMA200
         UPTREND         if SMA50 > SMA200 and close > SMA200
         DOWNTREND       if SMA50 < SMA200 and close < SMA200
         STRONG_DOWNTREND if SMA50 < SMA200 * 0.95 and close < SMA200
         SIDEWAYS        otherwise
         UNKNOWN         if any required value is null

momentum: from the momentum-family rules only (R07..R10, R11..R14)
         STRONG_BULLISH if score_momentum >= 0.75
         BULLISH        if >= 0.25
         NEUTRAL        if |score| < 0.25
         BEARISH / STRONG_BEARISH mirrored
         UNKNOWN        if momentum-family rules were skipped

volatility: from ATR(14)/close
         LOW        < 1.0%     (calm)
         MODERATE   1.0–2.0%
         HIGH       2.0–4.0%
         VERY_HIGH  > 4.0%
         UNKNOWN    if null
```

`outlook` and `narrative` are **templates with numbers substituted**. Example:

```
"UPTREND with WEAK momentum (rule-based; 6 of 26 rules fired, score +0.41, confidence 0.51)"
```

No free-text claims about what will happen next. `UNKNOWN` is a first-class value throughout —
"we don't know" is more useful than a fabricated classification when data is thin.

### 5.7 `marketSentiment` across a portfolio

Aggregates `TradingSignal` across symbols. Two distinct quantities are computed and both are
returned — conflating them is how most "market sentiment" numbers end up meaningless.

```
1. BREADTH (proportion of symbols bullish). Unweighted count:
     bullishShare = count(signal === 'BUY')  / n
     bearishShare = count(signal === 'SELL') / n
     neutralShare = count(signal === 'HOLD') / n

2. NET SENTIMENT (confidence-weighted, signed). This is the useful one:
     for each symbol s:  contribution =
         signal === 'BUY'  -> +confidence
         signal === 'SELL' -> -confidence
         signal === 'HOLD' -> 0
     netSentiment = sum(contributions) / n        in [-1, 1]

3. LABEL from netSentiment:
     STRONG_BULLISH  >=  0.50
     BULLISH         >=  0.15
     NEUTRAL         in (-0.15, 0.15)
     BEARISH         <= -0.15
     STRONG_BEARISH  <= -0.50
```

```ts
export interface MarketSentiment {
  overallSentiment: 'STRONG_BULLISH' | 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'STRONG_BEARISH'
                    | 'INSUFFICIENT_DATA';
  /** Signed, confidence-weighted, in [-1, 1]. */
  netSentiment: number | null;
  /** Unweighted proportions; they sum to 1. */
  breadth: { bullishShare: number | null; bearishShare: number | null; neutralShare: number | null };
  bullishStocks: number;
  bearishStocks: number;
  neutralStocks: number;
  /** Symbols that did not produce a usable signal (insufficient data / throw). */
  excludedSymbols: string[];
  perSymbol: Record<symbol, { signal: Signal; confidence: number; score: number }>;
}
marketSentiment(portfolio: Record<symbol, readonly Bar[]>, opts?): MarketSentiment
```

Rules:

- Symbols with insufficient bars go to `excludedSymbols` and are **excluded from the
  denominator**, not counted as neutral. Counting them as neutral would make a thin portfolio
  look calm rather than unknown.
- If **every** symbol is excluded, `overallSentiment = 'INSUFFICIENT_DATA'` and every numeric
  field is `null`. Never return `NEUTRAL` for "no data".
- Per-symbol failures are caught and recorded; one bad symbol must not fail the whole portfolio.
- `netSentiment` is `null` when `n === 0`. `breadth` shares are `null` when `n === 0`.
- Iteration is over `Object.keys(portfolio).sort()` so the result is order-stable.

### 5.8 Worked example

Dataset A, symbol `"OGDC"`, evaluated at the last bar (index 14), using only rules that are
defined on 15 bars (R01–R06 are skipped — `SMA200` is `null`).

Indicator values at index 14:
```
close        = 87.29
SMA5         = 86.8040     SMA10 = 85.2910
SMA200       = null        (skipped: R01, R02, R03, R04)
RSI(5)       = 78.4978     (note: RSI(5), not 14 — 15 bars is not enough for RSI(14))
MACD(2,5,9)  = hist -0.079967, macd 0.620681, signal 0.700648
ADX(5)       = 55.8343     +DI 42.9490, -DI 6.1426
Stoch(5,3,3) = %K 82.1159, %D 83.1263
BB(5,2)      = upper 88.319129, middle 86.804000, lower 85.288871
ATR(5)       = 1.143678    ATR/close = 1.3102%
OBV          = 29,450,200  (down from 34,258,100 three bars ago)
CMF(5)       = 0.530400
ret(14)      = -0.005469   5-bar mean return = +0.006876
```

Rules evaluated:

| Rule | Condition | Value | Fired | Strength | Dir |
|---|---|---|---|---|---|
| R07 | macd > signal | `0.6207 < 0.7006` | no | — | — |
| R08 | macd < signal | yes | **yes** | 1.00 | −1 |
| R10 | hist[t] < hist[t−3] | `-0.0800 < 0.2468` | **yes** | 1.00 | −1 |
| R12 | RSI > 70 | `78.4978 > 70` | **yes** | 0.85 | −1 |
| R15 | ADX > 25 and +DI > −DI | `55.83 > 25`, `42.95 > 6.14` | **yes** | 1.00 | +1 |
| R18 | close > Donchian(20) high | 20-bar history unavailable | no | — | — |
| R21 | %B < 0 | `%B = 0.6604` | no | — | — |
| R24 | OBV down and close down | `29.45M < 34.26M`, `87.29 < 87.77` | **yes** | 1.00 | −1 |
| R25 | CMF > 0.10 | `0.5304 > 0.10` | **yes** | 1.00 | +1 |
| R28 | %K > %D and %K > 80 | `82.12 < 83.13` | no | — | — |

Score:
```
directional weights in play = 2.0 (R08) + 1.0 (R10) + 1.5 (R12) + 1.5 (R15) + 1.0 (R24) + 1.0 (R25)
                            = 8.0
total weight over all non-skipped rules = 25.0   (R01..R04 excluded: SMA200 is null)

R12 strength = min((78.4978 - 70)/10, 1) = 0.8498

score = ( -1*2.0*1.0000  +  -1*1.0*1.0000  +  -1*1.5*0.8498
        +  1*1.5*1.0000  +  -1*1.0*1.0000  +  1*1.0*1.0000 ) / 25.0
      = ( -2.0000 - 1.0000 - 1.2747 + 1.5000 - 1.0000 + 1.0000 ) / 25.0
      = -2.7747 / 25.0
      = -0.1110
```

`|-0.111| = 0.111 < 0.35` -> **signal = HOLD**, `confidence = 0`.
Dampeners: `rangeRegime = false` (ADX 55.8), `squeeze = false` (bandwidth
`(88.319 − 85.289)/86.804 = 0.0349 < 0.10` -> **true**), so `confidence *= 0.75` — moot,
since HOLD confidence is 0 anyway.

This is the correct answer and it is worth sitting with: **overbought RSI, a bearish MACD
crossover, a declining OBV — and the call is still HOLD**, because the 15-bar sample is too
short to score the trend rules and the volume/ADX evidence cuts the other way. A system that
emitted `SELL` here on three of six signals would be over-reading a 15-day window.

`interpretStock` output for the same bar:
```
trend      = UNKNOWN    (SMA200 is null -> cannot classify)
momentum   = BEARISH
             momentum family = R07, R08, R09, R10, R11, R12, R13, R14
             family score = (-2.0000 - 1.0000 - 1.2747) / 10.0 = -0.4275
             -0.4275 <= -0.25 -> BEARISH
volatility = MODERATE   (ATR/close = 1.3102% -> in [1.0, 2.0))
support    = [84.0300 (touches 1), 82.3000 (touches 1)]
resistance = []                                  // see note below
signals    = HOLD, confidence 0, score -0.1110
outlook    = "UNKNOWN trend with BEARISH momentum (rule-based; 6 of 21 rules fired,
              score -0.1110, confidence 0)"
```

**Note on the empty resistance list — this is the algorithm working, not failing.** With
`pivotLookback = 2` and the strict rule (a pivot high must exceed every bar in its ±2 window
*and* the first and last 2 bars can never be pivots), dataset A yields **zero** pivot highs: the
15-bar series is close to monotonically rising, so every candidate high is matched or beaten by a
neighbour within 2 bars. Pivot lows occur at indices 7 and 10 (`82.30`, `84.03`), both below the
final close, so both classify as support and neither cluster merges (they are 2.1% apart, above
the 1% tolerance).

The correct reading: **15 bars cannot support meaningful support/resistance detection.** That is
why §5.4 sets a 60-bar minimum and why `interpretStock` returns `UNKNOWN` for trend on this
fixture. Do not add a fallback that invents levels when detection finds none — an empty list is
the truthful answer, and §9 item 3 records that this layer has no reference implementation to
validate against in the first place.

---

## 6. Master edge-case matrix

Read this before writing any test. `n` is `bars.length`; `warmup` is the indicator's own warmup.

| Situation | SMA / EMA / WMA | RSI | ATR / ADX | MACD | OBV / ADL | Volume-based (MFI, CMF, VWAP) | Scalar metrics |
|---|---|---|---|---|---|---|---|
| **Empty array** `[]` | `[]` | `[]` | `[]` | `[]` | `[]` | `[]` | all `null` |
| **Single bar** | `[]` for `n>=2`; `[x]` for `n===1` | `[]` | `[]` (`warmup >= 1`) | `[]` | `[0]` / `[mfm*v]` | `[null]` (VWAP `[]` unless anchor 0) | `null` (needs `n>=2`) |
| **Two bars** | `[]` for `n>=3` | `[]` (needs 15 for default 14) | `[null]` | `[]` | 2 values | VWAP `[tp0, tp1]` | totalReturn works; vol/sharpe `null` (`n<2` returns) |
| **Constant prices** (zero variance) | normal values, no error | **`null`** (`avgGain+avgLoss===0`) | `0` for ATR; **`null`** for `+DI`,`−DI`,`DX` (`TR_n===0`) | `0` lines, `0` signal after warmup | `obv` constant; `ad` constant | MFI `null`; CMF `0`; VWAP `= price` | vol `0`; sharpe **`null`**; sortino **`null`**; beta **`null`**; corr **`null`**; skew/kurt **`null`**; VaR `0` |
| **Shorter than warmup** | all `null`, length preserved | all `null` | all `null` | all `null` | full length (warmup 0) | all `null` | `null` where the metric needs the missing data |
| **Monotonically rising** | normal | `100` (`avgLoss===0`) | `+DI` high, `−DI` 0, `DX` 100, `ADX` 100 | positive, rising | `obv` = cumsum of volume | MFI `100`; CMF → 1 | `maxDrawdown = 0` -> calmar `null`, recoveryFactor `null` |
| **Monotonically falling** | normal | `0` (`avgGain===0`) | `−DI` high | negative | `obv` negative | MFI `0`; CMF → −1 | same as above |
| **`high === low` on some bars** | unaffected | unaffected | `TR` unaffected (`TR` uses prior close) | unaffected | unaffected | **A/D, MFI, CMF: that bar contributes `0`** | unaffected |
| **All volumes `0`** | unaffected | unaffected | unaffected | unaffected | `obv` flat `0`; `ad` flat `0` | VWAP `null`; CMF `null`; MFI `null` | unaffected |
| **`close === 0`** on some bar | unaffected | unaffected | unaffected | unaffected | unaffected | unaffected | that bar's return `null`; excluded from mean/std (`n` shrinks) |
| **Unsorted timestamps** | n/a (no timestamp) | n/a | n/a | n/a | n/a | n/a | **throws `OrderError`** (§1.2) |
| **Duplicate timestamp** | — | — | — | — | — | — | **throws `DataError`** |
| **`high < low`** | — | — | **throws `DataError`** at ingest | — | — | **throws `DataError`** | — |

Two policies stated explicitly because implementations usually differ:

1. **Insufficient data returns `null`, never throws.** Only genuinely invalid input (bad order,
   duplicate timestamps, impossible OHLC, non-finite numbers, out-of-range parameters) throws.
2. **A zero-variance input is a legitimate measurement, not an error.** ATR of 0, volatility of
   0, OBV of a constant — all return a real number. Only *ratios* whose denominator is zero return
   `null`.

---

## 7. Test-vector datasets

### 7.1 Dataset A — "TULIP", 15 bars

Real Tulip Indicators example data (2005-11-01 → 2005-11-21), 2-decimal prices and
comma-formatted volumes in the original; volumes given here as plain integers.

```
date        high     low      close    volume
2005-11-01  82.15    81.29    81.59    5653100
2005-11-02  81.89    80.64    81.06    6447400
2005-11-03  83.03    81.31    82.87    7690900
2005-11-04  83.30    82.65    83.00    3831400
2005-11-07  83.85    83.07    83.61    4455100
2005-11-08  83.90    83.11    83.15    3798000
2005-11-09  83.33    82.49    82.84    3936200
2005-11-10  84.30    82.30    83.99    4732000
2005-11-11  84.84    84.15    84.55    4841300
2005-11-14  85.00    84.11    84.36    3915300
2005-11-15  85.90    84.03    85.53    6830800
2005-11-16  86.58    85.39    86.54    6694100
2005-11-17  86.98    85.76    86.89    5293600
2005-11-18  88.00    87.17    87.77    7985800
2005-11-21  87.87    87.01    87.29    4807900
```

`timestamps` must be strictly increasing; any synthetic increasing values work (`i * 86400000`).

**Why 15 bars is the awkward minimum:** it is exactly enough for `RSI(14)` (needs 15) and not
enough for `SMA(200)`. Use it to test the `INSUFFICIENT_DATA` and `rulesSkipped` paths.

Vectors published for dataset A in this spec: SMA5, EMA5 (both seeds), WMA5, DEMA5, TEMA5, HMA5,
Bollinger(5,2), ATR5 (both TR conventions), RSI5, Stochastic(5,3,3), Williams %R5, CCI5, Aroon5,
OBV, ADL, VWAP (both anchors), MFI5, CMF5, Donchian(10), PSAR seed inputs.

### 7.2 Dataset B — "SYNTH", 40 bars

Fully synthetic, generated by a formula so the expected values are reproducible from first
principles rather than copied from anyone's table.

```ts
for (let i = 0; i < 40; i++) {
  const c     = round2(100 + 1.2*i + 3*Math.sin(i * 0.7));
  high[i]     = round2(c + 0.8 + 0.6*Math.abs(Math.cos(i * 1.1)));
  low[i]      = round2(c - 0.8 - 0.6*Math.abs(Math.sin(i * 0.9)));
  open[i]     = i === 0 ? c : round2((close[i-1] + c)/2);
  close[i]    = c;
  volume[i]   = 1000000 + 23456*i;
}
function round2(x) { return Math.round(x*100)/100; }
```

Resulting arrays:

```
close  = [100, 103.13, 105.36, 106.19, 105.8, 104.95, 104.59, 105.45, 107.71, 110.85,
          113.97, 116.16, 116.96, 116.56, 115.7, 115.36, 116.26, 118.55, 121.7, 124.81,
          126.97, 127.74, 127.31, 126.45, 126.14, 127.07, 129.39, 132.55, 135.65, 137.78,
          138.51, 138.06, 137.21, 136.91, 137.88, 140.23, 143.4, 146.48, 148.58, 149.28]

high   = [101.4, 104.2, 106.51, 107.58, 106.78, 106.18, 105.96, 106.34, 109, 112.18,
          114.77, 117.5, 118.24, 117.46, 117.07, 116.58, 117.25, 119.94, 122.85, 125.89,
          128.37, 128.81, 128.47, 127.84, 127.12, 128.3, 130.76, 133.44, 136.94, 139.11,
          139.32, 139.4, 138.49, 137.81, 139.25, 141.45, 144.39, 147.87, 149.72, 150.36]

low    = [99.2, 101.86, 103.98, 105.13, 104.73, 103.56, 103.33, 104.64, 106.43, 109.47,
          112.92, 115.09, 115.57, 115.3, 114.88, 114.08, 114.88, 117.51, 120.62, 123.42,
          125.72, 126.91, 126.02, 125.07, 125.11, 125.98, 128, 131.31, 134.81, 136.49,
          137.14, 137.04, 136.11, 135.52, 136.64, 139.38, 142.1, 145.11, 147.57, 148.17]

open   = [100, 101.57, 104.25, 105.78, 106, 105.38, 104.77, 105.02, 106.58, 109.28,
          112.41, 115.07, 116.56, 116.76, 116.13, 115.53, 115.81, 117.41, 120.13, 123.26,
          125.89, 127.35, 127.53, 126.88, 126.3, 126.6, 128.23, 130.97, 134.1, 136.72,
          138.14, 138.29, 137.64, 137.06, 137.39, 139.06, 141.82, 144.94, 147.53, 148.93]

volume = [1000000, 1023456, 1046912, 1070368, 1093824, 1117280, 1140736, 1164192, 1187648,
          1211104, 1234560, 1258016, 1281472, 1304928, 1328384, 1351840, 1375296, 1398752,
          1422208, 1445664, 1469120, 1492576, 1516032, 1539488, 1562944, 1586400, 1609856,
          1633312, 1656768, 1680224, 1703680, 1727136, 1750592, 1774048, 1797504, 1820960,
          1844416, 1867872, 1891328, 1914784]
```

Benchmark series for beta/alpha/IR (§3.10, §3.12) — same generator, different phase:

```
KSE100 = [102.02, 103.2, 103.67, 103.53, 103.06, 102.63, 102.6, 103.22, 104.55, 106.42,
          108.52, 110.47, 111.92, 112.7, 112.79, 112.42, 111.92, 111.68, 112.01, 113.04,
          114.71, 116.76, 118.82, 120.52, 121.6, 121.96, 121.75, 121.26, 120.87, 120.93,
          121.66, 123.08, 125.01, 127.11, 129, 130.37, 131.03, 131.04, 130.62, 130.14]
```
Generator: `round2(100 + 0.8*i + 2.4*Math.sin(i*0.55 + 1.0))`.

Dataset B's 39 simple returns:

```
[ 0.031300,  0.021623,  0.007878, -0.003673, -0.008034, -0.003430,  0.008223,  0.021432,
  0.029152,  0.028146,  0.019216,  0.006887, -0.003420, -0.007378, -0.002939,  0.007802,
  0.019697,  0.026571,  0.025555,  0.017306,  0.006064, -0.003366, -0.006755, -0.002452,
  0.007373,  0.018258,  0.024422,  0.023387,  0.015702,  0.005298, -0.003249, -0.006157,
 -0.002186,  0.007085,  0.017044,  0.022606,  0.021478,  0.014336,  0.004711]
```

**Dataset B Part 1 expected values** — `periodsPerYear = 252`, `riskFreeRate = 0.10`,
`method = 'simple'`, `nBars = 40`, `nReturns = 39`. All `[V-CALC]`.

```
totalReturn              =  0.4928000000     (87.29/81.59 style; here 149.28/100 - 1)
yearsElapsed             =  0.1547619048     (39/252)
cagr                     = 12.3142958014
annualizedVolatility     =  0.1935677696
meanReturn               =  0.0103978060
stdReturn (ddof=1)       =  0.0121936233
sharpe (rf=0.10)         =  0.05166656
sharpe (rf=0)            =  0.05371662
sortino (rf=0.10)        = 55.01591936
calmar                   = 817.28441947
maxDrawdown              = -0.0150673321     (at index 6)
longestDrawdownBars      =  4                (indices 4..7)
recoveryFactor           = 99.07527000
beta (vs KSE100)         =  0.08613041
treynor (rf=0.10)        = 29.26082911
informationRatio         =  4.57371499
alphaAnnualized          =  2.39226410
correlation (vs KSE100)  =  0.05718927
covariance (vs KSE100)   =  0.0000056460
var                      =  0.0001486845
historicalVaR 95%        = -0.0073781743
historicalCVaR 95%       = -0.0077061004
historicalVaR 99%        = -0.0080340265
historicalCVaR 99%       = -0.0080340265
skewness (bias-corrected)=  0.01434253
kurtosisExcess           = -0.03689752
autocorrelation lag 1    =  0.73967968
```

Drawdown series (all 40 bars, normalised equity, `[-1, 0]`):

```
[  0.00000000,  0.00000000,  0.00000000,  0.00000000, -0.00367266, -0.01167718,
  -0.01506733, -0.00696864,  0.00000000,  0.00000000,  0.00000000,  0.00000000,
   0.00000000, -0.00341997, -0.01077291, -0.01367989, -0.00598495,  0.00000000,
   0.00000000,  0.00000000,  0.00000000,  0.00000000, -0.00336621, -0.01009864,
  -0.01252544, -0.00524503,  0.00000000,  0.00000000,  0.00000000,  0.00000000,
   0.00000000, -0.00324886, -0.00938560, -0.01155151, -0.00454841,  0.00000000,
   0.00000000,  0.00000000,  0.00000000,  0.00000000]
```

**Dataset A Part 1 expected values** — 15 bars, 14 returns, `periodsPerYear = 252`,
`rf = 0.10`. All `[V-CALC]`.

```
returns = [-0.006496, 0.022329, 0.001569, 0.007349, -0.005502, -0.003728, 0.013882,
            0.006667, -0.002247, 0.013869, 0.011809, 0.004044, 0.010128, -0.005469]

totalReturn             =  0.0698615026
yearsElapsed            =  0.0515873016     (14/252)
cagr                    =  2.3720661572     <-- extrapolated, NOT a measurement
annualizedVolatility    =  0.1414391000
sharpe (rf=0)           =  0.03444441
sharpe (rf=0.10)        =  0.03163879
sortino (rf=0.10)       = 22.40696082
maxDrawdown             = -0.0092094247     (at indices 5..6)
longestDrawdownBars     =  2
recoveryFactor          =  7.58587044
historicalVaR 95%       = -0.0064958941
historicalCVaR 95%      = -0.0064958941
skewness                =  0.32427591
kurtosisExcess          = -0.05153384
autocorrelation lag 1   = -0.36740467
```

**This 14-return fixture is a trap, deliberately.** Every annualized number in it is nonsense
(237% CAGR, 22x Sortino) and the VaR/CVaR are degenerate because `k = floor(0.05 * 14) = 0`
makes VaR the single worst return. Use it to assert that the code reproduces these exact
numbers — not to sanity-check whether they are reasonable.

**Correlation / covariance matrices for dataset A** — 14 returns from four series:

```
OGDC closes   = [81.59, 81.06, 82.87, 83.00, 83.61, 83.15, 82.84, 83.99, 84.55, 84.36,
                 85.53, 86.54, 86.89, 87.77, 87.29]
KSE100 closes = [100,   99.5,  101.2, 101.8, 102.4, 102.0, 101.6, 102.9, 103.5, 103.9,
                104.6,  105.3, 105.9, 106.5, 107.1]
BANK closes   = [50,    49.8,  50.9,  51.3,  51.8,  51.2,  50.7,  51.5,  52.2,  52.6,
                 53.3,  54.0,  54.4,  55.1,  54.5]
ENGRO closes  = [300,   301.5, 299.0, 302.4, 306.8, 304.1, 301.2, 305.9, 309.6, 307.2,
                311.5, 315.8, 318.2, 322.5, 320.1]

per-series std (ddof=1):
  OGDC   0.00890983    KSE100 0.00605438    BANK 0.01084162    ENGRO 0.01047647

correlation matrix (row, col order = OGDC, KSE100, BANK, ENGRO):
  OGDC   [ 1.00000000,  0.85055735,  0.90015890,  0.45415196]
  KSE100 [ 0.85055735,  1.00000000,  0.81712220,  0.29017375]
  BANK   [ 0.90015890,  0.81712220,  1.00000000,  0.57144125]
  ENGRO  [ 0.45415196,  0.29017375,  0.57144125,  1.00000000]

covariance matrix (ddof=1):
  OGDC   [0.0000793850, 0.0000458821, 0.0000869526, 0.0000423921]
  KSE100 [0.0000458821, 0.0000366556, 0.0000536354, 0.0000184053]
  BANK   [0.0000869526, 0.0000536354, 0.0001175408, 0.0000649054]
  ENGRO  [0.0000423921, 0.0000184053, 0.0000649054, 0.0001097564]
```

Beta and correlation, simple vs log returns — the §3.0 divergence, made concrete:

```
beta(simple returns) = 1.25170734
beta(log returns)    = 1.24921628
```

---

## 8. Library disagreement matrix

Every row is a real, verified difference. "Ours" is what §4 specifies.

| Indicator | TA-Lib | tulip / tulipy | `technicalindicators` (npm) | pandas | **Ours** |
|---|---|---|---|---|---|
| **EMA seed** | SMA of first `n` | `ema[0] = in[0]` | SMA of first `n` | `adjust=False` = SMA seed; default `adjust=True` is a *different* function | **SMA seed** |
| **EMA first output** | index `n−1` | index `0` | index `n−1` | index `n−1` | **`n−1`** |
| **RSI seed** | SMA of first `n` gains/losses | SMA of first `n` | SMA of first `n` | `ewm` seed differs | **SMA seed** |
| **RSI first output** | index `n` | index `n` | index `n` | — | **`n`** |
| **RSI flat window** | `0` | `100` | `100` | — | **`null`** |
| **RSI rounding** | none | none | 2 decimals | none | **none** |
| **ATR `TR[0]`** | not defined | `high[0]−low[0]` | TrueRange `null` at 0 | — | **not defined** |
| **ATR first output** | index `n` | index `n−1` | index `n` | — | **`n`** |
| **ATR smoothing** | Wilder | Wilder | Wilder (`WEMA`) | — | **Wilder** |
| **Bollinger sd** | population (`/n`) | population (`/n`) | population (`/period`) | **`ddof=1`** by default | **population** |
| **MACD first output** | `slow + signal − 2` | `slow − 1` | `slow − 1` | varies | **`slow + signal − 2`** |
| **MACD signal seed** | SMA of first `signalPeriod` MACD values | first MACD value | first MACD value | varies | **SMA of first `signalPeriod`** |
| **MACD period swap** | silently swaps if `slow < fast` | — | — | — | **throws** |
| **ADX warmup** | `2n − 1` | `2n − 3` (published `dx` column) | — | — | **`2n − 1`** |
| **Aroon window** | `n+1` bars incl. current | `n+1` bars incl. current | — | — | **`n+1` incl. current** |
| **Aroon ties** | most recent wins | most recent wins | — | — | **most recent** |
| **Stoch `%D` smoothing** | SMA (default `TA_MAType_SMA`) | SMA | SMA | — | **SMA** |
| **Williams %R** | `willr` = fastK − 100 | same | same | — | **same** |
| **OBV seed** | `obv[0] = volume[0]` | `obv[0] = 0` | `obv[0] = 0` | manual | **`0`** |
| **ADL zero-range bar** | n/a | `mfm = 0` | n/a | n/a | **`mfm = 0`** |
| **PSAR clamp** | two-bar range clamp, SAR emitted pre-advance | different seed order | absent | n/a | **TA-Lib's** |
| **Return std `ddof`** | n/a | n/a | n/a | `1` | **`1`** |
| **Input order** | ascending | ascending | **newest-first** (`reverseInputs`) | n/a | **ascending, enforced** |

Tulip note on ADX: tulipindicators.org's `adx` page publishes a table whose column is headed `dx`
but whose values do not reproduce under any of the seeding variants we tried (EMA-like from index
0, or a sum seeded at `n−1`), and whose first populated row lands at index `n + 3`. Treat the
published ADX example table as unreliable and validate ADX against TA-Lib's
`ta_ADX.c` documentation, which we have transcribed in full in §4.13.

---

## 9. Open questions and things we could not verify

Honest inventory. These are real gaps, not hedges.

1. **RSI on a completely flat window — three-way disagreement, no consensus.** TA-Lib gives `0`,
   tulip and `technicalindicators` give `100`, this spec gives `null`. None is "wrong" but they are
   irreconcilable. Chosen `null` because a flat window means the oscillator is undefined, and
   picking either `0` or `100` asserts a directional claim the data does not support. If a user
   reports "RSI shows 0 on a suspended stock", that is TA-Lib's behaviour, not a bug here.

2. **Cutler's RSI is missing.** It is a legitimately different indicator (simple MA of gains and
   losses) that many Python users mean when they say "RSI" without qualification. It is not
   implemented here and should be a separate function, not an option.

3. **Support/resistance and chart patterns have no reference implementation.** The thresholds in
   §4.18–4.19 are our design. They are deterministic and fully specified, but there is no
   ground truth to validate against and no way to prove the choices are good. Test them for
   *determinism* (same input, same output) and for *reasonableness on real PSX data*, not for
   accuracy against some ground truth.

4. **Supertrend is a community script, not a standard.** The Pine v5 semantics are public and we
   reproduce them, but TradingView itself has shipped variants, and there is no version number to
   pin. The `base: 'hl2' | 'hl'` option exists because this genuinely matters.

5. **PSAR is the least standardized indicator here.** No two retail platforms agree. Our TA-Lib
   transcription is the most defensible reference available, but "PSAR" as a concept is
   under-specified. Do not promise cross-platform parity.

6. **Tulip's published `dx` table for ADX could not be reproduced** under any seeding variant
   tested (§8). Whether the published table or our implementation is wrong is unresolved.

7. **`252` is a PSX-specific assumption we could not verify against PSX practice.** PSX has
   roughly 245–250 trading days per year depending on the year (extensive holiday lists), not
   252. Using `252` overstates annualization slightly. We keep `252` because that is what the
   standard libraries use and cross-library comparability matters more than a 1% bias — but it is
   a real bias, and `periodsPerYear` is exposed so a user can pass `246` if they want precision.

8. **The `empyrical.annualize_return` and `calmar_ratio` divergences are documented but
   deliberate.** Anyone porting empyrical code will get different numbers from our `cagr` and
   `calmar`. We believe ours are correct and theirs are not, but this is a judgement call and we
   have recorded it rather than buried it.

9. **`pypsx_toolkit`'s declared defaults are suspect and we did not follow them.** Its stub
   signatures use `risk_free_rate = 0.10` for Sharpe and `0.08` in `portfolio_analysis` — two
   different defaults in the same module. We default to `0` and require the caller to pass the
   prevailing rate explicitly. A hardcoded 10% PSX risk-free rate is not defensible for a general
   library.

10. **`technicalindicators` reverses its inputs internally.** Its bundle calls
    `Indicator.reverseInputs(input)` at the top of every top-level function and its README shows
    a `reversedInput: true` option, which is the package's way of accepting newest-first input
    while internally working oldest-first. If you port from that package, reverse your arrays
    first or every number will be wrong with no error. Note that the reversal happens *inside* the
    package, so it is invisible if you only read the indicator classes.

11. **Numerics on exotic inputs are unverified.** Our stability analysis (§2.5) covers the
    catastrophic-cancellation cases we anticipated. We have not fuzz-tested against pathological
    inputs (all-identical prices mixed with a single spike, subnormal values, volumes spanning 12
    orders of magnitude). Those are real risks worth a fuzz pass before release.

---

## 10. Sources

**Books and primary sources**

- Wilder, J. Welles (1978), *New Concepts in Technical Trading Systems*. The origin of RSI, ATR,
  ADX/DMI, Parabolic SAR. TA-Lib's source comments reproduce Wilder's definitions closely enough
  that §4.13 reads as a direct transcription.
- Bollinger, John A. (2001), *Bollinger on Bollinger Bands*. McGraw-Hill.
- Murphy, J. (1999), *Technical Analysis of the Financial Markets*. 4th ed. Thomson.
- Achelis, S. (2000), *Technical Analysis from A to Z*, 2nd ed. McGraw-Hill.
- Kaufman, Perry J. (2013), *Trading Systems and Methods*, 6th ed. McGraw-Hill.
- Chande, Tushar S. (1994), *The New Technical Trader*. Basis for Cutler's RSI and CMO.
- Lane, George (1984), *Lane's Oscillator*. Stochastic oscillator.

**Reference implementations read directly for this spec**

- TA-Lib C source, `TA-Lib/ta-lib` branch `dev`:
  `ta_RSI.c`, `ta_EMA.c`, `ta_MACD.c`, `ta_ADX.c`, `ta_ATR.c`, `ta_STDDEV.c`, `ta_VAR.c`,
  `ta_AROON.c`, `ta_SAR.c`, `ta_VWAP.c`, `ta_OBV.c`, `ta_STOCH.c`, `ta_TRANGE.c`.
  Specific findings that shaped this spec: the EMA SMA seed; the MACD seed-and-warmup comment;
  the `TA_IS_ZERO` bug discussion in `ta_RSI.c` and `ta_STDDEV.c`; the shifted-variance comment
  in `ta_VAR.c`; `TA_RSI_Lookback = n` and `TA_ADX_Lookback = 2n − 1`.
- tulipindicators.org, published formulas and worked example tables for `sma`, `ema`, `wma`,
  `rsi`, `atr`, `bbands`, `stoch`, `willr`, `cci`, `mfi`, `ad`, `aroon`, `obv`, `macd`, `adx`.
  Source for the tulip-side vectors in this spec and for the `first-value` EMA seed.
- npm `technicalindicators@3.1.0`, bundled `dist/index.js` (repo `anandanand84/technicalindicators`).
  Classes `EMA`, `SD`, `BollingerBands`, `RSI`, `AverageGain`, `AverageLoss`, `WMA`, `OBV`,
  `VWAP`, `ATR`, `ADX`, `WilderSmoothing`, `WEMA`, `PDM`, `MDM`, `TrueRange`. Confirmed by
  reading the bundle: SMA-seeded EMA, population `SD`, RSI's zero-checks and 2-decimal
  rounding, VWAP over typical price `(H+L+C)/3` with cumulative sums and no session reset, and
  `Indicator.reverseInputs(input)` called on every input.
- `quantopian/empyrical@master`, `empyrical/stats.py`. Confirmed `annualization_factor`
  defaults (`daily: 252`), `downside_risk_ratio`'s all-observations convention, and the
  `annualize_return` / `calmar_ratio` formulations we diverge from.
- `robertmartin8/PyPortfolioOpt`, `pypfopt/base_optimizer.py`. 252-day annualization.

**Reference (non-code) sources for conventions and thresholds**

- Fidelity Learning Center, *Technical Indicator Guide* (ADX, ATR, Bollinger Bands, MACD, RSI,
  Stochastic Oscillator). The standard secondary reference for the interpretation bands used in
  §5.3 and §5.6.
- Investopedia, entries for RSI, MACD, Bollinger Bands, Sharpe Ratio, Sortino Ratio, Calmar
  Ratio, Treynor Ratio, Information Ratio, Jensen's Alpha, Keltner Channels, Aroon, Parabolic
  SAR, PSX trading calendar. Secondary and not authoritative where it conflicts with Wilder; used
  for cross-checking conventional threshold values only.
- Sharpe, W. (1966), "Capital Asset Prices: A Theory of Market Equilibrium under Conditions of
  Risk", *Journal of Finance* 21(4). Origin of the Sharpe ratio and its simple-return definition.
- Sortino, F. & Price, L. (1994), "Performance Measurement in a Downside Risk Framework",
  *Journal of Investing* 3(3). Origin of downside-risk-based ratios; basis for §3.5's MAR
  convention.
- Calmar, C. (1965), as documented by Bacon. Origin of the return/max-drawdown ratio.
- Jegadeesh, N. & Titman, S. (1993), "Returns to Buying Winners and Selling Losers", *Journal of
  Finance* 48(1). Justifies the 12-month momentum window behind §5.3 R09/R10.
- RiskMetrics (1996), *RiskMetrics Technical Specification*. Origin of the 252-day
  annualization convention for daily risk metrics, and of `VaR`/`Expected Shortfall` practice.

**Project-local references**

- The (now removed) psx-data-reader -- PSX OHLCV column names and its ascending-order sort.
- `ref/pypsx_toolkit-3.1.2/pypsx_toolkit-3.1.2/pypsx_toolkit/analysis/__init__.pyi` — the
  intended public signatures, return-tuple orderings, and documented defaults this spec
  deliberately departs from where they are wrong or inconsistent.
- `ref/pypsx_toolkit-3.1.2/pypsx_toolkit-3.1.2/pypsx_toolkit/models.py` — `EODBar` field
  definitions, including which OHLC fields are `Optional`.

---

## Appendix A — API surface

```ts
// ---- errors ----
export class DataError extends Error {}    // invalid input data (NaN, high<low, dup ts)
export class OrderError extends DataError {} // timestamps not strictly ascending
export class RangeError extends Error {}   // out-of-range parameter

// ---- core ----
export function simpleReturns(close: readonly number[]): (number | null)[]
export function logReturns(close: readonly number[]): (number | null)[]

// ---- Part 1: performance ----
export function cumulativeReturns(close: readonly number[]): (number | null)[]
export function totalReturn(close: readonly number[]): number | null
export function annualizedReturn(close, opts?): AnnualizedReturn
export function annualizedReturnFromBars(bars: readonly Bar[], opts?): AnnualizedReturn
export function annualizedVolatility(close, opts?): number | null
export function sharpeRatio(close, opts?): number | null
export function sortinoRatio(close, opts?): number | null
export function calmarRatio(close, opts?): number | null
export function drawdown(close): (number | null)[]
export function drawdownStats(close): DrawdownStats
export function recoveryFactor(close): number | null
export function beta(asset, benchmark, opts?): number | null
export function jensenAlpha(asset, benchmark, opts?): { perPeriod: number|null; annualized: number|null }
export function treynorRatio(asset, benchmark, opts?): number | null
export function informationRatio(asset, benchmark, opts?): number | null
export function historicalVaR(close, opts?): number | null
export function historicalCVaR(close, opts?): number | null
export function correlation(a, b, opts?): number | null
export function covarianceMatrix(series, opts?): Record<string, Record<string, number|null>>
export function correlationMatrix(series, opts?): Record<string, Record<string, number|null>>
export function skewness(returns, opts?): number | null
export function kurtosis(returns): Kurtosis
export function autocorrelation(returns, lag = 1): number | null
export function winRate(trades: readonly Trade[]): number | null
export function profitLossRatio(trades: readonly Trade[]): number | null
export function performanceSummary(bars, opts?): PerformanceSummary

// ---- Part 2: indicators ----
export function sma(source, n): (number | null)[]
export function ema(source, n, opts?): (number | null)[]
export function wma(source, n): (number | null)[]
export function dema(source, n, opts?): (number | null)[]
export function tema(source, n, opts?): (number | null)[]
export function hma(source, n): (number | null)[]
export function bollingerBands(close, opts?): BollingerBands
export function donchianChannel(bars, n?): { upper; lower; middle }
export function keltnerChannel(bars, opts?): KeltnerChannel
export function atr(bars, n = 14): (number | null)[]
export function trueRange(bars): (number | null)[]
export function rsi(source, n = 14): (number | null)[]
export function macd(bars, opts?): Macd
export function stochastic(bars, opts?): Stochastic
export function williamsR(bars, n = 14): (number | null)[]
export function cci(bars, n = 20): (number | null)[]
export function roc(source, n = 12): (number | null)[]
export function momentum(source, n = 10): (number | null)[]
export function trix(source, n = 15): (number | null)[]
export function ultimateOscillator(bars, opts?): (number | null)[]
export function adx(bars, n = 14): Adx
export function aroon(bars, n = 14): { up; down }
export function psar(bars, opts?): Psar
export function supertrend(bars, opts?): Supertrend
export function obv(bars): number[]
export function vwap(bars, opts?): (number | null)[]
export function mfi(bars, n = 14): (number | null)[]
export function accumulationDistribution(bars): number[]
export function chaikinMoneyFlow(bars, n = 20): (number | null)[]
export function supportResistance(bars, opts?): { support; resistance; atLevel }
export function detectPatterns(bars, opts?): PatternMatch[]

// ---- Part 3: signals ----
export function generateTradingSignals(bars, symbol, opts?): TradingSignal
export function interpretStock(bars, symbol, opts?): StockInterpretation
export function marketSentiment(portfolio, opts?): MarketSentiment
export function interpretPortfolio(portfolio, opts?): PortfolioInterpretation
```

## Appendix B — implementation checklist

- [ ] `assertAscending` wired into every `Bar`-taking public function; tested with a reversed array.
- [ ] Ingest validator rejecting `NaN`/`Infinity`, `high < low`, `low > min(o,c)`,
      `max(o,c) > high`, negative volume, duplicate timestamps.
- [ ] No output array ever contains `NaN`. Add a blanket assertion helper and use it in every test.
- [ ] Welford (streaming) and shifted two-pass (batch) variance implemented; the naive
      `E[x²]−E[x]²` form absent from the codebase.
- [ ] Rolling SMA uses add/subtract, not a full re-sum per bar.
- [ ] EMA recursion written as `prev + alpha*(x - prev)` everywhere (bit-exactness contract).
- [ ] DEMA/TEMA/HMA second and third EMA layers seeded from the first `n` non-null values of the
      previous layer, never from a null-padded array.
- [ ] ADX seed averages exactly `n` DX values starting at index `n`; first ADX at `2n − 1`.
- [ ] ATR uses `TR[0] = null` by default, with the tulip seeding available as an explicit option.
- [ ] Bollinger uses `ddof = 0`; a comment says why, citing the pandas `ddof = 1` default.
- [ ] MACD throws on `slowPeriod < fastPeriod` rather than swapping silently.
- [ ] Every `0/0` goes through `div()` and yields `null`; grep the codebase for raw `/` on
      computed values and audit each one.
- [ ] `periodsPerYear` defaults to 252, is recorded in `PerformanceSummary`, and is required for
      non-daily bars.
- [ ] `riskFreeRate` defaults to 0; no hardcoded 0.08/0.10 anywhere.
- [ ] Benchmark joins are by timestamp, and `nOverlapping` is surfaced to the caller.
- [ ] Signal engine returns every rule with its evidence string, fired or not.
- [ ] `marketSentiment` excludes insufficient-data symbols from the denominator rather than
      counting them neutral, and returns `INSUFFICIENT_DATA` when all are excluded.
- [ ] Regression tests assert all dataset A and dataset B vectors in §7 and the per-section vectors.
- [ ] Tests use relative tolerance (`1e-9`), not exact float equality.
- [ ] Fuzz pass on degenerate inputs: all-equal prices, single-spike series, zero volumes,
      subnormal values. See §9 item 11.
---

## Provenance note

The reference Python libraries this spec was derived from were removed from
the repository after their useful content was extracted. What was taken:

- **pypsx_toolkit** -- the list of functions a polished PSX library exposes,
  plus four conventions cited below. It shipped no implementations, so every
  formula here was derived independently from TA-Lib's C source, Wilder's
  original text, and published worked examples.
- **PSX-Data-Api** -- the ungated market-summary scrape.
- **psx-data-reader** -- nothing; it was already non-functional.

Citations below reading "the pypsx_toolkit stub" refer to its type stubs and
docstrings, not to code that existed here.
