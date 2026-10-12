"""Funding relationships: fan-out, funding groups for cross validation and sybil cluster detection."""

from __future__ import annotations

import zlib

import numpy as np

from .config import Params
from .dataset import Dataset


def funder_fanout(ds: Dataset) -> dict[str, int]:
    """Number of universe wallets each funder funds directly (hubs such as exchanges have a very large fan-out)."""
    out: dict[str, int] = {}
    for w in ds.wallet_ids().tolist():
        f = ds.funding[w]
        if f is not None:
            out[f] = out.get(f, 0) + 1
    return out


def ancestors(ds: Dataset, w: int, hops: int) -> list[str]:
    """Funding chain of wallet w, nearest first, at most `hops` entries."""
    chain: list[str] = []
    cur = w
    for _ in range(hops):
        f = ds.funding[cur]
        if f is None or f in chain:
            break
        chain.append(f)
        nxt = ds.index.get(f)
        if nxt is None:
            break
        cur = nxt
    return chain


def funding_groups(ds: Dataset, wallets: np.ndarray, params: Params) -> np.ndarray:
    """Group id per wallet for group k-fold: wallets sharing a NON-hub funder share a group, everyone else is alone."""
    fan = funder_fanout(ds)
    gid: dict[str, int] = {}
    out = np.zeros(wallets.size, dtype=np.int64)
    for k, w in enumerate(wallets.tolist()):
        f = ds.funding[w]
        key = f"f:{f}" if (f is not None and fan.get(f, 0) <= params.sybil_max_fanout) else f"w:{ds.nodes[w]}"
        out[k] = gid.setdefault(key, len(gid))
    return out


def sybil_groups(ds: Dataset, flagged: np.ndarray, params: Params, fan: dict[str, int] | None = None) -> dict[int, str]:
    """Sybil clusters: >= sybil_min_wallets flagged wallets funded by the same source within sybil_hops hops.

    For every non-hub address (fan-out at most sybil_max_fanout) we collect the flagged wallets whose funding chain
    (up to `hops` ancestors) contains it. An address with enough flagged wallets defines a sybil cluster. A wallet that
    qualifies through several addresses joins the one with the most flagged members (ties: smallest address).
    Returns {wallet node index: key}, the key being the funder address that defines the cluster.
    """
    fan = fan if fan is not None else funder_fanout(ds)
    by_src: dict[str, list[int]] = {}
    for w in sorted(int(x) for x in flagged.tolist()):
        for a in ancestors(ds, w, params.sybil_hops):
            if fan.get(a, 0) <= params.sybil_max_fanout:
                by_src.setdefault(a, []).append(w)
    qualified = {a: ws for a, ws in by_src.items() if len(ws) >= params.sybil_min_wallets}
    out: dict[int, str] = {}
    best: dict[int, tuple[int, str]] = {}
    for a in sorted(qualified):
        for w in qualified[a]:
            cand = (-len(qualified[a]), a)
            if w not in best or cand < best[w]:
                best[w] = cand
    for w, (_, a) in best.items():
        out[w] = a
    return out


def sybil_cluster_id(key: str) -> int:
    """Stable positive 31 bit id derived from the root funder address."""
    return int(zlib.crc32(key.encode())) & 0x7FFFFFFF
