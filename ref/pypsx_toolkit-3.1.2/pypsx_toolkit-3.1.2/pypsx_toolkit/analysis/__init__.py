"""
PyPSX Analysis Module

This module provides comprehensive financial analysis tools for Pakistan Stock Exchange data,
including statistical functions, technical indicators, performance metrics, and automated insights.

Main Components:
- stats: Core statistical functions (returns, volatility, correlation, etc.)
- indicators: Technical analysis indicators (RSI, MACD, Bollinger Bands, etc.)
- performance: Financial performance metrics (Sharpe ratio, drawdown, etc.)
- insights: Automated insight generation and pattern detection

Usage:
    import pypsx_toolkit
    from pypsx_toolkit.analysis import interpret_stock, sharpe_ratio, bollinger_bands
    
    # Get stock data
    ticker = pypsx_toolkit.PSXTicker("OGDC")
    df = ticker.history(period="1y")
    
    # Generate insights
    insights = interpret_stock(df, "OGDC")
    print(insights['insights'])
    
    # Calculate metrics
    sharpe = sharpe_ratio(df)
    ma, upper, lower = bollinger_bands(df)
"""

# Core statistical functions
from .stats import (
    returns, volatility, correlation, correlation_matrix, beta,
    skewness, kurtosis, var, cvar, autocorrelation
)

# Technical indicators
from .indicators import (
    moving_average, exponential_moving_average, bollinger_bands,
    rsi, macd, stochastic, williams_r, atr, adx, cci, obv, vwap
)

# Performance metrics
from .performance import (
    sharpe_ratio, sortino_ratio, calmar_ratio, cumulative_returns,
    annualized_return, annualized_volatility, drawdown, max_drawdown,
    drawdown_duration, information_ratio, treynor_ratio, jensen_alpha,
    win_rate, profit_loss_ratio, recovery_factor, performance_summary
)

# Insight engine
from .insights import (
    interpret_stock, interpret_portfolio, detect_patterns,
    generate_trading_signals, market_sentiment_analysis
)

__all__ = [
    # Statistical functions
    'returns', 'volatility', 'correlation', 'correlation_matrix', 'beta',
    'skewness', 'kurtosis', 'var', 'cvar', 'autocorrelation',
    
    # Technical indicators
    'moving_average', 'exponential_moving_average', 'bollinger_bands',
    'rsi', 'macd', 'stochastic', 'williams_r', 'atr', 'adx', 'cci', 'obv', 'vwap',
    
    # Performance metrics
    'sharpe_ratio', 'sortino_ratio', 'calmar_ratio', 'cumulative_returns',
    'annualized_return', 'annualized_volatility', 'drawdown', 'max_drawdown',
    'drawdown_duration', 'information_ratio', 'treynor_ratio', 'jensen_alpha',
    'win_rate', 'profit_loss_ratio', 'recovery_factor', 'performance_summary',
    
    # Insight engine
    'interpret_stock', 'interpret_portfolio', 'detect_patterns',
    'generate_trading_signals', 'market_sentiment_analysis',

    # Composite helpers (defined in this module, below)
    'quick_analysis', 'portfolio_analysis',

    # Short aliases (defined at the bottom of this module). These are used in
    # the published documentation, so they are part of the supported surface.
    'ma', 'ema', 'bb', 'sharpe', 'sortino', 'calmar', 'cum_returns', 'max_dd',
    'win_rate_pct', 'pl_ratio', 'recovery', 'perf_summary', 'interpret',
    'patterns', 'signals', 'sentiment',
]


