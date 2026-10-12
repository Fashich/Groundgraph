"""Shared test helpers: fixture markets, ticks and trades inserted straight into the canonical schema."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import hashlib

import psycopg

from scorer.sources import b58encode

NOW = datetime(2026, 10, 12, 12, 30, tzinfo=timezone.utc)



def fixture_id(name: str) -> str:
    """A valid Solana style market id (base58 of 32 bytes) so the API accepts it in routes and WebSocket channels."""
    return b58encode(hashlib.sha256(("scorer-fixture-" + name).encode()).digest())


# id, asset, ABOVE price, vault liquidity in USDC, hours until settle
FIXTURE_MARKETS = [
    (fixture_id("sol"), "SOL", 0.21, 400.0, 29 * 24),
    (fixture_id("btc"), "BTC", 0.55, 900.0, 59 * 24),
    (fixture_id("jup"), "JUP", 0.19, 180.0, 13 * 24),
]


def insert_market(conn: psycopg.Connection, mid: str, asset: str, p_above: float, liq_usdc: float, hours_left: float,
                  status: str = "open", now: datetime = NOW, with_tick: bool = True) -> None:
    """Pool reserves follow the AMM: p_above = reserve_below / (reserve_above + reserve_below)."""
    sets = liq_usdc * 1e6
    ra = sets * (1.0 - p_above) * 2.0 if p_above < 0.5 else sets
    rb = ra * p_above / (1.0 - p_above)
    settle = now + timedelta(hours=hours_left)
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO markets(id, creator, kind, direction, asset_symbol, feed_id, target_price, target_expo, target_raw, open_ts,
                 trading_end_ts, settle_ts, base_fee_bps, dynamic_fee, question, status, above_mint, below_mint, lp_mint, vault,
                 reserve_above, reserve_below, complete_sets)
               VALUES (%s, 'creator', 'close', NULL, %s, %s, 100, -8, 10000000000, %s, %s, %s, 100, false, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (id) DO NOTHING""",
            (mid, asset, "ab" * 32, now - timedelta(days=3), settle - timedelta(hours=1), settle,
             f"{asset} above or below $100 at the close?", status, mid + "A", mid + "B", mid + "L", mid + "V", ra, rb, sets),
        )
        if with_tick:
            cur.execute(
                "INSERT INTO market_ticks(market_id, ts, price_above, reserve_above, reserve_below, fee_bps) VALUES (%s, %s, %s, %s, %s, 100) ON CONFLICT DO NOTHING",
                (mid, now - timedelta(minutes=2), p_above, ra, rb),
            )


def insert_fixture_markets(conn: psycopg.Connection, now: datetime = NOW) -> None:
    for mid, asset, p, liq, hrs in FIXTURE_MARKETS:
        insert_market(conn, mid, asset, p, liq, hrs, now=now)
    conn.commit()
