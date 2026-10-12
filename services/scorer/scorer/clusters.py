"""Louvain communities, behaviour based cluster names, stable cluster ids and sybil flags."""

from __future__ import annotations

import numpy as np

from .config import DAY, Params
from .dataset import Dataset
from .features import FeatureTable
from .funding import funder_fanout, sybil_cluster_id, sybil_groups


def louvain_communities(ft: FeatureTable, params: Params, seed: int) -> np.ndarray:
    """Community id per scored wallet (-1 for wallets with no edge in the window). Deterministic for a given seed."""
    import community as community_louvain
    import networkx as nx

    w = ft.wallets
    A = ft.graph.A[w][:, w].tocoo()
    out = np.full(w.size, -1, dtype=np.int64)
    G = nx.Graph()
    mask = A.row < A.col
    for i, j, v in sorted(zip(A.row[mask].tolist(), A.col[mask].tolist(), np.log1p(A.data[mask]).tolist())):
        G.add_edge(i, j, weight=float(v))
    if G.number_of_nodes() == 0:
        return out
    part = community_louvain.best_partition(G, weight="weight", random_state=seed)
    for n, c in part.items():
        out[n] = c
    return out


def merge_small(comm: np.ndarray, ft: FeatureTable, min_size: int) -> np.ndarray:
    """Merge communities smaller than min_size into the neighbouring community they exchange the most weight with,
    and give wallets without any edge the largest community."""
    comm = comm.copy()
    w = ft.wallets
    A = ft.graph.A[w][:, w].tocsr()
    while True:
        ids, counts = np.unique(comm[comm >= 0], return_counts=True)
        if ids.size <= 1:
            break
        small = [int(i) for i, c in sorted(zip(ids.tolist(), counts.tolist()), key=lambda t: (t[1], t[0])) if c < min_size]
        if not small:
            break
        c = small[0]
        members = np.nonzero(comm == c)[0]
        weight_to: dict[int, float] = {}
        for m in members.tolist():
            for j, v in zip(A.indices[A.indptr[m]:A.indptr[m + 1]].tolist(), A.data[A.indptr[m]:A.indptr[m + 1]].tolist()):
                cj = int(comm[j])
                if cj >= 0 and cj != c:
                    weight_to[cj] = weight_to.get(cj, 0.0) + v
        if weight_to:
            target = sorted(weight_to.items(), key=lambda t: (-t[1], t[0]))[0][0]
        else:
            others = [(int(cnt), int(i)) for i, cnt in zip(ids.tolist(), counts.tolist()) if i != c]
            target = sorted(others, key=lambda t: (-t[0], t[1]))[0][1]
        comm[members] = target
    ids, counts = np.unique(comm[comm >= 0], return_counts=True)
    if ids.size and (comm < 0).any():
        biggest = int(ids[np.lexsort((ids, -counts))[0]])
        comm[comm < 0] = biggest
    elif ids.size == 0:
        comm[:] = 0
    return comm


# name -> weights over standardised community statistics
PROTOTYPES: dict[str, dict[str, float]] = {
    "Early LP cohort": {"entry_timing": 1.0, "lead": 1.0, "age": 0.7, "trade_rate": -0.6, "size": 0.3},
    "Momentum desks": {"trade_rate": 1.0, "entry_timing": 0.6, "hit_rate": 0.5, "size": -0.2},
    "MEV searchers": {"trade_rate": 1.2, "lead": -0.9, "size": -0.6, "entry_timing": 0.3},
    "Treasury rotators": {"whale": 1.2, "size": 1.0, "trade_rate": -0.8, "centrality": 0.4},
    "Retail flow": {"entry_timing": -0.5, "whale": -0.5, "size": -0.3, "_bias": 0.5},
    "Airdrop farmers": {"same_funder": 1.5, "size": -0.8, "entry_timing": -0.3, "trade_rate": 0.3},
}
_STATS = ("entry_timing", "lead", "age", "trade_rate", "size", "hit_rate", "whale", "centrality", "same_funder")
_ORDINALS = ["", " II", " III", " IV", " V", " VI", " VII", " VIII", " IX", " X"]


