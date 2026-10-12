"""Feature definitions against hand computed answers on a tiny world (graph, whales, entry timing, hit rate, lead)."""

from __future__ import annotations

import dataclasses

import numpy as np
import pytest

from scorer.config import DAY, HOUR, Params
from scorer.dataset import Dataset, DatasetBuilder, Positions
from scorer.features import compute_features
from scorer.graph import build_window_graph, pagerank, percentile_rank, whales_at

T = 100 * DAY
P = dataclasses.replace(Params(), min_whales=1)


def world(positions: list[dict] | None = None) -> Dataset:
    b = DatasetBuilder("test", 0.0, T + 10 * DAY)
    for a in ("a1", "a2", "a3"):
        b.wallet(a, 0.0)
    b.wallet("a4")  # first seen at its first edge, which is stamped at as_of: not yet active at T
    b.node("whale", 0.0)
    b.edge("a1", "whale", 100, T - 7 * DAY)       # weight 100 * 0.5 ** (7 / 7)  = 50
    b.edge("a2", "a1", 100, T - 14 * DAY)         # weight 25
    b.edge("a3", "whale", 10, T - 1 * DAY)        # weight 10 * 0.5 ** (1 / 7)
    b.edge("a4", "a2", 999, T)                    # at as_of: excluded (ts < as_of)
    b.edge("a3", "a2", 40, T - 30 * DAY)          # exactly window old: included
    b.edge("a1", "a3", 77, T - 30 * DAY - 1)      # one second older than the window: excluded
    b.balance("whale", 0.0, 1e6)
    for a in ("a1", "a2", "a3"):
        b.balance(a, 0.0, 100.0)
    b.balance("a2", T + 5 * DAY, 1e9)             # in the future: must not make a2 a whale at T
    ds = b.build(P)
    if positions is not None:
        ds.positions = make_positions(ds, positions)
    return ds


def make_positions(ds: Dataset, rows: list[dict]) -> Positions:
    rows = sorted(rows, key=lambda r: (r["wallet"], r["first_ts"]))
    n = len(rows)
    col = lambda k, dt: np.array([r[k] for r in rows], dtype=dt)  # noqa: E731
    wallet = col("wallet", np.int32)
    ptr = np.searchsorted(wallet, np.arange(ds.n_nodes + 1))
    return Positions(
        wallet=wallet, market=col("market", np.int32), side=np.ones(n, dtype=np.int8), usd=np.full(n, 100.0),
        first_ts=col("first_ts", np.float64), entry_price=np.full(n, 0.5), settle_ts=col("settle_ts", np.float64),
        outcome=col("win", np.int8), win=col("win", np.int8), pnl=col("pnl", np.float64), fav_ts=col("fav_ts", np.float64),
        ptr=ptr.astype(np.int64), trade_pos=np.zeros(0, dtype=np.int32),
    )


def a1_positions(**over) -> list[dict]:
    inf = float("inf")
    rows = [
        dict(market=0, first_ts=T - 20 * DAY, settle_ts=T - 5 * DAY, win=1, pnl=10.0, fav_ts=T - 20 * DAY + 30 * 60),
        dict(market=1, first_ts=T - 15 * DAY, settle_ts=T - 3 * DAY, win=-1, pnl=-10.0, fav_ts=inf),
        dict(market=2, first_ts=T - 10 * DAY, settle_ts=T - 2 * DAY, win=1, pnl=10.0, fav_ts=T - 10 * DAY + 2 * HOUR),
        # opened one hour before as_of: its 24h look-ahead has not elapsed and it settles after as_of
        dict(market=3, first_ts=T - HOUR, settle_ts=T + 5 * DAY, win=1, pnl=10.0, fav_ts=T - HOUR + 600),
    ]
    for r in rows:
        r["wallet"] = 0  # node index of a1 (nodes are sorted: a1, a2, a3, a4, whale)
    for k, v in over.items():
        i, f = k.split("_", 1)
        rows[int(i)][f] = v
    return rows


# --------------------------------------------------------------------------- graph
def test_window_graph_is_half_open_and_decayed():
    ds = world()
    g = build_window_graph(ds, T, P)
    ix = ds.index
    A = g.A
    assert A[ix["a1"], ix["whale"]] == pytest.approx(50.0)
    assert A[ix["a2"], ix["a1"]] == pytest.approx(25.0)
    assert A[ix["a3"], ix["whale"]] == pytest.approx(10 * 0.5 ** (1 / 7))
    assert A[ix["a3"], ix["a2"]] == pytest.approx(40 * 0.5 ** (30 / 7))  # edge exactly 30 days old is inside the window
    assert A[ix["a4"], ix["a2"]] == 0  # edge stamped exactly at as_of is outside
    assert A[ix["a1"], ix["a3"]] == 0  # one second too old
    assert (A != A.T).nnz == 0  # symmetric
    assert list(g.active[[ix["a1"], ix["a2"], ix["a3"], ix["a4"]]]) == [True, True, True, False]


def test_percentile_rank_is_mid_rank_with_ties():
    assert list(percentile_rank(np.array([5.0, 1.0, 3.0]))) == pytest.approx([5 / 6, 1 / 6, 0.5])
    assert list(percentile_rank(np.array([2.0, 2.0, 9.0, 1.0]))) == pytest.approx([0.5, 0.5, 7 / 8, 1 / 8])


