"""Integration tests against a real PostgreSQL database created by scripts/dev-db.sh (never the groundgraph DB)."""

from __future__ import annotations

import dataclasses
import json
from datetime import timedelta

import numpy as np
import pytest

from fixtures import FIXTURE_MARKETS, NOW, insert_fixture_markets, insert_market
from scorer import pipeline, store
from scorer.config import Params, Settings
from scorer.sources.synthetic import SyntheticSource

pytestmark = pytest.mark.db
NOW_TS = NOW.timestamp()


def settings(db_url, demo=True):
    return Settings.from_env({"DATABASE_URL": db_url, "DEMO_MODE": "true" if demo else "false"})


@pytest.fixture(autouse=True)
def small_world(monkeypatch, small_ds):
    """run_full builds the dataset through pipeline.get_dataset; hand it the small world so the tests stay fast."""
    monkeypatch.setattr(pipeline, "get_dataset", lambda conn, s, p, source, now: small_ds)


def q(conn, sql, args=None):
    with conn.cursor() as cur:
        cur.execute(sql, args)
        rows = cur.fetchall()
    conn.commit()
    return rows


def snapshot(conn):
    """Everything the API reads, in a comparable form."""
    return {
        "scores": q(conn, "SELECT address, as_of, score, smart, top, contributions::text, reasons::text, model_version, data_source FROM wallet_scores ORDER BY address, as_of"),
        "feats": q(conn, "SELECT address, as_of, whale_overlap, entry_timing, hit_rate, centrality, lead_time_min, n_markets FROM wallet_features ORDER BY address, as_of"),
        "wallets": q(conn, "SELECT address, cluster_id, cluster_name, sybil_cluster_id, label_hidden, data_source FROM wallets ORDER BY address"),
        "layout": q(conn, "SELECT address, x, y, z FROM graph_layout ORDER BY address"),
        "edges": q(conn, "SELECT count(*), sum(amount_usd) FROM wallet_edges"),
        "pos": q(conn, "SELECT market_id, wallet, side, usdc, entry_price, ts FROM scored_positions ORDER BY market_id, wallet, side"),
        "radar": q(conn, "SELECT market_id, ts, p_above, p_above_raw, ci_pts, n_flagged, edge_cents, state, model_version, data_source FROM market_radar ORDER BY market_id, ts"),
        "runs": q(conn, "SELECT count(*) FROM track_record_runs"),
    }


@pytest.fixture()
def ran(db, db_url, params):
    insert_fixture_markets(db)
    s = settings(db_url)
    summary = pipeline.run_full(db, s, params, "synthetic", NOW_TS)  # trains on the first call, then reuses the stored model
    return db, s, summary


def test_run_writes_every_table_with_demo_labels(ran):
    conn, s, summary = ran
    assert summary["scored"] > 50 and summary["layout"] == summary["scored"] and summary["radar_rows"] == 3
    for t in ("wallets", "wallet_scores", "graph_layout", "wallet_edges", "scored_positions", "market_radar", "track_record_runs"):
        rows = q(conn, f"SELECT DISTINCT data_source FROM {t}")
        assert rows == [("demo-synthetic",)] or t == "market_radar" and set(r[0] for r in rows) <= {"demo-synthetic", "onchain"}, t
    assert q(conn, "SELECT count(*) FROM wallet_features")[0][0] == summary["scored"]
    assert q(conn, "SELECT count(*) FROM wallet_scores WHERE smart")[0][0] == summary["flagged"]
    # the model, its calibrator and the card live in indexer_state
    keys = {r[0] for r in q(conn, "SELECT key FROM indexer_state")}
    assert {"scorer:model:demo-synthetic", "scorer:calibrator:demo-synthetic", "scorer:meta:demo-synthetic", "scorer:model_card:demo-synthetic"} <= keys


def test_scores_contributions_and_reasons_follow_the_api_contract(ran):
    conn, _, _ = ran
    rows = q(conn, "SELECT score, contributions, reasons, smart, top FROM wallet_scores")
    assert rows
    for score, contrib, reasons, smart, top in rows:
        assert 0 <= score <= 100
        assert set(contrib) == {"whale_overlap", "entry_timing", "hit_rate", "centrality", "lead_time"}
        assert all(isinstance(v, int) and v >= 0 for v in contrib.values())
        assert sum(contrib.values()) == score  # contributions sum exactly to the score
        assert isinstance(reasons, list) and len(reasons) <= 3 and all(isinstance(r, str) and chr(0x2014) not in r for r in reasons)
        assert (not top) or smart
    assert any(s for *_, s, _t in rows)
    f = q(conn, "SELECT min(whale_overlap), max(whale_overlap), min(entry_timing), max(entry_timing), min(hit_rate), max(hit_rate), min(centrality), max(centrality), min(n_markets) FROM wallet_features")[0]
    assert all(0 <= float(v) <= 1 for v in f[:8]) and f[8] >= 0


