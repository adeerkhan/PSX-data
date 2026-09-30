"""
PSX endpoint URL constants and builders.

Centralizes all PSX data endpoint URLs for consistency and maintainability.
"""

# Base URL for all PSX endpoints
PSX_BASE_URL = "https://dps.psx.com.pk"

# Main endpoints
MARKET_WATCH_URL = f"{PSX_BASE_URL}/market-watch"
SECTOR_SUMMARY_URL = f"{PSX_BASE_URL}/sector-summary/sectorwise"
PERFORMERS_URL = f"{PSX_BASE_URL}/performers"
TRADING_BOARD_URL = f"{PSX_BASE_URL}/trading-board/REG/main"
INDICES_OVERVIEW_URL = f"{PSX_BASE_URL}/indices"
HISTORICAL_URL = f"{PSX_BASE_URL}/historical"
PSX_MAIN_URL = f"{PSX_BASE_URL}"

# URL builders for dynamic endpoints
def get_index_url(index_code: str) -> str:
    """
    Get URL for index constituents.
    
    Args:
        index_code: Index code (e.g., 'KSE100', 'KMI30', 'KSE30')
        
    Returns:
        Full URL for the index endpoint
    """
    return f"{PSX_BASE_URL}/indices/{index_code}"


def get_timeseries_intraday_url(symbol: str) -> str:
    """
    Get URL for intraday timeseries data.
    
    Args:
        symbol: Stock symbol (e.g., 'OGDC', 'HBL')
        
    Returns:
        Full URL for intraday timeseries endpoint
    """
    return f"{PSX_BASE_URL}/timeseries/int/{symbol.upper()}"


def get_timeseries_eod_url(symbol: str) -> str:
    """
    Get URL for end-of-day timeseries data.
    
    Args:
        symbol: Stock symbol (e.g., 'OGDC', 'HBL')
        
    Returns:
        Full URL for EOD timeseries endpoint
    """
    return f"{PSX_BASE_URL}/timeseries/eod/{symbol.upper()}"


def get_company_url(symbol: str) -> str:
    """
    Get URL for company information.
    
    Args:
        symbol: Stock symbol (e.g., 'OGDC', 'HBL')
        
    Returns:
        Full URL for company endpoint
    """
    return f"{PSX_BASE_URL}/company/{symbol.upper()}"


def get_company_reports_url(symbol: str) -> str:
    """
    Get URL for company financial reports.
    
    Args:
        symbol: Stock symbol (e.g., 'OGDC', 'HBL')
        
    Returns:
        Full URL for company reports endpoint
    """
    return f"{PSX_BASE_URL}/company/reports/{symbol.upper()}"


def get_listings_url(listing_type: str = "nc") -> str:
    """
    Get URL for listings table.
    
    Args:
        listing_type: 'nc' for normal counter or 'dc' for defaulters counter
        
    Returns:
        Full URL for listings table endpoint
    """
    if listing_type not in ("nc", "dc"):
        raise ValueError("listing_type must be 'nc' or 'dc'")
    return f"{PSX_BASE_URL}/listings-table/main/{listing_type}"


def get_download_image_url(image_file: str) -> str:
    """
    Get URL for downloading images from PSX.
    
    Args:
        image_file: Image filename
        
    Returns:
        Full URL for image download endpoint
    """
    return f"{PSX_BASE_URL}/download/image/{image_file}"


# Common index codes
COMMON_INDICES = [
    "KSE100",
    "KMI30",
    "KSE30",
    "KSEALLSHR",
    "KMIALLSHR",
]

