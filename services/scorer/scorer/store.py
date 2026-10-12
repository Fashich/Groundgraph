"""PostgreSQL access: idempotent writers for every table the scorer owns, readers for the radar, model artifacts.

Every writer is safe to run twice with the same input (upserts keyed by the table primary keys, or delete + insert
inside one transaction for tables where a run replaces the previous content). `wallets.label_hidden` is never written.
"""

from __future__ import annotations

import contextlib
import json
import zlib
from datetime import datetime, timezone
from typing import Iterable, Iterator, Sequence

import psycopg
from psycopg.types.json import Jsonb

from .types import OpenMarket, PositionRow


def connect(url: str) -> psycopg.Connection:
    conn = psycopg.connect(url, autocommit=False)
    return conn


def dt(ts: float) -> datetime:
    return datetime.fromtimestamp(float(ts), tz=timezone.utc)


def ts_of(d: datetime) -> float:
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.timestamp()


@contextlib.contextmanager
def advisory_lock(conn: psycopg.Connection, name: str) -> Iterator[bool]:
    """Session level advisory lock so two scorer containers never run the same job concurrently."""
    key = zlib.crc32(("groundgraph-scorer:" + name).encode())
    with conn.cursor() as cur:
        cur.execute("SELECT pg_try_advisory_lock(%s)", (key,))
        got = bool(cur.fetchone()[0])
    conn.commit()
    try:
        yield got
    finally:
        if got:
            with conn.cursor() as cur:
                cur.execute("SELECT pg_advisory_unlock(%s)", (key,))
            conn.commit()


# --------------------------------------------------------------------------- bookkeeping (indexer_state)
def save_state(conn: psycopg.Connection, key: str, value: dict) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO indexer_state(key, value, updated_at) VALUES (%s, %s, now()) "
            "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
            (key, Jsonb(value)),
        )


def load_state(conn: psycopg.Connection, key: str) -> dict | None:
    with conn.cursor() as cur:
        cur.execute("SELECT value FROM indexer_state WHERE key = %s", (key,))
        row = cur.fetchone()
    return row[0] if row else None


# --------------------------------------------------------------------------- readers
def read_open_markets(conn: psycopg.Connection) -> list[OpenMarket]:
    """Open markets with their ABOVE price (latest market_ticks row, else pool reserves)."""
    sql = """
      SELECT m.id, m.asset_symbol, m.open_ts, m.trading_end_ts, m.settle_ts, m.reserve_above, m.reserve_below, m.complete_sets,
             (SELECT t.price_above FROM market_ticks t WHERE t.market_id = m.id ORDER BY t.ts DESC LIMIT 1) AS tick
      FROM markets m WHERE m.status = 'open' ORDER BY m.id
    """
    out = []
    with conn.cursor() as cur:
        cur.execute(sql)
        for (mid, sym, o, te, se, ra, rb, cs, tick) in cur.fetchall():
            ra, rb, cs = float(ra), float(rb), float(cs)
            if tick is not None:
                p = float(tick)
            elif ra + rb > 0:
                p = rb / (ra + rb)
            else:
                p = None
            liq = (cs if cs > 0 else min(ra, rb)) / 1e6
            out.append(OpenMarket(mid, sym, ts_of(o), ts_of(te), ts_of(se), p, liq))
    conn.commit()
    return out


def read_hidden_wallets(conn: psycopg.Connection) -> set[str]:
    with conn.cursor() as cur:
        cur.execute("SELECT address FROM wallets WHERE label_hidden")
        out = {r[0] for r in cur.fetchall()}
    conn.commit()
    return out


def read_prev_clusters(conn: psycopg.Connection, data_source: str) -> dict[str, int]:
    with conn.cursor() as cur:
        cur.execute("SELECT address, cluster_id FROM wallets WHERE data_source = %s AND cluster_id IS NOT NULL", (data_source,))
        out = {a: int(c) for a, c in cur.fetchall()}
    conn.commit()
    return out


# --------------------------------------------------------------------------- writers
def upsert_wallets(conn: psycopg.Connection, rows: Sequence[tuple]) -> None:
    """rows: (address, first_seen_ts|None, funding_source|None, cluster_id|None, cluster_name|None, sybil_cluster_id|None, data_source)"""
    sql = """
      INSERT INTO wallets(address, first_seen, funding_source, cluster_id, cluster_name, sybil_cluster_id, data_source)
      VALUES (%s, %s, %s, %s, %s, %s, %s)
      ON CONFLICT (address) DO UPDATE SET
        first_seen = LEAST(wallets.first_seen, EXCLUDED.first_seen),
        funding_source = COALESCE(EXCLUDED.funding_source, wallets.funding_source),
        cluster_id = EXCLUDED.cluster_id,
        cluster_name = EXCLUDED.cluster_name,
        sybil_cluster_id = EXCLUDED.sybil_cluster_id,
        data_source = EXCLUDED.data_source
    """
    data = [(a, dt(fs) if fs is not None else None, f, c, cn, s, ds) for (a, fs, f, c, cn, s, ds) in rows]
    with conn.cursor() as cur:
        cur.executemany(sql, data)