def quick_analysis(df, symbol=None):
    """
    Quick analysis function that provides a comprehensive overview of stock performance.
    
    Args:
        df: Stock DataFrame with OHLCV data
        symbol: Stock symbol (optional)
    
    Returns:
        Dictionary containing key metrics and insights
        
    Example:
        >>> import pypsx_toolkit
        >>> ticker = pypsx_toolkit.PSXTicker("OGDC")
        >>> df = ticker.history(period="1y")
        >>> analysis = quick_analysis(df, "OGDC")
        >>> print(f"Sharpe Ratio: {analysis['sharpe_ratio']:.3f}")
        >>> print(f"Total Return: {analysis['total_return']:.2%}")
    """
    if df is None or df.empty:
        return {"error": "No data available for analysis"}
    
    try:
        # Get comprehensive insights
        insights = interpret_stock(df, symbol)
        
        # Get performance summary
        perf_summary = performance_summary(df)
        
        # Get technical patterns
        patterns = detect_patterns(df, symbol)
        
        # Get trading signals
        signals = generate_trading_signals(df, symbol)
        
        # Merge performance summary metrics at top level for easy access
        result = {
            "symbol": symbol,
            "performance": perf_summary,
            "insights": insights.get('insights', []),
            "patterns": patterns.get('patterns', []),
            "trading_signal": signals.get('primary_signal', 'HOLD'),
            "signal_confidence": signals.get('confidence', 0),
            "key_metrics": {
                "total_return": insights.get('total_return', 0),
                "volatility": insights.get('volatility', 0),
                "sharpe_ratio": insights.get('sharpe_ratio', 0),
                "max_drawdown": insights.get('max_drawdown', 0),
                "rsi": insights.get('rsi', 50)
            }
        }
        
        # Also add top-level access for backward compatibility
        # These match the keys that users are accessing directly
        if perf_summary:
            result["sharpe_ratio"] = perf_summary.get('sharpe_ratio', insights.get('sharpe_ratio', 0))
            result["max_drawdown"] = perf_summary.get('max_drawdown', insights.get('max_drawdown', 0))
            result["total_return"] = perf_summary.get('total_return', insights.get('total_return', 0))
            result["annualized_return"] = perf_summary.get('annualized_return', 0)
            result["annualized_volatility"] = perf_summary.get('annualized_volatility', 0)
        
        return result
        
    except Exception as e:
        return {
            "symbol": symbol,
            "error": str(e),
            "insights": ["Error in analysis"]
        }


def portfolio_analysis(portfolio_data, risk_free_rate=0.08):
    """
    Comprehensive portfolio analysis function.
    
    Args:
        portfolio_data: Dictionary of symbol -> DataFrame
        risk_free_rate: Risk-free rate for calculations (default: 0.08)
    
    Returns:
        Dictionary containing portfolio analysis results
        
    Example:
        >>> portfolio = {
        ...     "OGDC": pypsx_toolkit.PSXTicker("OGDC").history(period="1y"),
        ...     "PPL": pypsx_toolkit.PSXTicker("PPL").history(period="1y"),
        ...     "KEL": pypsx_toolkit.PSXTicker("KEL").history(period="1y")
        ... }
        >>> analysis = portfolio_analysis(portfolio)
        >>> print(f"Portfolio insights: {analysis['portfolio_insights']}")
    """
    if not portfolio_data:
        return {"error": "No portfolio data provided"}
    
    try:
        # Get portfolio insights
        portfolio_insights = interpret_portfolio(portfolio_data, risk_free_rate)
        
        # Get market sentiment
        sentiment = market_sentiment_analysis(portfolio_data)
        
        # Individual stock analysis
        individual_analyses = {}
        for symbol, df in portfolio_data.items():
            if df is not None and not df.empty:
                individual_analyses[symbol] = quick_analysis(df, symbol)
        
        return {
            "portfolio_insights": portfolio_insights.get('portfolio_insights', []),
            "portfolio_metrics": portfolio_insights.get('portfolio_metrics', {}),
            "market_sentiment": sentiment.get('overall_sentiment', 'NEUTRAL'),
            "sentiment_strength": sentiment.get('sentiment_strength', 'Mixed'),
            "individual_analyses": individual_analyses,
            "summary": {
                "total_stocks": len(portfolio_data),
                "analyzed_stocks": len(individual_analyses),
                "bullish_stocks": sentiment.get('bullish_stocks', 0),
                "bearish_stocks": sentiment.get('bearish_stocks', 0),
                "neutral_stocks": sentiment.get('neutral_stocks', 0)
            }
        }
        
    except Exception as e:
        return {
            "error": str(e),
            "portfolio_insights": ["Error in portfolio analysis"]
        }


# Add convenience aliases
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
