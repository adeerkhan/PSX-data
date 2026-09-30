"""Type stubs for pypsx.market — market-level functions."""

from typing import Any, Dict, List
import pandas as pd


def market_watch() -> pd.DataFrame:
    """
    Full live market watch — all PSX-listed securities with current prices.

    Returns:
        DataFrame with columns [Symbol, Company, Sector, LDCP, Open, High, Low,
        Current, Change, Change%, Volume, Value, Trades].

    Example:
        >>> import pypsx
        >>> mw = pypsx.market_watch()
        >>> gainers = mw[mw["Change%"] > 5]
    """
    ...


def performers() -> Dict[str, pd.DataFrame]:
    """
    Top gainers, top decliners, and most-active stocks for today.

    Returns:
        Dict with keys "top_gainers", "top_decliners", "top_actives".
        Each value is a DataFrame with [Symbol, Company, Price, Change%].

    Example:
        >>> result = pypsx.performers()
        >>> print(result["top_gainers"].head())
    """
    ...


def sectors() -> pd.DataFrame:
    """
    List all PSX sectors with aggregate statistics.

    Returns:
        DataFrame with columns [Sector_Code, Sector_Name, Companies_Count,
        Market_Cap, Change%, Volume].

    Example:
        >>> df = pypsx.sectors()
    """
    ...


def trading_board() -> pd.DataFrame:
    """
    Live PSX trading board with bid/ask spreads and market depth summary.

    Returns:
        DataFrame with columns [Symbol, Bid, Ask, LTP, Volume, Trades,
        High, Low, LDCP, Change%].

    Example:
        >>> board = pypsx.trading_board()
    """
    ...


def get_symbols() -> List[str]:
    """
    Return a list of all currently listed PSX equity symbols.

    Returns:
        Sorted list of ticker strings, e.g. ["ABOT", "ABL", "ACPL", ...].

    Example:
        >>> symbols = pypsx.get_symbols()
        >>> print(len(symbols), "listed symbols")
    """
    ...


def listings_nc() -> List[str]:
    """
    Symbols of Non-Compliant (NC) listed companies on PSX.

    Returns:
        List of ticker strings.
    """
    ...


def listings_dc() -> List[str]:
    """
    Symbols of companies on the Defaulters Counter (DC) on PSX.

    Returns:
        List of ticker strings.
    """
    ...


def get_indices() -> pd.DataFrame:
    """
    List all PSX market indices with current values and changes.

    Returns:
        DataFrame with columns [Index, Current, Change, Change%, High, Low].

    Example:
        >>> indices = pypsx.get_indices()
    """
    ...


def get_indices_breakdown() -> Dict[str, Any]:
    """
    Detailed breakdown of all PSX indices including sub-indices and sectors.

    Returns:
        Nested dict keyed by index code, with sector weights and constituent counts.
    """
    ...


def get_sector_breakdown() -> Dict[str, Any]:
    """
    Market-wide sector breakdown with aggregate market cap and performance.

    Returns:
        Dict with sector codes as keys and aggregate stats as values.
    """
    ...


def get_homepage_indices() -> pd.DataFrame:
    """
    Abbreviated index snapshot used on the PSX homepage.

    Returns:
        DataFrame with KSE-100, KSE-30, KMI-30, and All-Share index data.
    """
    ...


def index_constituents(index_code: str) -> pd.DataFrame:
    """
    Get all companies that make up a specific PSX index.

    Args:
        index_code: Index identifier, e.g. "KSE100", "KMI30", "KSE30", "ALLSHR".

    Returns:
        DataFrame with columns [Symbol, Company, Sector, Weight, Market_Cap,
        Shares, Price, Change%].

    Example:
        >>> df = pypsx.index_constituents("KMI30")   # KMI-30 index
        >>> df = pypsx.index_constituents("KSE100")  # KSE-100 index
    """
    ...
