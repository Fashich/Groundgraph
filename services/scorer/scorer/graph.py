"""Trailing window wallet graph with time decayed USD edge weights."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import scipy.sparse as sp

from .config import DAY, Params
from .dataset import Dataset


@dataclass
class WindowGraph:
    as_of: float
    n: int
    A: sp.csr_matrix  # symmetric, decayed USD weights
    deg: np.ndarray  # distinct neighbours
    wdeg: np.ndarray  # sum of weights
    active: np.ndarray  # has at least one edge in the window


def build_window_graph(ds: Dataset, as_of: float, params: Params) -> WindowGraph:
    """Edges with ts in [as_of - window, as_of). Weight = USD * 0.5 ** (age / half_life). Strictly point in time."""
    lo = np.searchsorted(ds.e_ts, as_of - params.window_days * DAY, side="left")
    hi = np.searchsorted(ds.e_ts, as_of, side="left")
    src, dst = ds.e_src[lo:hi], ds.e_dst[lo:hi]
    keep = src != dst
    src, dst = src[keep], dst[keep]
    age = as_of - ds.e_ts[lo:hi][keep]
    w = ds.e_usd[lo:hi][keep] * np.power(0.5, age / (params.half_life_days * DAY))
    n = ds.n_nodes
    if src.size:
        m = sp.coo_matrix((w, (src, dst)), shape=(n, n)).tocsr()
        A = (m + m.T).tocsr()
        A.sum_duplicates()
    else:
        A = sp.csr_matrix((n, n))
    deg = np.diff(A.indptr).astype(np.float64)
    wdeg = np.asarray(A.sum(axis=1)).ravel()
    return WindowGraph(as_of, n, A, deg, wdeg, deg > 0)


def pagerank(A: sp.csr_matrix, active: np.ndarray, damping: float = 0.85, tol: float = 1e-10, max_iter: int = 200) -> np.ndarray:
    """Weighted PageRank by power iteration on the active nodes; inactive nodes get 0."""
    n = A.shape[0]
    idx = np.nonzero(active)[0]
    out = np.zeros(n)
    m = idx.size
    if m == 0:
        return out
    sub = A[idx][:, idx].tocsr()
    rs = np.asarray(sub.sum(axis=1)).ravel()
    inv = np.divide(1.0, rs, out=np.zeros_like(rs), where=rs > 0)
    P = sp.diags(inv) @ sub  # row stochastic
    r = np.full(m, 1.0 / m)
    dangling = rs <= 0
    for _ in range(max_iter):
        nr = damping * (P.T @ r + r[dangling].sum() / m) + (1.0 - damping) / m
        if np.abs(nr - r).sum() < tol:
            r = nr
            break
        r = nr
    out[idx] = r / r.sum()
    return out


def percentile_rank(values: np.ndarray) -> np.ndarray:
    """Mid-rank percentile in (0, 1): (#smaller + 0.5 * #equal) / n. Ties get the same value."""
    v = np.asarray(values, dtype=np.float64)
    n = v.size
    if n == 0:
        return v.copy()
    s = np.sort(v)
    lo = np.searchsorted(s, v, side="left")
    hi = np.searchsorted(s, v, side="right")
    return (lo + 0.5 * (hi - lo)) / n


def whales_at(ds: Dataset, as_of: float, params: Params) -> np.ndarray:
    """Node indices of the top 1% (at least min_whales) by latest balance snapshot at or before as_of."""
    m = ds.b_ts <= as_of
    if not np.any(m):
        return np.zeros(0, dtype=np.int64)
    node, ts, usd = ds.b_node[m], ds.b_ts[m], ds.b_usd[m]
    # latest snapshot per node (arrays are sorted by ts, so the last occurrence wins)
    latest = {}
    for n_, u in zip(node.tolist(), usd.tolist()):
        latest[n_] = u
    ids = np.array(sorted(latest), dtype=np.int64)
    bal = np.array([latest[i] for i in ids.tolist()])
    k = max(params.min_whales, int(np.ceil(params.whale_frac * ids.size)))
    k = min(k, ids.size)
    order = np.lexsort((ids, -bal))  # balance desc, node index asc for determinism
    return np.sort(ids[order[:k]])
