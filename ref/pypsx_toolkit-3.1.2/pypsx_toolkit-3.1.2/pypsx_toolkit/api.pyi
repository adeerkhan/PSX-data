"""Type stubs for pypsx.api — high-level data retrieval functions."""

from typing import Any, Dict, List, Optional, Union
import pandas as pd


def download(
    symbols: Union[str, List[str]],
    period: str = "1y",
    interval: str = "1d",
    to_csv: Optional[str] = None,
    show_progress: bool = True,
) -> pd.DataFrame:
    """
    Download historical OHLCV data for one or more PSX symbols (yfinance-style).

    Args:
        symbols: Single symbol string or list of symbols, e.g. ["ENGRO", "HBL", "OGDC"].
        period: Time period — "1d","5d","1mo","3mo","6mo","1y","2y","5y","10y","ytd","max".
        interval: Bar interval. Only "1d" is currently supported.
        to_csv: Optional path to save the result as CSV.
        show_progress: Display a progress bar while fetching. Set False in
            notebooks, reports or logs where the bar is just noise.

    Returns:
        For a single symbol: DataFrame with [Open, High, Low, Close, Volume, Change%].
        For multiple symbols: Multi-level column DataFrame keyed by (field, symbol).

    Example:
        >>> import pypsx
        >>> df = pypsx.download("ENGRO", period="1y")
        >>> df = pypsx.download(["ENGRO", "HBL", "OGDC"], period="6mo")
    """
    ...


def get_historical(
    symbol: str,
    start_date: str,
    end_date: str,
    max_workers: int = 4,
    show_progress: bool = False,
) -> pd.DataFrame:
    """
    Fetch historical daily OHLCV data for a specific date range.

    Args:
        symbol: PSX ticker symbol, e.g. "ENGRO".
        start_date: Start date in "YYYY-MM-DD" format.
        end_date: End date in "YYYY-MM-DD" format.
        max_workers: Number of parallel HTTP workers for large date ranges.
        show_progress: Show tqdm progress bar if True.

    Returns:
        DataFrame with columns [Date, Open, High, Low, Close, Volume, Change%].

    Example:
        >>> df = pypsx.get_historical("OGDC", "2019-01-01", "2024-12-31")
    """
    ...


def get_intraday(symbol: str) -> pd.DataFrame:
    """
    Fetch intraday tick data for the last 2 trading days.

    Args:
        symbol: PSX ticker symbol.

    Returns:
        DataFrame with columns [Time, Price, Volume, Change, Change%].

    Example:
        >>> ticks = pypsx.get_intraday("SYS")
    """
    ...


def get_intraday_multiple(
    symbols: List[str],
    show_progress: bool = True,
) -> pd.DataFrame:
    """
    Fetch intraday tick data for multiple symbols in parallel.

    Args:
        symbols: List of PSX ticker symbols.
        show_progress: Display a progress bar while fetching. Set False in
            notebooks, reports or logs where the bar is just noise.

    Returns:
        Concatenated DataFrame with an additional "Symbol" column.

    Example:
        >>> df = pypsx.get_intraday_multiple(["ENGRO", "HBL", "SYS"])
    """
    ...


def get_quote(
    symbol: str,
    as_dict: bool = False,
) -> Union[pd.DataFrame, Dict[str, Any]]:
    """
    Get the latest price quote for a single symbol.

    Args:
        symbol: PSX ticker symbol.
        as_dict: If True, return a dict instead of a DataFrame.

    Returns:
        DataFrame row or dict with fields: symbol, price, change, change_pct,
        volume, high, low, open, prev_close, market_cap.

    Example:
        >>> quote = pypsx.get_quote("ENGRO")
        >>> quote = pypsx.get_quote("ENGRO", as_dict=True)
    """
    ...


def get_quote_batch(
    symbols: List[str],
    as_dict: bool = False,
) -> Union[pd.DataFrame, Dict[str, Any]]:
    """
    Get latest price quotes for multiple symbols at once.

    Args:
        symbols: List of PSX ticker symbols.
        as_dict: If True, return a dict keyed by symbol.

    Returns:
        DataFrame with one row per symbol, or nested dict if as_dict=True.

    Example:
        >>> df = pypsx.get_quote_batch(["ENGRO", "HBL", "OGDC"])
    """
    ...


