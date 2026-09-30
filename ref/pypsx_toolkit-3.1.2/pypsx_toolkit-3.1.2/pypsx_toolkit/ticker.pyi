"""Type stubs for pypsx.ticker — PSXTicker (yfinance-style interface)."""

from typing import Any, Callable, Dict, List, Optional, Union
import pandas as pd


class PSXTicker:
    """
    PSX stock ticker — yfinance-compatible interface for Pakistan Stock Exchange data.

    Supports equity symbols (e.g. "ENGRO", "HBL") and index symbols (e.g. "KSE100", "KMI30").

    Example:
        >>> import pypsx
        >>> t = pypsx.Ticker("ENGRO")
        >>> df = t.history(period="1y")
        >>> print(df.head())
        >>> print(t.info["sector"])
    """

    symbol: str

    def __init__(self, symbol: str) -> None:
        """
        Create a ticker for a PSX-listed symbol.

        Args:
            symbol: PSX ticker symbol (case-insensitive), e.g. "ENGRO", "HBL", "KSE100".

        Raises:
            PSXNotFoundError: If the symbol is not listed on PSX.
        """
        ...

    # -------------------------------------------------------------------------
    # Properties
    # -------------------------------------------------------------------------

    @property
    def info(self) -> Dict[str, Any]:
        """
        Comprehensive company information dictionary.

        Keys include: symbol, company_name, sector, market_cap, pe_ratio,
        eps, book_value, dividend_yield, shares_outstanding, float_shares,
        current_price, fifty_two_week_high, fifty_two_week_low, volume,
        average_volume, and more.

        Returns:
            dict with company fundamentals and market data.

        Example:
            >>> t = pypsx.Ticker("OGDC")
            >>> print(t.info["pe_ratio"])
        """
        ...

    @property
    def fast_info(self) -> Dict[str, Any]:
        """
        Quick snapshot of key price metrics (lighter than .info).

        Keys include: last_price, change, change_pct, volume, high, low,
        open, prev_close.

        Returns:
            dict with real-time price snapshot.
        """
        ...

    @property
    def snapshot(self) -> Dict[str, Any]:
        """
        Multi-tab market snapshot (combines price, fundamentals, and trading stats).

        Returns:
            Nested dict with tabs: price, fundamentals, trading_stats, company.
        """
        ...

    # -------------------------------------------------------------------------
    # Historical / OHLCV data
    # -------------------------------------------------------------------------

    def history(
        self,
        period: str = "1mo",
        interval: str = "1d",
        to_csv: Optional[str] = None,
    ) -> pd.DataFrame:
        """
        Fetch OHLCV history using a period shorthand (yfinance-compatible).

        Args:
            period: Time period string. Valid values:
                "1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "ytd", "max"
            interval: Bar interval. Currently only "1d" (daily) is supported.
            to_csv: Optional file path to export the DataFrame as CSV.

        Returns:
            DataFrame with columns [Date, Open, High, Low, Close, Volume, Change%].
            Date is the index.

        Raises:
            PSXNotFoundError: If the symbol does not exist.
            PSXHTTPError: If the PSX server returns an error.

        Example:
            >>> t = pypsx.Ticker("ENGRO")
            >>> df = t.history(period="1y")
            >>> df = t.history(period="5y", to_csv="engro_5y.csv")
        """
        ...

    def get_historical(
        self,
        start_date: str,
        end_date: str,
        max_workers: int = 4,
        show_progress: bool = False,
    ) -> pd.DataFrame:
        """
        Fetch historical OHLCV data between two specific dates.

        Args:
            start_date: Start date in "YYYY-MM-DD" format.
            end_date: End date in "YYYY-MM-DD" format.
            max_workers: Number of parallel HTTP workers (speeds up long date ranges).
            show_progress: If True, show a tqdm progress bar.

        Returns:
            DataFrame with columns [Date, Open, High, Low, Close, Volume, Change%].

        Example:
            >>> t = pypsx.Ticker("HBL")
            >>> df = t.get_historical("2020-01-01", "2024-12-31")
        """
        ...

    # -------------------------------------------------------------------------
    # Intraday / real-time
    # -------------------------------------------------------------------------

    def intraday(self) -> pd.DataFrame:
        """
        Fetch intraday tick data for the last 2 trading days.

        Returns:
            DataFrame with columns [Time, Price, Volume, Change, Change%].
            Each row is a trade tick.

        Example:
            >>> t = pypsx.Ticker("SYS")
            >>> ticks = t.intraday()
        """
        ...

    def market_watch(self) -> pd.DataFrame:
        """
        Live market watch entry for this symbol (price, volume, change, etc.).

        Returns:
            Single-row DataFrame with live market data.
        """
        ...

    def orderbook(self) -> pd.DataFrame:
        """
        Order book / market depth for this symbol.

        Returns:
            DataFrame with bid/ask price levels and volumes.
        """
        ...

    # -------------------------------------------------------------------------
    # Corporate actions
    # -------------------------------------------------------------------------

    def announcements(self) -> pd.DataFrame:
        """
        Fetch company announcements (dividends, results, AGM notices, etc.).

        Returns:
            DataFrame with columns [Date, Category, Subject, Description].

        Example:
            >>> t = pypsx.Ticker("ENGRO")
            >>> df = t.announcements()
        """
        ...

    def dividends(self) -> pd.DataFrame:
        """
        Dividend history for this symbol.

        Returns:
            DataFrame with columns [Date, Type, Rate, Face_Value, Announcement_Date].

        Example:
            >>> t = pypsx.Ticker("OGDC")
            >>> df = t.dividends()
        """
        ...

    # -------------------------------------------------------------------------
    # Sector / index
    # -------------------------------------------------------------------------

    def sector(self) -> pd.DataFrame:
        """
        Sector membership and sector-level statistics for this symbol.

        Returns:
            DataFrame with sector name, peer companies, and sector indices.
        """
        ...

    def constituents(self) -> pd.DataFrame:
        """
        For index symbols (e.g. "KSE100"), return all constituent companies.

        Returns:
            DataFrame with columns [Symbol, Company, Sector, Weight, Market_Cap].

        Raises:
            PSXScopeError: If called on an equity symbol (not an index).

        Example:
            >>> idx = pypsx.Ticker("KSE100")
            >>> df = idx.constituents()
        """
        ...


# Alias for yfinance-compatibility
Ticker = PSXTicker
