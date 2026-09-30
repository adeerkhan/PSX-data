"""
Data models for PyPSX library.

Provides typed data structures for all PSX endpoints following the specifications
in CHANGE.md. All models use normalized field names and ensure no nulls where
data is guaranteed to exist.
"""

from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any
from datetime import datetime


@dataclass
class SymbolInfo:
    """Symbol with optional status tags."""
    symbol: str
    tags: List[str] = field(default_factory=list)


@dataclass
class SectorSummary:
    """Sector summary data from sector-summary endpoint."""
    sector_code: str
    sector_name: str
    advance: int = 0
    decline: int = 0
    unchange: int = 0
    turnover: float = 0.0
    market_cap_b: float = 0.0  # Market cap in billions


@dataclass
class SectorCompany:
    """Company within a sector."""
    symbol: str
    name: str
    sector_code: str
    last_close: float = 0.0
    open: float = 0.0
    high: float = 0.0
    low: float = 0.0
    current_price: float = 0.0
    change: float = 0.0
    change_pct: float = 0.0
    volume: int = 0
    tags: List[str] = field(default_factory=list)


@dataclass
class CompanyMarketWatch:
    """Market watch entry for a company."""
    symbol: str
    sector: str
    listed_in: List[str] = field(default_factory=list)
    last_close: float = 0.0
    open: float = 0.0
    high: float = 0.0
    low: float = 0.0
    current_price: float = 0.0
    change: float = 0.0
    change_pct: float = 0.0
    volume: int = 0
    tags: List[str] = field(default_factory=list)


@dataclass
class IndexConstituent:
    """Index constituent data."""
    symbol: str
    name: str
    last_close: float = 0.0
    current_price: float = 0.0
    change: float = 0.0
    change_pct: float = 0.0
    index_weight_pct: float = 0.0
    index_point: float = 0.0
    volume: int = 0
    freefloat_m: float = 0.0  # Free float in millions
    market_cap_m: float = 0.0  # Market cap in millions
    tags: List[str] = field(default_factory=list)


@dataclass
class IndexMeta:
    """Index metadata."""
    index_code: str
    index_name: str
    current_value: float = 0.0
    change: float = 0.0
    change_pct: float = 0.0
    high: float = 0.0
    low: float = 0.0
    volume: int = 0


@dataclass
class TradingBoardRow:
    """Trading board entry."""
    symbol: str
    name: str
    bid_volume: int = 0
    bid_price: float = 0.0
    offer_volume: int = 0
    offer_price: float = 0.0
    last_close: float = 0.0
    change: float = 0.0
    volume: int = 0
    tags: List[str] = field(default_factory=list)


@dataclass
class TopActiveStock:
    """Top active stock entry."""
    symbol: str
    price: float = 0.0
    change: float = 0.0
    change_pct: float = 0.0
    volume: int = 0
    tags: List[str] = field(default_factory=list)


@dataclass
class TopAdvancer:
    """Top advancer entry."""
    symbol: str
    price: float = 0.0
    change: float = 0.0
    change_pct: float = 0.0
    volume: int = 0
    tags: List[str] = field(default_factory=list)


@dataclass
class TopDecliner:
    """Top decliner entry."""
    symbol: str
    price: float = 0.0
    change: float = 0.0
    change_pct: float = 0.0
    volume: int = 0
    tags: List[str] = field(default_factory=list)


@dataclass
class IntradayBar:
    """Intraday data point."""
    timestamp: datetime
    price: float = 0.0
    volume: int = 0


@dataclass
class EODBar:
    """End-of-day data point."""
    timestamp: datetime
    close: float = 0.0
    volume: int = 0
    weighted_avg: float = 0.0
    open: Optional[float] = None
    high: Optional[float] = None
    low: Optional[float] = None


@dataclass
class ListingEntry:
    """Listing entry from listings table."""
    symbol: str
    name: str
    sector: str
    clearing_type: str = ""
    shares: int = 0
    free_float: int = 0
    listed_in: List[str] = field(default_factory=list)
    non_compliance: str = ""  # For DC listings
    tags: List[str] = field(default_factory=list)


@dataclass
class CompanyFundamentals:
    """Company fundamentals data."""
    symbol: str
    business_description: str = ""
    address: str = ""
    website: str = ""
    key_people: Dict[str, str] = field(default_factory=dict)  # Name -> Title
    equity_profile: Dict[str, Any] = field(default_factory=dict)
    financials_annual: Dict[str, List[float]] = field(default_factory=dict)
    financials_quarterly: Dict[str, List[float]] = field(default_factory=dict)
    ratios: Dict[str, List[float]] = field(default_factory=dict)


@dataclass
class Announcement:
    """Company announcement."""
    symbol: str
    date: str
    title: str
    section: str  # "Financial Results", "Board Meetings", "Others"
    image_link: Optional[str] = None
    pdf_link: Optional[str] = None


@dataclass
class DividendInfo:
    """Dividend information."""
    symbol: str
    dividend_yield: Optional[float] = None
    annual_dividend: Optional[float] = None
    ex_dividend_date: Optional[str] = None
    payout_frequency: Optional[str] = None
    payout_ratio: Optional[float] = None
    dividend_growth: Optional[str] = None


@dataclass
class DividendHistory:
    """Dividend history entry."""
    symbol: str
    ex_dividend_date: str
    cash_amount: str
    record_date: Optional[str] = None
    pay_date: Optional[str] = None

