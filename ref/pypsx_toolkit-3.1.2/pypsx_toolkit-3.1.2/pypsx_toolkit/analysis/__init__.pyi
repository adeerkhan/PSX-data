"""
Type stubs for pypsx.analysis — statistical analysis, technical indicators,
performance metrics, and AI-powered insights.

Example:
    >>> import pypsx
    >>> t = pypsx.Ticker("ENGRO")
    >>> df = t.history(period="1y")
    >>>
    >>> # Technical indicators
    >>> sma_20 = pypsx.analysis.moving_average(df, window=20)
    >>> upper, mid, lower = pypsx.analysis.bollinger_bands(df)
    >>> rsi = pypsx.analysis.rsi(df)
    >>>
    >>> # Performance metrics
    >>> print(pypsx.analysis.sharpe_ratio(df))
    >>> print(pypsx.analysis.max_drawdown(df))
    >>>
    >>> # Full summary
    >>> summary = pypsx.analysis.performance_summary(df)
"""

from typing import Any, Callable, Dict, List, Optional, Tuple
import pandas as pd

# =============================================================================
# Statistical Functions
# =============================================================================

def returns(df: pd.DataFrame) -> float:
    """Total return for the period."""
    ...

def volatility(df: pd.DataFrame, annualize: bool = True) -> float:
    """Annualised return volatility (std dev of log returns)."""
    ...

def correlation(df1: pd.DataFrame, df2: pd.DataFrame) -> float:
    """Pearson correlation coefficient between two price series."""
    ...

def correlation_matrix(portfolio_data: Dict[str, pd.DataFrame]) -> pd.DataFrame:
    """Correlation matrix for a portfolio of symbols."""
    ...

def beta(df: pd.DataFrame, market_returns: pd.Series) -> float:
    """Beta coefficient relative to a market index."""
    ...

def skewness(df: pd.DataFrame) -> float:
    """Skewness of the return distribution."""
    ...

def kurtosis(df: pd.DataFrame) -> float:
    """Excess kurtosis of the return distribution."""
    ...

def var(df: pd.DataFrame, confidence: float = 0.95) -> float:
    """Historical Value at Risk at the given confidence level."""
    ...

def cvar(df: pd.DataFrame, confidence: float = 0.95) -> float:
    """Conditional Value at Risk (Expected Shortfall)."""
    ...

def autocorrelation(df: pd.DataFrame, lag: int = 1) -> float:
    """Autocorrelation of returns at the given lag."""
    ...

# =============================================================================
# Technical Indicators
# =============================================================================

def moving_average(df: pd.DataFrame, window: int = 20) -> pd.Series:
    """Simple Moving Average (SMA).

    Args:
        df: OHLCV DataFrame (uses Close column).
        window: Rolling window in bars (default 20).

    Returns:
        pd.Series of SMA values.
    """
    ...

def exponential_moving_average(df: pd.DataFrame, window: int = 20) -> pd.Series:
    """Exponential Moving Average (EMA).

    Args:
        df: OHLCV DataFrame.
        window: Span for EMA calculation.

    Returns:
        pd.Series of EMA values.
    """
    ...

def bollinger_bands(
    df: pd.DataFrame,
    window: int = 20,
    num_std: float = 2.0,
) -> Tuple[pd.Series, pd.Series, pd.Series]:
    """
    Bollinger Bands.

    Returns:
        Tuple of (upper_band, middle_band, lower_band) as pd.Series.
    """
    ...

def rsi(df: pd.DataFrame, window: int = 14) -> pd.Series:
    """Relative Strength Index (0–100)."""
    ...

def macd(
    df: pd.DataFrame,
    fast: int = 12,
    slow: int = 26,
    signal: int = 9,
) -> Tuple[pd.Series, pd.Series, pd.Series]:
    """
    MACD indicator.

    Returns:
        Tuple of (macd_line, signal_line, histogram).
    """
    ...

def stochastic(
    df: pd.DataFrame,
    window: int = 14,
) -> Tuple[pd.Series, pd.Series]:
    """
    Stochastic Oscillator (%K and %D).

    Returns:
        Tuple of (%K, %D) as pd.Series.
    """
    ...

def williams_r(df: pd.DataFrame, window: int = 14) -> pd.Series:
    """Williams %R oscillator (-100 to 0)."""
    ...

def atr(df: pd.DataFrame, window: int = 14) -> pd.Series:
    """Average True Range."""
    ...

def adx(df: pd.DataFrame, window: int = 14) -> pd.Series:
    """Average Directional Index (trend strength 0–100)."""
    ...

def cci(df: pd.DataFrame, window: int = 20) -> pd.Series:
    """Commodity Channel Index."""
    ...

def obv(df: pd.DataFrame) -> pd.Series:
    """On-Balance Volume."""
    ...

def vwap(df: pd.DataFrame) -> pd.Series:
    """Volume Weighted Average Price."""
    ...

# =============================================================================
# Performance Metrics
# =============================================================================

def sharpe_ratio(df: pd.DataFrame, risk_free_rate: float = 0.10) -> float:
    """
    Annualised Sharpe Ratio.

    Args:
        df: OHLCV DataFrame with daily close prices.
        risk_free_rate: Annual risk-free rate (default 10% for Pakistan T-bills).

    Returns:
        Sharpe ratio (higher is better; >1 is acceptable, >2 is excellent).
    """
    ...