def upsert_features(conn: psycopg.Connection, as_of: float, rows: Sequence[tuple]) -> None:
    """rows: (address, whale_overlap, entry_timing, hit_rate, centrality, lead_time_min, n_markets)"""
    sql = """
      INSERT INTO wallet_features(address, as_of, whale_overlap, entry_timing, hit_rate, centrality, lead_time_min, n_markets)
      VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
      ON CONFLICT (address, as_of) DO UPDATE SET whale_overlap = EXCLUDED.whale_overlap, entry_timing = EXCLUDED.entry_timing,
        hit_rate = EXCLUDED.hit_rate, centrality = EXCLUDED.centrality, lead_time_min = EXCLUDED.lead_time_min,
        n_markets = EXCLUDED.n_markets
    """
    a = dt(as_of)
    with conn.cursor() as cur:
        cur.executemany(sql, [(r[0], a, round(r[1], 6), round(r[2], 6), round(r[3], 6), round(r[4], 6), round(r[5], 3), int(r[6])) for r in rows])


def upsert_scores(conn: psycopg.Connection, as_of: float, rows: Sequence[tuple], model_version: str, data_source: str) -> None:
    """rows: (address, score, smart, top, contributions dict, reasons list)"""
    sql = """
      INSERT INTO wallet_scores(address, as_of, score, smart, top, contributions, reasons, model_version, data_source)
      VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
      ON CONFLICT (address, as_of) DO UPDATE SET score = EXCLUDED.score, smart = EXCLUDED.smart, top = EXCLUDED.top,
        contributions = EXCLUDED.contributions, reasons = EXCLUDED.reasons, model_version = EXCLUDED.model_version,
        data_source = EXCLUDED.data_source
    """
    a = dt(as_of)
    with conn.cursor() as cur:
        cur.executemany(sql, [(r[0], a, int(r[1]), bool(r[2]), bool(r[3]), Jsonb(r[4]), Jsonb(r[5]), model_version, data_source) for r in rows])


def upsert_layout(conn: psycopg.Connection, as_of: float, rows: Sequence[tuple], data_source: str) -> None:
    """rows: (address, x, y, z)"""
    sql = """
      INSERT INTO graph_layout(address, x, y, z, as_of, data_source) VALUES (%s, %s, %s, %s, %s, %s)
      ON CONFLICT (address) DO UPDATE SET x = EXCLUDED.x, y = EXCLUDED.y, z = EXCLUDED.z, as_of = EXCLUDED.as_of,
        data_source = EXCLUDED.data_source
    """
    a = dt(as_of)
    with conn.cursor() as cur:
        cur.executemany(sql, [(r[0], float(r[1]), float(r[2]), float(r[3]), a, data_source) for r in rows])


def delete_layout(conn: psycopg.Connection, addresses: Iterable[str]) -> None:
    addrs = list(addresses)
    if addrs:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM graph_layout WHERE address = ANY(%s)", (addrs,))


def replace_edges(conn: psycopg.Connection, data_source: str, rows: Sequence[tuple]) -> None:
    """Replace every wallet_edges row of `data_source` (demo data is regenerated on each run)."""
    with conn.cursor() as cur:
        cur.execute("DELETE FROM wallet_edges WHERE data_source = %s", (data_source,))
    insert_edges(conn, rows, data_source)


def insert_edges(conn: psycopg.Connection, rows: Sequence[tuple], data_source: str) -> int:
    """rows: (src, dst, mint, amount_usd, ts, tx_sig). Append only, duplicates are ignored."""
    sql = """
      INSERT INTO wallet_edges(src, dst, mint, amount_usd, ts, tx_sig, data_source) VALUES (%s, %s, %s, %s, %s, %s, %s)
      ON CONFLICT (tx_sig, src, dst, mint) DO NOTHING
    """
    with conn.cursor() as cur:
        cur.executemany(sql, [(s, d, m, float(u), dt(t), sig, data_source) for (s, d, m, u, t, sig) in rows])
    return len(rows)


