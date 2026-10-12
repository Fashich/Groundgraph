"""Small shared record types."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class OpenMarket:
    """An open Groundgraph market as read from the `markets` table."""

    id: str
    asset: str
    open_ts: float
    trading_end_ts: float
    settle_ts: float
    p_market: float | None  # ABOVE price (latest tick or reserves); None when unknown
    liquidity_usd: float


@dataclass(frozen=True)
class PositionRow:
    """A row of `scored_positions`. usdc is in base units (6 dp)."""

    market_id: str
    wallet: str
    side: str  # 'above' | 'below'
    usdc: float
    entry_price: float
    ts: float
    data_source: str