def community_stats(ds: Dataset, ft: FeatureTable, comm: np.ndarray, params: Params) -> tuple[dict[int, dict[str, float]], dict[str, tuple[float, float]]]:
    """Behaviour statistics per community and the (mean, std) of every statistic over active wallets."""
    w = ft.wallets
    fan = funder_fanout(ds)
    age = np.where(np.isnan(ds.first_seen[w]), 0.0, (ft.as_of - np.nan_to_num(ds.first_seen[w], nan=ft.as_of)) / DAY)
    cols = {
        "entry_timing": ft.entry_timing,
        "lead": np.minimum(ft.lead_time_min, params.lead_cap_min),
        "age": age,
        "trade_rate": np.log1p(ft.trade_rate),
        "size": np.log1p(ft.median_size),
        "hit_rate": ft.hit_rate,
        "whale": ft.whale_overlap,
        "centrality": ft.centrality,
    }
    # share of members whose (non hub) funder is shared with another member of the same community
    same = np.zeros(w.size)
    for c in np.unique(comm):
        idx = np.nonzero(comm == c)[0]
        keys = [ds.funding[int(w[i])] for i in idx.tolist()]
        cnt: dict[str, int] = {}
        for k in keys:
            if k is not None and fan.get(k, 0) <= params.sybil_max_fanout:
                cnt[k] = cnt.get(k, 0) + 1
        for i, k in zip(idx.tolist(), keys):
            same[i] = 1.0 if (k is not None and cnt.get(k, 0) >= 2) else 0.0
    cols["same_funder"] = same
    act = ft.active
    uni = {k: (float(v[act].mean()), float(v[act].std() + 1e-9)) for k, v in cols.items()} if act.any() else {k: (0.0, 1.0) for k in cols}
    out: dict[int, dict[str, float]] = {}
    for c in np.unique(comm):
        idx = np.nonzero((comm == c) & act)[0]
        if idx.size == 0:
            idx = np.nonzero(comm == c)[0]
        out[int(c)] = {k: float(v[idx].mean()) for k, v in cols.items()}
    return out, uni


def name_communities(stats: dict[int, dict[str, float]], uni: dict[str, tuple[float, float]], sizes: dict[int, int]) -> dict[int, str]:
    """Pick the prototype with the highest score for every community. Duplicate names get an ordinal suffix."""
    raw: dict[int, str] = {}
    for c in sorted(stats):
        z = {k: (stats[c][k] - uni[k][0]) / uni[k][1] for k in _STATS}
        best, best_s = None, -1e18
        for name in PROTOTYPES:
            s = sum(wt * (1.0 if k == "_bias" else z[k]) for k, wt in PROTOTYPES[name].items())
            if s > best_s + 1e-12:
                best, best_s = name, s
        raw[c] = best
    out: dict[int, str] = {}
    by_name: dict[str, list[int]] = {}
    for c, n in raw.items():
        by_name.setdefault(n, []).append(c)
    for n, cs in by_name.items():
        cs = sorted(cs, key=lambda c: (-sizes.get(c, 0), c))
        for k, c in enumerate(cs):
            out[c] = n + (_ORDINALS[k] if k < len(_ORDINALS) else f" {k + 1}")
    return out


def stabilize_ids(members: dict[int, list[str]], prev: dict[str, int]) -> dict[int, int]:
    """Map raw community labels to cluster ids, reusing the previous run's id for the community that overlaps it most
    (Jaccard >= 0.3, greedy by overlap). New communities get fresh ids above everything seen before."""
    pairs = []
    prev_members: dict[int, set[str]] = {}
    for a, cid in prev.items():
        prev_members.setdefault(cid, set()).add(a)
    for raw_c, ms in members.items():
        s = set(ms)
        for pid, pm in prev_members.items():
            inter = len(s & pm)
            if inter:
                pairs.append((inter / len(s | pm), raw_c, pid))
    pairs.sort(key=lambda t: (-t[0], t[1], t[2]))
    out: dict[int, int] = {}
    used: set[int] = set()
    for j, raw_c, pid in pairs:
        if j < 0.3 or raw_c in out or pid in used:
            continue
        out[raw_c] = pid
        used.add(pid)
    nxt = max([0] + list(prev_members) + list(out.values())) + 1
    for raw_c in sorted(members, key=lambda c: (-len(members[c]), min(members[c]))):
        if raw_c not in out:
            while nxt in used:
                nxt += 1
            out[raw_c] = nxt
            used.add(nxt)
            nxt += 1
    return out


def sybil_assignments(ds: Dataset, ft: FeatureTable, smart: np.ndarray, params: Params) -> dict[int, int]:
    """{wallet position in ft.wallets: sybil_cluster_id} for flagged wallets that share a funding source."""
    flagged_nodes = ft.wallets[smart]
    groups = sybil_groups(ds, flagged_nodes, params)
    pos_of = {int(n): i for i, n in enumerate(ft.wallets.tolist())}
    return {pos_of[w]: sybil_cluster_id(k) for w, k in groups.items()}