def replace_scored_positions(conn: psycopg.Connection, data_source: str, market_ids: Sequence[str], rows: Sequence[PositionRow]) -> None:
    """Replace the positions of one data source in the given markets (a run owns its own rows, never the others')."""
    with conn.cursor() as cur:
        if market_ids:
            cur.execute("DELETE FROM scored_positions WHERE data_source = %s AND market_id = ANY(%s)", (data_source, list(market_ids)))
        cur.executemany(
            """INSERT INTO scored_positions(market_id, wallet, side, usdc, entry_price, ts, data_source)
               VALUES (%s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (market_id, wallet, side) DO UPDATE SET usdc = EXCLUDED.usdc, entry_price = EXCLUDED.entry_price,
                 ts = EXCLUDED.ts, data_source = EXCLUDED.data_source""",
            [(r.market_id, r.wallet, r.side, r.usdc, round(r.entry_price, 6), dt(r.ts), r.data_source) for r in rows],
        )


MIRROR_SQL = """
WITH net AS (
  SELECT market_id, wallet, side,
         SUM(CASE WHEN direction = 'buy' THEN usdc ELSE -usdc END) AS net_usdc,
         (array_agg(ts ORDER BY ts, id) FILTER (WHERE direction = 'buy'))[1] AS first_ts,
         (array_agg(id ORDER BY ts, id) FILTER (WHERE direction = 'buy'))[1] AS first_id
  FROM trades GROUP BY market_id, wallet, side
)
SELECT n.market_id, n.wallet, n.side,
       CASE WHEN p.wallet IS NOT NULL THEN p.cost_basis_usdc ELSE n.net_usdc END AS usdc,
       COALESCE(
         (SELECT t2.price_after FROM trades t2
           WHERE t2.market_id = n.market_id AND (t2.ts, t2.id) < (n.first_ts, n.first_id)
           ORDER BY t2.ts DESC, t2.id DESC LIMIT 1),
         (SELECT t3.price_after FROM trades t3 WHERE t3.id = n.first_id)) AS entry_price,
       n.first_ts
FROM net n
LEFT JOIN positions p ON p.wallet = n.wallet AND p.market_id = n.market_id AND p.side = n.side
WHERE n.first_ts IS NOT NULL
  AND (CASE WHEN p.wallet IS NOT NULL THEN p.shares > 0 AND p.cost_basis_usdc > 0 ELSE n.net_usdc > 0 END)
"""


def mirror_onchain_positions(conn: psycopg.Connection) -> int:
    """Wallets that traded on Groundgraph markets (trades/positions written by the indexer) become scored_positions rows
    with data_source = 'onchain'. The set is replaced atomically so closed positions disappear."""
    with conn.cursor() as cur:
        cur.execute(MIRROR_SQL)
        rows = cur.fetchall()
        cur.execute("DELETE FROM scored_positions WHERE data_source = 'onchain'")
        cur.executemany(
            """INSERT INTO scored_positions(market_id, wallet, side, usdc, entry_price, ts, data_source)
               VALUES (%s, %s, %s, %s, %s, %s, 'onchain')
               ON CONFLICT (market_id, wallet, side) DO UPDATE SET usdc = EXCLUDED.usdc, entry_price = EXCLUDED.entry_price,
                 ts = EXCLUDED.ts, data_source = 'onchain'""",
            [(m, w, s, u, e, t) for (m, w, s, u, e, t) in rows],
        )
    conn.commit()
    return len(rows)


def read_radar_positions(conn: psycopg.Connection, market_ids: Sequence[str], pos_sources: Sequence[str], wallet_sources: Sequence[str]) -> list[dict]:
    """Positions of the given markets joined with the latest wallet score flag, hit rate and sybil cluster."""
    if not market_ids:
        return []
    sql = """
      WITH w AS (SELECT DISTINCT wallet FROM scored_positions WHERE market_id = ANY(%(mids)s) AND data_source = ANY(%(psrc)s)),
      ls AS (
        SELECT DISTINCT ON (s.address) s.address, s.smart, s.score FROM wallet_scores s JOIN w ON w.wallet = s.address
        WHERE s.data_source = ANY(%(wsrc)s) ORDER BY s.address, s.as_of DESC
      ),
      lf AS (
        SELECT DISTINCT ON (f.address) f.address, f.hit_rate FROM wallet_features f JOIN w ON w.wallet = f.address
        ORDER BY f.address, f.as_of DESC
      )
      SELECT sp.market_id, sp.wallet, sp.side, sp.usdc, sp.data_source,
             (ls.address IS NOT NULL) AS scored, COALESCE(ls.smart, false) AS smart, lf.hit_rate, wl.sybil_cluster_id
      FROM scored_positions sp
      LEFT JOIN ls ON ls.address = sp.wallet
      LEFT JOIN lf ON lf.address = sp.wallet
      LEFT JOIN wallets wl ON wl.address = sp.wallet
      WHERE sp.market_id = ANY(%(mids)s) AND sp.data_source = ANY(%(psrc)s)
        AND NOT COALESCE(wl.label_hidden, false)  -- wallets that opted out of labels never count towards the radar
      ORDER BY sp.market_id, sp.wallet, sp.side
    """
    with conn.cursor() as cur:
        cur.execute(sql, {"mids": list(market_ids), "psrc": list(pos_sources), "wsrc": list(wallet_sources)})
        cols = ["market_id", "wallet", "side", "usdc", "data_source", "scored", "smart", "hit_rate", "sybil_cluster_id"]
        out = [dict(zip(cols, r)) for r in cur.fetchall()]
    conn.commit()
    return out