def test_layout_edges_and_clusters(ran):
    conn, _, summary = ran
    lo, hi = q(conn, "SELECT least(min(x), min(y), min(z)), greatest(max(x), max(y), max(z)) FROM graph_layout")[0]
    assert -1.6 <= lo and hi <= 1.6
    names = {r[0] for r in q(conn, "SELECT DISTINCT cluster_name FROM wallets WHERE cluster_name IS NOT NULL")}
    assert 3 <= len(names) <= 12 and all(n for n in names)
    assert q(conn, "SELECT count(*) FROM wallets WHERE cluster_id IS NULL")[0][0] == 0
    n_edges, usd = q(conn, "SELECT count(*), sum(amount_usd) FROM wallet_edges")[0]
    assert n_edges > 100 and usd > 0
    # sybil ids are only set for flagged wallets
    bad = q(conn, "SELECT count(*) FROM wallets w JOIN wallet_scores s ON s.address = w.address WHERE w.sybil_cluster_id IS NOT NULL AND NOT s.smart")
    assert bad[0][0] == 0


def test_scored_positions_use_base_units_and_open_market_ids(ran):
    conn, _, _ = ran
    ids = {m[0] for m in FIXTURE_MARKETS}
    rows = q(conn, "SELECT market_id, side, usdc, entry_price FROM scored_positions")
    assert rows and {r[0] for r in rows} <= ids
    assert {r[1] for r in rows} <= {"above", "below"}
    assert all(1e6 <= float(r[2]) <= 1e12 and 0 < float(r[3]) < 1 for r in rows)  # base units (6 dp), ABOVE price 0..1


def test_radar_rows_ready_and_building_follow_the_rules(ran):
    conn, _, _ = ran
    rows = q(conn, "SELECT r.market_id, r.p_above, r.p_above_raw, r.ci_pts, r.n_flagged, r.edge_cents, r.state, r.model_version, t.price_above "
                   "FROM market_radar r JOIN LATERAL (SELECT price_above FROM market_ticks WHERE market_id = r.market_id ORDER BY ts DESC LIMIT 1) t ON true")
    assert len(rows) == 3
    for mid, p, praw, ci, n, edge, state, mv, pm in rows:
        assert mv.startswith("radar-v1/")
        if state == "ready":
            assert n >= 3 and 0 < float(p) < 1 and ci >= 2 and float(praw) > 0
            assert edge == int(np.floor(100 * (float(p) - float(pm)) + 0.5)) or abs(edge - 100 * (float(p) - float(pm))) <= 1.0
        else:
            assert float(p) == pytest.approx(float(pm), abs=1e-6) and ci == 0 and edge == 0 and praw is None


def test_track_record_is_written_with_an_honest_data_source(ran):
    conn, _, _ = ran
    run = q(conn, "SELECT data_source, n_markets, brier_radar, brier_market, calibration, lead_hist, model_version FROM track_record_runs")
    assert len(run) == 1
    ds, n, br, bm, cal, lead, mv = run[0]
    assert ds == "demo-synthetic" and n > 5 and 0 <= float(br) <= 1 and 0 <= float(bm) <= 1
    assert all(set(c) >= {"bin", "predicted", "observed", "n"} for c in cal) and all(set(h) == {"bucketMin", "count"} for h in lead)
    assert q(conn, "SELECT count(*) FROM track_record_rows")[0][0] == n
    outcomes = {r[0] for r in q(conn, "SELECT DISTINCT outcome FROM track_record_rows")}
    assert outcomes <= {"above", "below"}


def test_rerun_is_idempotent(ran, params):
    conn, s, _ = ran
    before = snapshot(conn)
    pipeline.run_full(conn, s, params, "synthetic", NOW_TS)  # no retrain this time: the stored model is used
    after = snapshot(conn)
    for k in before:
        assert before[k] == after[k], k


