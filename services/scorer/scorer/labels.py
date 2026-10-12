"""Smart money proxy labels, computed ONLY from the window after the feature cutoff."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .config import DAY, Params
from .dataset import Dataset


@dataclass
class Labels:
    cutoff: float
    wallets: np.ndarray
    y: np.ndarray  # 1.0 / 0.0 / nan (not enough activity to label)
    pnl: np.ndarray
    early_rate: np.ndarray
    n_events: np.ndarray
    pnl_threshold: float


def compute_labels(ds: Dataset, cutoff: float, params: Params) -> Labels:
    """Label = realised PnL in the top decile AND early-entry rate >= 0.5 over positions opened in
    (cutoff, cutoff + label_days] that are already resolved in the dataset.

    Wallets with fewer than label_min_events such positions are unlabeled (nan), never counted as negatives.
    """
    pos = ds.positions
    wallets = ds.wallet_ids()
    n = wallets.size
    y = np.full(n, np.nan)
    pnl = np.zeros(n)
    early = np.zeros(n)
    nev = np.zeros(n, dtype=np.int64)
    if pos is None or pos.n == 0:
        return Labels(cutoff, wallets, y, pnl, early, nev, float("nan"))
    end = cutoff + params.label_days * DAY
    m = (pos.first_ts > cutoff) & (pos.first_ts <= end) & (pos.win != 0)
    if not m.any():
        return Labels(cutoff, wallets, y, pnl, early, nev, float("nan"))
    pw = pos.wallet[m]
    nn = ds.n_nodes
    cnt = np.bincount(pw, minlength=nn)
    sp_ = np.bincount(pw, weights=pos.pnl[m], minlength=nn)
    se = np.bincount(pw, weights=np.isfinite(pos.fav_ts[m]).astype(float), minlength=nn)
    nev = cnt[wallets]
    pnl = sp_[wallets]
    early = np.divide(se[wallets], cnt[wallets], out=np.zeros(n), where=cnt[wallets] > 0)
    ok = nev >= params.label_min_events
    thr = float("nan")
    if ok.sum() >= 5:
        thr = float(np.quantile(pnl[ok], params.label_pnl_quantile))
        pos_lab = ok & (pnl >= thr) & (pnl > 0) & (early >= params.label_early_min)
        y[ok] = 0.0
        y[pos_lab] = 1.0
    return Labels(cutoff, wallets, y, pnl, early, nev, thr)
