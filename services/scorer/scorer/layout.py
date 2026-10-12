"""Server side 3D layout so every client renders the same graph.

Cluster centres sit on a Fibonacci sphere (same construction as the design). Inside a cluster a Fruchterman-Reingold
force layout arranges the wallets. Initial positions are derived from a hash of the wallet address, so positions are
stable between runs and the whole layout is deterministic. All coordinates end up inside [-1.6, 1.6].
"""

from __future__ import annotations

import zlib

import numpy as np
import scipy.sparse as sp

LIMIT = 1.6


def fibonacci_centers(k: int) -> np.ndarray:
    c = np.zeros((max(k, 1), 3))
    for i in range(max(k, 1)):
        y = 1 - (i + 0.5) / max(k, 1) * 2
        rad = np.sqrt(max(0.0, 1 - y * y))
        th = i * 2.399963
        c[i] = [np.cos(th) * rad * 1.15, y * 0.85, np.sin(th) * rad * 1.15]
    return c


def _seeded_offsets(addresses: list[str]) -> np.ndarray:
    out = np.zeros((len(addresses), 3))
    for i, a in enumerate(addresses):
        r = np.random.default_rng(zlib.crc32(a.encode()))
        out[i] = r.standard_normal(3)
    return out


def cluster_radius(n: int) -> float:
    return float(min(0.9, 0.22 + 0.13 * n ** (1.0 / 3.0)))


def _fr(pos: np.ndarray, A: sp.csr_matrix, k: float, iters: int, center: np.ndarray, gravity: np.ndarray) -> np.ndarray:
    n = pos.shape[0]
    if n <= 1:
        return pos
    Ad = A.toarray() if n <= 1500 else None
    t0 = 0.12
    for it in range(iters):
        t = t0 * (1.0 - it / iters) + 1e-3
        delta = pos[:, None, :] - pos[None, :, :]
        dist = np.sqrt((delta ** 2).sum(-1)) + 1e-9
        rep = (k * k / dist ** 2)[:, :, None] * delta
        np.fill_diagonal(rep[:, :, 0], 0.0)
        np.fill_diagonal(rep[:, :, 1], 0.0)
        np.fill_diagonal(rep[:, :, 2], 0.0)
        force = rep.sum(axis=1)
        if Ad is not None:
            att = -(Ad * dist / k)[:, :, None] * delta / dist[:, :, None]
            force += att.sum(axis=1)
        force += -gravity[:, None] * (pos - center)
        norm = np.sqrt((force ** 2).sum(-1)) + 1e-9
        pos = pos + force / norm[:, None] * np.minimum(norm, t)[:, None]
    return pos


def layout_wallets(addresses: list[str], cluster_ids: np.ndarray, smart: np.ndarray, A: sp.csr_matrix, iters: int = 60) -> np.ndarray:
    """Positions (n x 3) for wallets. cluster_ids are arbitrary ints, ordered ascending when placed on the sphere."""
    n = len(addresses)
    out = np.zeros((n, 3))
    if n == 0:
        return out
    uniq = np.unique(cluster_ids)
    centers = fibonacci_centers(uniq.size)
    offs = _seeded_offsets(addresses)
    for ci, c in enumerate(uniq.tolist()):
        idx = np.nonzero(cluster_ids == c)[0]
        R = cluster_radius(idx.size)
        init = centers[ci] + offs[idx] * (R / 2.5)
        sub = A[idx][:, idx].tocsr()
        if sub.nnz:
            sub = sub.copy()
            sub.data = np.log1p(sub.data)
            sub.data = sub.data / (sub.data.max() + 1e-9)
        k = R / max(idx.size ** (1.0 / 3.0), 1.0)
        gravity = np.where(smart[idx], 1.6, 0.8)
        pos = _fr(init, sub, k, iters, centers[ci], gravity)
        rel = pos - centers[ci]
        # fit inside the cluster radius; smart wallets sit closer to the core (design: x0.82)
        rmax = np.sqrt((rel ** 2).sum(-1)).max()
        if rmax > R:
            rel = rel * (R / rmax)
        rel[smart[idx]] *= 0.82
        out[idx] = centers[ci] + rel
    m = np.abs(out).max()
    if m > LIMIT:
        out = out * (LIMIT / m)
    return out
