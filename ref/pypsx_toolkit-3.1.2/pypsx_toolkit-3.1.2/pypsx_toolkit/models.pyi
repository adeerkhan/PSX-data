"""Type stubs for pypsx.models — data model dataclasses."""

from dataclasses import dataclass
from typing import Any, Dict, List, Optional


@dataclass
class SymbolInfo:
    """Basic metadata for a PSX-listed security."""
    symbol: str
    company_name: str
    sector: str
    listing_date: Optional[str]
    face_value: Optional[float]
    shares_outstanding: Optional[float]


@dataclass
class SectorSummary:
    """Aggregate statistics for a PSX sector."""
    sector_code: str
    sector_name: str
    companies_count: int
    market_cap: float
    change_pct: float
    volume: int


@dataclass
class SectorCompany:
    """A company entry within a sector listing."""
    symbol: str
    company_name: str
    market_cap: float
    change_pct: float
    volume: int


@dataclass
class CompanyMarketWatch:
    """Live market watch row for a single company."""
    symbol: str
    company_name: str
    sector: str
    ldcp: float
    open: float
    high: float
    low: float
    current: float
    change: float
    change_pct: float
    volume: int
    value: float
    trades: int


@dataclass
class IndexConstituent:
    """A single company entry in a PSX index."""
    symbol: str
    company_name: str
    sector: str
    weight: float
    market_cap: float
    shares: float
    price: float
    change_pct: float


@dataclass
class IndexMeta:
    """Metadata and current value of a PSX index."""
    index_code: str
    index_name: str
    current: float
    change: float
    change_pct: float
    high: float
    low: float
    volume: int


@dataclass
class TradingBoardRow:
    """Live trading board entry with bid/ask spread."""
    symbol: str
    bid: float
    ask: float
    ltp: float
    volume: int
    trades: int
    high: float
    low: float
    ldcp: float
    change_pct: float


@dataclass
class TopActiveStock:
    """Most-active stock by volume."""
    symbol: str
    company_name: str
    volume: int
    value: float
    change_pct: float


@dataclass
class TopAdvancer:
    """Top gaining stock for the session."""
    symbol: str
    company_name: str
    price: float
    change_pct: float


@dataclass
class TopDecliner:
    """Top declining stock for the session."""
    symbol: str
    company_name: str
    price: float
    change_pct: float


@dataclass
class IntradayBar:
    """A single intraday price tick."""
    time: str
    price: float
    volume: int
    change: float
    change_pct: float


@dataclass
class EODBar:
    """End-of-day OHLCV bar."""
    date: str
    open: float
    high: float
    low: float
    close: float
    volume: int
    change_pct: float


@dataclass
class ListingEntry:
    """A PSX listing entry (from compliant/non-compliant/defaulter lists)."""
    symbol: str
    company_name: str
    listing_type: str


@dataclass
class CompanyFundamentals:
    """Company fundamental financial metrics."""
    symbol: str
    pe_ratio: Optional[float]
    eps: Optional[float]
    book_value: Optional[float]
    dividend_yield: Optional[float]
    roe: Optional[float]
    roa: Optional[float]
    debt_to_equity: Optional[float]
    current_ratio: Optional[float]
    market_cap: Optional[float]
    shares_outstanding: Optional[float]


@dataclass
class Announcement:
    """A PSX corporate announcement."""
    date: str
    category: str
    subject: str
    description: str


@dataclass
class DividendInfo:
    """Latest dividend details for a symbol."""
    symbol: str
    dividend_type: str
    rate: float
    face_value: float
    ex_date: Optional[str]
    payment_date: Optional[str]


@dataclass
class DividendHistory:
    """Historical dividend payment record."""
    date: str
    dividend_type: str
    rate: float
    face_value: float
    announcement_date: Optional[str]
