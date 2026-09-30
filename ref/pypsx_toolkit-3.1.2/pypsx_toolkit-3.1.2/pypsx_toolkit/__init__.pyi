"""
pypsx-toolkit — Pakistan Stock Exchange data library (yfinance-style API).

Optional, supplementary to the pypsx trading SDK - not required for trading,
backtesting, or standard data fetching (see the pypsx package for that).

Install:
    pip install pypsx-toolkit

Quick start:
    import pypsx_toolkit

    # Single ticker
    t = pypsx_toolkit.Ticker("ENGRO")
    df = t.history(period="1y")

    # Batch download
    df = pypsx_toolkit.download(["ENGRO", "HBL", "OGDC"], period="6mo")

    # Market overview
    mw = pypsx_toolkit.market_watch()
"""

from typing import List, Optional, Union
import pandas as pd

from .ticker import PSXTicker as PSXTicker, PSXTicker as Ticker
from .models import (
    SymbolInfo as SymbolInfo,
    SectorSummary as SectorSummary,
    SectorCompany as SectorCompany,
    CompanyMarketWatch as CompanyMarketWatch,
    IndexConstituent as IndexConstituent,
    IndexMeta as IndexMeta,
    TradingBoardRow as TradingBoardRow,
    TopActiveStock as TopActiveStock,
    TopAdvancer as TopAdvancer,
    TopDecliner as TopDecliner,
    IntradayBar as IntradayBar,
    EODBar as EODBar,
    ListingEntry as ListingEntry,
    CompanyFundamentals as CompanyFundamentals,
    Announcement as Announcement,
    DividendInfo as DividendInfo,
    DividendHistory as DividendHistory,
)
from .core.errors import (
    PSXError as PSXError,
    PSXHTTPError as PSXHTTPError,
    PSXTimeoutError as PSXTimeoutError,
    PSXNotFoundError as PSXNotFoundError,
    PSXScopeError as PSXScopeError,
)
from .core.stream import PSXStream as PSXStream
from .api import (
    download as download,
    get_historical as get_historical,
    get_intraday as get_intraday,
    get_intraday_multiple as get_intraday_multiple,
    get_quote as get_quote,
    get_quote_batch as get_quote_batch,
    get_company_fundamentals as get_company_fundamentals,
    get_announcements as get_announcements,
    get_dividend_info as get_dividend_info,
    get_dividend_history as get_dividend_history,
    get_snapshot as get_snapshot,
    get_sector_constituents as get_sector_constituents,
    get_symbols_by_sector as get_symbols_by_sector,
    get_business_description as get_business_description,
)
from .market import (
    market_watch as market_watch,
    performers as performers,
    sectors as sectors,
    trading_board as trading_board,
    get_symbols as get_symbols,
    listings_nc as listings_nc,
    listings_dc as listings_dc,
    get_indices as get_indices,
    get_indices_breakdown as get_indices_breakdown,
    get_sector_breakdown as get_sector_breakdown,
    get_homepage_indices as get_homepage_indices,
    index_constituents as index_constituents,
)
from .analysis import (
    moving_average as moving_average,
    exponential_moving_average as exponential_moving_average,
    bollinger_bands as bollinger_bands,
    rsi as rsi,
    macd as macd,
    sharpe_ratio as sharpe_ratio,
    sortino_ratio as sortino_ratio,
    performance_summary as performance_summary,
    interpret_stock as interpret_stock,
    portfolio_analysis as portfolio_analysis,
)

__version__: str
__all__: List[str]