def test_label_hidden_is_never_written_and_hidden_wallets_have_no_layout(db, db_url, params, small_ds):
    insert_fixture_markets(db)
    lat = small_ds.meta["latent"]
    hidden = sorted(a for a, v in lat.items() if v["informed"])[:2]
    with db.cursor() as cur:
        for a in hidden:
            cur.execute("INSERT INTO wallets(address, label_hidden, data_source) VALUES (%s, true, 'demo-synthetic')", (a,))
    db.commit()
    s = settings(db_url)
    pipeline.run_full(db, s, params, "synthetic", NOW_TS, with_track=False)
    pipeline.run_full(db, s, params, "synthetic", NOW_TS, with_track=False)
    rows = q(db, "SELECT address, label_hidden FROM wallets WHERE address = ANY(%s)", (hidden,))
    assert len(rows) == 2 and all(r[1] is True for r in rows)
    assert q(db, "SELECT count(*) FROM graph_layout WHERE address = ANY(%s)", (hidden,))[0][0] == 0
    # nobody else was hidden by the scorer
    assert q(db, "SELECT count(*) FROM wallets WHERE label_hidden")[0][0] == 2
    # hidden wallets do not count towards the radar
    pos = store.read_radar_positions(db, [m[0] for m in FIXTURE_MARKETS], ["demo-synthetic"], ["demo-synthetic"])
    assert not {p["wallet"] for p in pos} & set(hidden)


def test_building_state_for_a_market_without_flagged_positions(ran):
    conn, s, _ = ran
    quiet = "QuietMarket111111111111111111111111111111111"
    insert_market(conn, quiet, "ETH", 0.37, 250.0, 100.0)
    conn.commit()
    rows = pipeline.radar_refresh(conn, s, Params(), NOW_TS + 120)
    row = next(r for r in rows if r["market_id"] == quiet)
    assert row["state"] == "building" and row["n_flagged"] == 0 and row["ci_pts"] == 0 and row["edge_cents"] == 0
    assert row["p_above"] == pytest.approx(0.37, abs=1e-6) and row["p_above_raw"] is None


def test_demo_rows_are_ignored_when_demo_mode_is_off(ran):
    conn, s, _ = ran
    live = dataclasses.replace(s, demo_mode=False)
    rows = pipeline.radar_refresh(conn, live, Params(), NOW_TS + 300)
    assert rows and all(r["state"] == "building" and r["n_flagged"] == 0 and r["data_source"] == "onchain" for r in rows)


def test_synthetic_source_is_refused_without_demo_mode(db, db_url, params):
    with pytest.raises(PermissionError):
        pipeline.run_full(db, settings(db_url, demo=False), params, "synthetic", NOW_TS)
    assert q(db, "SELECT count(*) FROM wallet_scores")[0][0] == 0


def test_radar_refresh_survives_markets_without_any_tick(db, db_url, params):
    insert_market(db, "NoTick1111111111111111111111111111111111111", "SOL", 0.4, 100.0, 50.0, with_tick=False)
    db.commit()
    rows = pipeline.radar_refresh(db, settings(db_url), params, NOW_TS)
    assert len(rows) == 1 and rows[0]["state"] == "building"


# --------------------------------------------------------------------------- onchain mirror
def add_trade(conn, mid, wallet, direction, usdc, price_after, ts, sig, side="above"):
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO trades(market_id, wallet, side, direction, usdc, shares, fee_usdc, price_after, tx_sig, ix_index, slot, ts)
               VALUES (%s, %s, %s, %s, %s, %s, 0, %s, %s, 0, 1, %s)""",
            (mid, wallet, side, direction, usdc, usdc, price_after, sig, ts),
        )


def set_position(conn, wallet, mid, shares, cost, side="above"):
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO positions(wallet, market_id, side, shares, cost_basis_usdc) VALUES (%s, %s, %s, %s, %s)
               ON CONFLICT (wallet, market_id, side) DO UPDATE SET shares = EXCLUDED.shares, cost_basis_usdc = EXCLUDED.cost_basis_usdc""",
            (wallet, mid, side, shares, cost),
        )


def test_onchain_mirror_writes_open_positions_and_drops_closed_ones(db):
    mid = FIXTURE_MARKETS[0][0]
    insert_fixture_markets(db)
    t0 = NOW - timedelta(hours=5)
    add_trade(db, mid, "WalletOpen1", "buy", 100_000_000, 0.30, t0, "sig1")
    add_trade(db, mid, "WalletOpen1", "buy", 50_000_000, 0.35, t0 + timedelta(hours=1), "sig2")
    add_trade(db, mid, "WalletClosed", "buy", 20_000_000, 0.36, t0 + timedelta(hours=2), "sig3")
    add_trade(db, mid, "WalletClosed", "sell", 21_000_000, 0.34, t0 + timedelta(hours=3), "sig4")
    set_position(db, "WalletOpen1", mid, 480_000_000, 150_000_000)
    set_position(db, "WalletClosed", mid, 0, 0)
    db.commit()
    assert store.mirror_onchain_positions(db) == 1
    rows = q(db, "SELECT wallet, side, usdc, entry_price, data_source FROM scored_positions")
    assert rows == [("WalletOpen1", "above", rows[0][2], rows[0][3], "onchain")]
    assert float(rows[0][2]) == 150_000_000 and float(rows[0][3]) == pytest.approx(0.30)
    # the position is closed later: the next mirror removes it
    set_position(db, "WalletOpen1", mid, 0, 0)
    db.commit()
    assert store.mirror_onchain_positions(db) == 0
    assert q(db, "SELECT count(*) FROM scored_positions")[0][0] == 0