def sortino_ratio(df: pd.DataFrame, risk_free_rate: float = 0.10) -> float:
    """Annualised Sortino Ratio (penalises only downside volatility)."""
    ...

def calmar_ratio(df: pd.DataFrame) -> float:
    """Calmar Ratio = annualised return / max drawdown."""
    ...

def cumulative_returns(df: pd.DataFrame) -> float:
    """Total cumulative return for the period as a decimal (e.g. 0.35 = 35%)."""
    ...

def annualized_return(df: pd.DataFrame) -> float:
    """Compound Annual Growth Rate (CAGR)."""
    ...

def annualized_volatility(df: pd.DataFrame) -> float:
    """Annualised standard deviation of daily returns."""
    ...

def drawdown(df: pd.DataFrame) -> pd.Series:
    """Rolling drawdown series (0 to -1 scale)."""
    ...

def max_drawdown(df: pd.DataFrame) -> float:
    """Maximum peak-to-trough drawdown as a negative decimal (e.g. -0.35 = -35%)."""
    ...

def drawdown_duration(df: pd.DataFrame) -> int:
    """Length of the longest drawdown period in trading days."""
    ...

def information_ratio(df: pd.DataFrame, benchmark: pd.DataFrame) -> float:
    """Information Ratio = active return / tracking error."""
    ...

def treynor_ratio(df: pd.DataFrame, beta_value: float) -> float:
    """Treynor Ratio = excess return / beta."""
    ...

def jensen_alpha(df: pd.DataFrame, expected_return: float) -> float:
    """Jensen's Alpha = actual return - CAPM-expected return."""
    ...

def win_rate(trades: pd.DataFrame) -> float:
    """Percentage of profitable trades (0.0–1.0)."""
    ...

def profit_loss_ratio(trades: pd.DataFrame) -> float:
    """Average profit of winning trades / average loss of losing trades."""
    ...

def recovery_factor(trades: pd.DataFrame) -> float:
    """Net profit / max drawdown."""
    ...

def performance_summary(df: pd.DataFrame) -> Dict[str, Any]:
    """
    Compute a comprehensive performance report.

    Returns:
        Dict with keys: total_return, annualized_return, annualized_volatility,
        sharpe_ratio, sortino_ratio, calmar_ratio, max_drawdown, win_rate,
        best_day, worst_day, positive_days_pct.

    Example:
        >>> summary = pypsx.analysis.performance_summary(df)
        >>> print(summary["sharpe_ratio"])
    """
    ...

# =============================================================================
# Insights & Pattern Recognition
# =============================================================================

def interpret_stock(df: pd.DataFrame, symbol: str) -> Dict[str, Any]:
    """
    AI-powered interpretation of a stock's technical and statistical profile.

    Returns:
        Dict with keys: trend, momentum, volatility_level, support, resistance,
        signals, outlook.
    """
    ...

def interpret_portfolio(
    portfolio_data: Dict[str, pd.DataFrame],
    risk_free_rate: float = 0.10,
) -> Dict[str, Any]:
    """
    Holistic portfolio analysis including diversification and risk metrics.

    Args:
        portfolio_data: Dict mapping symbol → OHLCV DataFrame.
        risk_free_rate: Annual risk-free rate.

    Returns:
        Dict with per-symbol and aggregate metrics.
    """
    ...

def detect_patterns(df: pd.DataFrame, symbol: str) -> Dict[str, Any]:
    """
    Detect common chart patterns (head-and-shoulders, double top/bottom, etc.).

    Returns:
        Dict with pattern names as keys and confidence scores as values.
    """
    ...

def generate_trading_signals(df: pd.DataFrame, symbol: str) -> Dict[str, Any]:
    """
    Generate buy/sell/hold signals based on technical indicator confluence.

    Returns:
        Dict with keys: signal ("BUY"/"SELL"/"HOLD"), confidence (0–1),
        indicators_agreed, indicators_disagreed.
    """
    ...

def market_sentiment_analysis(
    portfolio_data: Dict[str, pd.DataFrame],
) -> Dict[str, Any]:
    """
    Aggregate sentiment analysis across a portfolio.

    Returns:
        Dict with overall_sentiment, bullish_count, bearish_count, neutral_count.
    """
    ...

def quick_analysis(df: pd.DataFrame, symbol: str) -> Dict[str, Any]:
    """
    Fast single-call analysis combining key indicators and a brief narrative.

    Returns:
        Dict with price_action, trend, momentum, key_levels, one_line_summary.
    """
    ...

def portfolio_analysis(
    portfolio_data: Dict[str, pd.DataFrame],
    risk_free_rate: float = 0.10,
) -> Dict[str, Any]:
    """Full portfolio-level analysis including correlation, risk, and attribution."""
    ...

# =============================================================================
# Short-form aliases
# =============================================================================

ma = moving_average
ema = exponential_moving_average
bb = bollinger_bands
sharpe = sharpe_ratio
sortino = sortino_ratio
calmar = calmar_ratio
cum_returns = cumulative_returns
max_dd = max_drawdown
win_rate_pct = win_rate
pl_ratio = profit_loss_ratio
recovery = recovery_factor
perf_summary = performance_summary
interpret = interpret_stock
patterns = detect_patterns
signals = generate_trading_signals
sentiment = market_sentiment_analysis