def test_pagerank_is_a_distribution_and_symmetric_nodes_tie():
    import scipy.sparse as sp

    A = sp.csr_matrix(np.array([[0, 1, 0, 0], [1, 0, 1, 0], [0, 1, 0, 1], [0, 0, 1, 0]], dtype=float))
    pr = pagerank(A, np.ones(4, dtype=bool))
    assert pr.sum() == pytest.approx(1.0)
    assert pr[0] == pytest.approx(pr[3]) and pr[1] == pytest.approx(pr[2]) and pr[1] > pr[0]


def test_whales_use_the_latest_balance_at_or_before_as_of():
    ds = world()
    assert [ds.nodes[i] for i in whales_at(ds, T, P)] == ["whale"]  # a2's huge balance is dated after T
    assert [ds.nodes[i] for i in whales_at(ds, T + 6 * DAY, P)] == ["a2"]
    assert whales_at(ds, -1.0, P).size == 0


# --------------------------------------------------------------------------- features
def test_whale_overlap_centrality_and_activity():
    ds = world()
    ft = compute_features(ds, T, P)
    ix = {ds.nodes[w]: k for k, w in enumerate(ft.wallets.tolist())}
    assert ft.whale_overlap[ix["a1"]] == pytest.approx(0.5)  # counterparties: whale, a2
    assert ft.whale_overlap[ix["a2"]] == pytest.approx(0.0)  # a1, a3
    assert ft.whale_overlap[ix["a3"]] == pytest.approx(0.5)  # whale, a2
    assert ft.whale_overlap[ix["a4"]] == 0.0
    assert list(ft.active) == [True, True, True, False]
    # PageRank of the weighted undirected graph follows weighted degree: a1 (75) > a2 (26) > a3 (10)
    assert ft.centrality[ix["a1"]] == pytest.approx(5 / 6)
    assert ft.centrality[ix["a2"]] == pytest.approx(0.5)
    assert ft.centrality[ix["a3"]] == pytest.approx(1 / 6)
    assert ft.centrality[ix["a4"]] == 0.0
    assert list(ft.n_cp[:3]) == [2, 2, 2] and list(ft.n_whale_cp[:3]) == [1, 0, 1]


def test_hit_rate_entry_timing_and_lead_with_shrinkage():
    ds = world(a1_positions())
    ft = compute_features(ds, T, P)
    # resolved in the window: 3 positions, 2 correct -> (2 + 1.5) / (3 + 3)
    assert (ft.hit_n[0], ft.hit_k[0]) == (3, 2)
    assert ft.hit_rate[0] == pytest.approx(3.5 / 6)
    # eligible entries (24h look-ahead elapsed): the first three; early on two of them -> (2 + 1.5) / (3 + 3)
    assert (ft.n_entries[0], ft.n_early[0]) == (3, 2)
    assert ft.entry_timing[0] == pytest.approx(3.5 / 6)
    assert ft.lead_time_min[0] == pytest.approx(np.median([30.0, 120.0]))
    assert ft.n_markets[0] == 4  # the fresh entry counts as a market entered in the window
    # wallets without positions sit at the neutral prior
    assert ft.hit_rate[1] == 0.5 and ft.entry_timing[1] == 0.5 and ft.lead_time_min[1] == 0.0


def test_excluding_the_scored_market_removes_it_from_hit_rate_and_entries():
    ds = world(a1_positions())
    ft = compute_features(ds, T, P, exclude_market=1)
    assert (ft.hit_n[0], ft.hit_k[0]) == (2, 2)
    assert ft.hit_rate[0] == pytest.approx(3.5 / 5)
    assert (ft.n_entries[0], ft.n_early[0]) == (2, 2)
    assert ft.entry_timing[0] == pytest.approx(3.5 / 5)
    assert ft.n_markets[0] == 3


def test_the_future_of_a_position_is_invisible_before_it_has_elapsed():
    base = compute_features(world(a1_positions()), T, P)
    # the recent entry's outcome, price path and settlement are in the future relative to as_of
    alt = compute_features(world(a1_positions(**{"3_fav_ts": float("inf"), "3_win": -1, "3_settle_ts": T + 50 * DAY, "3_pnl": -99.0})), T, P)
    for f in ("hit_rate", "entry_timing", "lead_time_min", "n_entries", "n_early", "hit_n", "hit_k"):
        assert getattr(alt, f).tolist() == getattr(base, f).tolist(), f
    # a position resolved after as_of never feeds the hit rate even when its settle time is just past
    late = compute_features(world(a1_positions(**{"2_settle_ts": T + 1.0})), T, P)
    assert late.hit_n[0] == 2


def test_entry_timing_uses_only_the_sixty_day_lookback_and_last_fourteen_entries():
    rows = []
    for k in range(20):  # 20 entries between 59 and 11.5 days before as_of, none of them early
        rows.append(dict(wallet=0, market=k, first_ts=T - (59 - 2.5 * k) * DAY, settle_ts=T + DAY, win=0, pnl=0.0, fav_ts=float("inf")))
    rows.append(dict(wallet=0, market=99, first_ts=T - 70 * DAY, settle_ts=T + DAY, win=0, pnl=0.0, fav_ts=T - 70 * DAY + 60))
    ft = compute_features(world(rows), T, P)
    assert ft.n_entries[0] == 14  # the last 14 of the 20 eligible entries
    assert ft.n_early[0] == 0  # the early entry 70 days ago is outside the lookback