def test_onchain_mirror_leaves_demo_rows_alone(ran):
    conn, s, _ = ran
    before = q(conn, "SELECT count(*) FROM scored_positions WHERE data_source = 'demo-synthetic'")[0][0]
    assert before > 0
    store.mirror_onchain_positions(conn)
    assert q(conn, "SELECT count(*) FROM scored_positions WHERE data_source = 'demo-synthetic'")[0][0] == before


def test_onchain_run_computes_the_radar_from_mirrored_positions(db, db_url, params):
    """Source 'onchain' needs no wallet dataset: only the mirror and the radar run."""
    mid = FIXTURE_MARKETS[0][0]
    insert_fixture_markets(db)
    add_trade(db, mid, "WalletOpen1", "buy", 100_000_000, 0.30, NOW - timedelta(hours=5), "sigA")
    set_position(db, "WalletOpen1", mid, 300_000_000, 100_000_000)
    db.commit()
    out = pipeline.run_full(db, settings(db_url, demo=False), params, "onchain", NOW_TS)
    assert out["source"] == "onchain" and out["radar_rows"] == 3
    rows = q(db, "SELECT state, n_flagged, data_source FROM market_radar")
    assert {r[0] for r in rows} == {"building"} and {r[2] for r in rows} == {"onchain"}  # no scored wallets on chain yet


# --------------------------------------------------------------------------- track record writer
def test_track_record_rerun_replaces_the_same_window(ran, params, small_ds):
    conn, s, _ = ran
    first = q(conn, "SELECT id, window_start, window_end, model_version FROM track_record_runs")[0]
    res = pipeline.track_record_only(conn, s, params, "synthetic", NOW_TS + 3600, ds=small_ds)
    runs = q(conn, "SELECT id, window_start, window_end, model_version, run_at FROM track_record_runs")
    assert len(runs) == 1 and runs[0][1:4] == first[1:4] and runs[0][0] != first[0]
    assert q(conn, "SELECT count(*) FROM track_record_rows")[0][0] == res.n_markets
    pipeline.track_record_only(conn, s, params, "synthetic", NOW_TS + 7200, ds=small_ds)
    assert q(conn, "SELECT count(*) FROM track_record_runs")[0][0] == 1


def test_advisory_lock_is_exclusive(db, db_url):
    import psycopg

    other = psycopg.connect(db_url)
    try:
        with store.advisory_lock(db, "x") as got:
            assert got
            with store.advisory_lock(other, "x") as got2:
                assert not got2
        with store.advisory_lock(other, "x") as got3:
            assert got3
    finally:
        other.close()


def test_compute_radar_rows_is_pure_and_ignores_unscored_or_unflagged_wallets():
    from scorer.radar import identity_calibrator
    from scorer.types import OpenMarket

    m = OpenMarket("M1", "SOL", NOW_TS - 1000, NOW_TS + 86400 * 5, NOW_TS + 86400 * 5 + 3600, 0.4, 200.0)
    pos = [
        dict(market_id="M1", wallet=f"s{i}", side="above", usdc=5e9, data_source="demo-synthetic", scored=True, smart=True, hit_rate=0.8, sybil_cluster_id=None)
        for i in range(4)
    ] + [
        dict(market_id="M1", wallet=f"crowd{i}", side="below", usdc=9e9, data_source="demo-synthetic", scored=True, smart=False, hit_rate=0.9, sybil_cluster_id=None)
        for i in range(7)  # 4 flagged + 7 crowd = 11 scored positions, above the minimum of 10 scored trades
    ] + [
        dict(market_id="M1", wallet="unscored", side="below", usdc=9e9, data_source="demo-synthetic", scored=False, smart=False, hit_rate=None, sybil_cluster_id=None),
    ]
    rows = pipeline.compute_radar_rows([m], pos, NOW_TS, Params(), identity_calibrator(), "v-test")
    assert len(rows) == 1 and rows[0]["state"] == "ready" and rows[0]["n_flagged"] == 4
    assert rows[0]["p_above"] > 0.4 and rows[0]["vol_above"] == round(4 * 5000 * 1e6) and rows[0]["vol_below"] == 0
