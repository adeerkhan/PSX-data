# pypsx-toolkit

**Free, programmatic market data and analytics for the Pakistan Stock Exchange (PSX), from [pyPSX](https://pypsx.com).**

pyPSX is the API-first trading platform for PSX: market data, backtesting, paper and live trading over a
REST and WebSocket API, a live feed, an AI Strategy Copilot, and a web terminal. This package is the free,
public data and analytics library, the easiest way to pull PSX data programmatically in Python. No account
and no API key are required.

- Website and product: https://pypsx.com
- Web terminal and dashboard: https://markets.pypsx.com
- Documentation: https://docs.pypsx.com
- Trading SDK (backtesting, paper and live trading): [`pypsx`](https://pypi.org/project/pypsx/)
- X: https://x.com/pyPSXofficial · LinkedIn: https://www.linkedin.com/company/pypsx/ · Reddit: https://www.reddit.com/r/pypsx/

## What this package does

`pypsx-toolkit` gives anyone clean PSX data in Python, with no key:

- 10 years of daily OHLCV and recent intraday data.
- Company fundamentals, dividend history, and corporate announcements.
- Index and sector constituents and breakdowns (KSE-100, KMI-30, KSE-30, and more).
- A full market watch, top performers, and quotes.
- A technical-analysis toolkit: moving averages, RSI, MACD, Bollinger Bands, correlation, and risk stats.

Returns clean pandas DataFrames. Built on a real API, not brittle HTML parsing.

## Install

```bash
pip install pypsx-toolkit
```

```python
import pypsx_toolkit as pt

df = pt.download("OGDC", period="10y")          # 10 years of daily bars
pt.get_company_fundamentals("OGDC")
pt.get_dividend_history("HBL")
```

## Going further

For backtesting, a paper-trading sandbox, live real-money trading, and the live feed, use the
[`pypsx`](https://pypi.org/project/pypsx/) SDK with a free key, or trade point-and-click in the web
terminal at https://markets.pypsx.com.

## About pyPSX

pyPSX is the developer platform and company for the Pakistan Stock Exchange. It is distinct from the PSX
exchange itself. Proprietary license. Full documentation at https://docs.pypsx.com.