def write_radar(conn: psycopg.Connection, rows: Sequence[dict]) -> None:
    sql = """
      INSERT INTO market_radar(market_id, ts, p_above, p_above_raw, ci_pts, n_flagged, edge_cents, flagged_vol_above,
                               flagged_vol_below, state, model_version, data_source)
      VALUES (%(market_id)s, %(ts)s, %(p_above)s, %(p_above_raw)s, %(ci_pts)s, %(n_flagged)s, %(edge_cents)s,
              %(vol_above)s, %(vol_below)s, %(state)s, %(model_version)s, %(data_source)s)
      ON CONFLICT (market_id, ts) DO UPDATE SET p_above = EXCLUDED.p_above, p_above_raw = EXCLUDED.p_above_raw,
        ci_pts = EXCLUDED.ci_pts, n_flagged = EXCLUDED.n_flagged, edge_cents = EXCLUDED.edge_cents,
        flagged_vol_above = EXCLUDED.flagged_vol_above, flagged_vol_below = EXCLUDED.flagged_vol_below,
        state = EXCLUDED.state, model_version = EXCLUDED.model_version, data_source = EXCLUDED.data_source
    """
    with conn.cursor() as cur:
        cur.executemany(sql, list(rows))


def prune_radar(conn: psycopg.Connection, now: float, keep_full_hours: float = 48.0) -> int:
    """Thin per-minute radar rows older than keep_full_hours to one row per hour."""
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM market_radar WHERE ts < %s AND date_trunc('hour', ts) <> ts",
            (dt(now - keep_full_hours * 3600.0),),
        )
        return cur.rowcount


def prune_history(conn: psycopg.Connection, now: float, keep_days: float = 14.0) -> None:
    """Keep every hourly score/feature row for keep_days, afterwards only the midnight row of each day."""
    cutoff = dt(now - keep_days * 86400.0)
    with conn.cursor() as cur:
        cur.execute("DELETE FROM wallet_scores WHERE as_of < %s AND date_trunc('day', as_of) <> as_of", (cutoff,))
        cur.execute("DELETE FROM wallet_features WHERE as_of < %s AND date_trunc('day', as_of) <> as_of", (cutoff,))


def write_track_record(conn: psycopg.Connection, result, data_source: str, model_version: str, run_at: float) -> int:
    """Insert one track_record_runs row (+ rows). A re-run over the same window and model replaces the previous run."""
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM track_record_runs WHERE data_source = %s AND window_start = %s AND window_end = %s AND model_version = %s",
            (data_source, dt(result.window_start), dt(result.window_end), model_version),
        )
        cur.execute(
            """INSERT INTO track_record_runs(run_at, window_start, window_end, data_source, n_markets, brier_radar, brier_market,
                 hit_rate_radar, hit_rate_market, median_lead_min, edge_realized_cents, calibration, lead_hist, model_version)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
            (dt(run_at), dt(result.window_start), dt(result.window_end), data_source, result.n_markets, result.brier_radar,
             result.brier_market, result.hit_rate_radar, result.hit_rate_market, result.median_lead_min,
             result.edge_realized_cents, Jsonb(result.calibration), Jsonb(result.lead_hist), model_version),
        )
        run_id = cur.fetchone()[0]
        cur.executemany(
            """INSERT INTO track_record_rows(run_id, market_id, question, radar_t24, market_t24, outcome, closer)
               VALUES (%s, %s, %s, %s, %s, %s, %s)""",
            [(run_id, r["market_id"], r["question"], round(r["radar_t24"], 6), round(r["market_t24"], 6), r["outcome"], r["closer"])
             for r in result.rows],
        )
    return int(run_id)