def get_company_fundamentals(
    symbol: str,
    as_dict: bool = False,
) -> Union[pd.DataFrame, Dict[str, Any]]:
    """
    Fetch company fundamental data (P/E, EPS, book value, ROE, etc.).

    Args:
        symbol: PSX ticker symbol.
        as_dict: Return dict instead of DataFrame if True.

    Returns:
        DataFrame or dict with keys: pe_ratio, eps, book_value, dividend_yield,
        roe, roa, debt_to_equity, current_ratio, market_cap, shares_outstanding.

    Example:
        >>> fundamentals = pypsx.get_company_fundamentals("HUBC")
    """
    ...


def get_announcements(
    symbol: str,
    as_dict: bool = False,
) -> Union[pd.DataFrame, Dict[str, Any]]:
    """
    Fetch PSX corporate announcements for a symbol.

    Args:
        symbol: PSX ticker symbol.
        as_dict: Return list of dicts if True.

    Returns:
        DataFrame with columns [Date, Category, Subject, Description].

    Example:
        >>> df = pypsx.get_announcements("ENGRO")
    """
    ...


def get_dividend_info(
    symbol: str,
    as_dict: bool = False,
) -> Union[pd.DataFrame, Dict[str, Any]]:
    """
    Get current/latest dividend information for a symbol.

    Args:
        symbol: PSX ticker symbol.
        as_dict: Return dict if True.

    Returns:
        DataFrame or dict with last dividend rate, type, ex-date, payment date.

    Example:
        >>> info = pypsx.get_dividend_info("OGDC")
    """
    ...


def get_dividend_history(
    symbol: str,
    as_dict: bool = False,
) -> Union[pd.DataFrame, Dict[str, Any]]:
    """
    Full dividend payment history for a symbol (cash, stock, bonus, rights).

    Args:
        symbol: PSX ticker symbol.
        as_dict: Return list of dicts if True.

    Returns:
        DataFrame with columns [Date, Type, Rate, Face_Value, Announcement_Date].

    Example:
        >>> history = pypsx.get_dividend_history("ENGRO")
    """
    ...


def get_snapshot(
    symbol: str,
    as_dict: bool = False,
) -> Union[Dict[str, Any], pd.DataFrame]:
    """
    Multi-tab market snapshot combining price, fundamentals, and trading stats.

    Args:
        symbol: PSX ticker symbol.
        as_dict: Return nested dict if True (default).

    Returns:
        Nested dict / DataFrame with tabs: price, fundamentals, trading_stats, company.

    Example:
        >>> snap = pypsx.get_snapshot("SYS")
        >>> print(snap["price"]["last_price"])
    """
    ...


def get_sector_constituents(
    sector_code: str,
    as_dict: bool = False,
) -> Union[pd.DataFrame, Dict[str, Any]]:
    """
    Get all companies belonging to a PSX sector by sector code.

    Args:
        sector_code: PSX sector code (e.g. "BAN" for Banking, "OGX" for Oil & Gas).
        as_dict: Return list of dicts if True.

    Returns:
        DataFrame with columns [Symbol, Company, Market_Cap, Change%, Volume].

    Example:
        >>> df = pypsx.get_sector_constituents("BAN")
    """
    ...


def get_symbols_by_sector(
    sector_name: str,
    as_dict: bool = False,
) -> Union[pd.DataFrame, Dict[str, Any]]:
    """
    Get symbols belonging to a PSX sector by human-readable sector name.

    Args:
        sector_name: Full sector name, e.g. "Banking", "Automobile Assembler",
                     "Oil & Gas Exploration Companies".
        as_dict: Return list of dicts if True.

    Returns:
        DataFrame with constituent symbols and company names.

    Example:
        >>> df = pypsx.get_symbols_by_sector("Banking")
        >>> df = pypsx.get_symbols_by_sector("Cement")
    """
    ...


def get_business_description(symbol: str) -> str:
    """
    Return a plain-text business description for a PSX-listed company.

    Args:
        symbol: PSX ticker symbol.

    Returns:
        String with the company's business overview.

    Example:
        >>> desc = pypsx.get_business_description("ENGRO")
        >>> print(desc[:200])
    """
    ...
