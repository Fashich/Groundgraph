"""Heuristic wallet features, computed strictly point in time (only data before as_of)."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .config import DAY, HOUR, Params
from .dataset import Dataset
from .graph import WindowGraph, build_window_graph, pagerank, percentile_rank, whales_at


@dataclass
class FeatureTable:
    as_of: float
    wallets: np.ndarray  # node indices of the scored universe
    active: np.ndarray  # first_seen < as_of
    whale_overlap: np.ndarray
    entry_timing: np.ndarray
    hit_rate: np.ndarray
    centrality: np.ndarray
    lead_time_min: np.ndarray
    n_markets: np.ndarray
    # auxiliary counts used for reasons, gating and cluster naming
    n_cp: np.ndarray
    n_whale_cp: np.ndarray
    n_entries: np.ndarray  # eligible entries used for entry_timing (<= entry_n)
    n_early: np.ndarray
    hit_n: np.ndarray
    hit_k: np.ndarray
    degree: np.ndarray
    bridged: np.ndarray
    trade_rate: np.ndarray  # trades per day in the window
    median_size: np.ndarray  # median trade USD in the window
    pagerank: np.ndarray
    graph: WindowGraph

    def matrix(self) -> np.ndarray:
        """Raw heuristic columns [whale_overlap, entry_timing, hit_rate, centrality, lead_time_min]."""
        return np.stack([self.whale_overlap, self.entry_timing, self.hit_rate, self.centrality, self.lead_time_min], axis=1)


def _bridged(graph: WindowGraph, communities: np.ndarray | None, wallets: np.ndarray) -> np.ndarray:
    out = np.zeros(wallets.size)
    if communities is None:
        return out
    A = graph.A
    for k, w in enumerate(wallets.tolist()):
        nb = A.indices[A.indptr[w]:A.indptr[w + 1]]
        if nb.size:
            c = communities[nb]
            out[k] = np.unique(c[c >= 0]).size
    return out


def compute_bridged(ft: "FeatureTable", communities: np.ndarray) -> np.ndarray:
    """Number of distinct communities among each wallet's neighbours (communities indexed by node index)."""
    return _bridged(ft.graph, communities, ft.wallets)


def compute_features(
    ds: Dataset,
    as_of: float,
    params: Params,
    graph: WindowGraph | None = None,
    communities: np.ndarray | None = None,
    exclude_market: int | None = None,
) -> FeatureTable:
    """Compute the five heuristic features for every wallet of the universe at as_of.

    Point in time rules (checked by tests/test_leakage.py):
      * graph and trade statistics use only records with ts < as_of
      * entry_timing / lead_time use entries whose full look-ahead horizon has elapsed (first_ts + H <= as_of)
      * hit_rate uses positions already resolved (settle_ts <= as_of) in the trailing window and can leave out
        one market (the market being scored)
    """
    pos = ds.positions
    wallets = ds.wallet_ids()
    n = wallets.size
    g = graph if graph is not None else build_window_graph(ds, as_of, params)
    H = params.move_horizon_h * HOUR
    win = params.window_days * DAY
    prior = params.prior_strength

    # --- whale overlap -------------------------------------------------------------------
    whales = whales_at(ds, as_of, params)
    wmask = np.zeros(ds.n_nodes)
    wmask[whales] = 1.0
    B = g.A.copy()
    B.data = np.ones_like(B.data)
    n_whale_all = B @ wmask
    n_cp = g.deg[wallets]
    n_whale = n_whale_all[wallets]
    whale_overlap = np.divide(n_whale, n_cp, out=np.zeros(n), where=n_cp > 0)

    # --- centrality: PageRank percentile among active wallets -------------------------------
    pr = pagerank(g.A, g.active, params.pagerank_damping)
    centrality = np.zeros(n)
    act_w = g.active[wallets]
    if act_w.any():
        centrality[act_w] = percentile_rank(pr[wallets][act_w])

    # --- positions based features ----------------------------------------------------------
    entry_timing = np.full(n, 0.5)
    hit_rate = np.full(n, 0.5)
    lead = np.zeros(n)
    n_markets = np.zeros(n, dtype=np.int64)
    n_entries = np.zeros(n, dtype=np.int64)
    n_early = np.zeros(n, dtype=np.int64)
    hit_n = np.zeros(n, dtype=np.int64)
    hit_k = np.zeros(n, dtype=np.int64)
    lookback = params.entry_lookback_days * DAY
    if pos is not None and pos.n:
        for k, w in enumerate(wallets.tolist()):
            sl = pos.of_wallet(w)
            if sl.start == sl.stop:
                continue
            ft = pos.first_ts[sl]
            # hit rate: positions resolved inside the trailing window
            st = pos.settle_ts[sl]
            rm = (st <= as_of) & (st > as_of - win) & (pos.win[sl] != 0)
            if exclude_market is not None:
                rm &= pos.market[sl] != exclude_market
            if rm.any():
                hit_n[k] = int(rm.sum())
                hit_k[k] = int((pos.win[sl][rm] > 0).sum())
                hit_rate[k] = (hit_k[k] + prior / 2.0) / (hit_n[k] + prior)
            # markets entered during the window
            em = (ft >= as_of - win) & (ft < as_of)
            if exclude_market is not None:
                em &= pos.market[sl] != exclude_market
            if em.any():
                n_markets[k] = int(np.unique(pos.market[sl][em]).size)
            # entry timing: last N entries whose look-ahead horizon fully elapsed
            el = np.nonzero((ft + H <= as_of) & (ft >= as_of - lookback))[0]
            if exclude_market is not None:
                el = el[pos.market[sl][el] != exclude_market]
            if el.size:
                el = el[-params.entry_n:]
                fav = pos.fav_ts[sl][el]
                early = np.isfinite(fav)
                n_entries[k] = el.size
                n_early[k] = int(early.sum())
                entry_timing[k] = (n_early[k] + prior / 2.0) / (el.size + prior)
                if early.any():
                    lead[k] = float(np.median((fav[early] - ft[el][early]) / 60.0))

    # --- activity statistics (cluster naming) -------------------------------------------------
    tm = (ds.t_ts >= as_of - win) & (ds.t_ts < as_of)
    tw = ds.t_wallet[tm]
    tu = ds.t_usd[tm]
    cnt = np.bincount(tw, minlength=ds.n_nodes).astype(np.float64)
    trade_rate = cnt[wallets] / params.window_days
    median_size = np.zeros(n)
    if tw.size:
        order = np.argsort(tw, kind="stable")
        tws, tus = tw[order], tu[order]
        bounds = np.searchsorted(tws, np.arange(ds.n_nodes + 1))
        for k, w in enumerate(wallets.tolist()):
            a, b = bounds[w], bounds[w + 1]
            if b > a:
                median_size[k] = float(np.median(tus[a:b]))

    active = np.nan_to_num(ds.first_seen[wallets], nan=np.inf) < as_of
    return FeatureTable(
        as_of=as_of, wallets=wallets, active=active, whale_overlap=whale_overlap, entry_timing=entry_timing,
        hit_rate=hit_rate, centrality=centrality, lead_time_min=lead, n_markets=n_markets, n_cp=n_cp,
        n_whale_cp=n_whale, n_entries=n_entries, n_early=n_early, hit_n=hit_n, hit_k=hit_k, degree=n_cp,
        bridged=_bridged(g, communities, wallets), trade_rate=trade_rate, median_size=median_size,
        pagerank=pr[wallets], graph=g,
    )
