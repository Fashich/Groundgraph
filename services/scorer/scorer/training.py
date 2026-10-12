"""Model training (temporal split, grouped cross validation), serialisation and batch inference."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field

import numpy as np
from sklearn.metrics import average_precision_score, roc_auc_score

from .config import Params
from .dataset import Dataset
from .funding import funding_groups
from .head import Head, default_head, fit_head
from .model import (
    GraphSAGE,
    Snapshot,
    build_snapshot,
    cross_val_oof,
    predict_sage,
    snapshot_percentiles,
    state_from_json,
    state_to_json,
    to_batch,
    train_sage,
)
from .splits import Split, make_split
from .timeutil import iso


@dataclass
class ModelBundle:
    version: str
    trained_at: float
    source_label: str
    sage_json: dict | None
    head: Head
    params: dict
    split: dict
    metrics: dict
    _sage: GraphSAGE | None = field(default=None, repr=False)

    def sage(self) -> GraphSAGE | None:
        if self.sage_json is None:
            return None
        if self._sage is None:
            self._sage = state_from_json(self.sage_json)
        return self._sage

    def to_json(self) -> dict:
        return {
            "version": self.version, "trained_at": self.trained_at, "source_label": self.source_label,
            "sage": self.sage_json, "head": self.head.to_json(), "params": self.params, "split": self.split,
            "metrics": self.metrics,
        }

    @classmethod
    def from_json(cls, d: dict) -> "ModelBundle":
        return cls(d["version"], float(d["trained_at"]), d["source_label"], d.get("sage"), Head.from_json(d["head"]),
                   d.get("params", {}), d.get("split", {}), d.get("metrics", {}))


def cold_start_bundle(source_label: str, now: float) -> ModelBundle:
    """Heuristic only bundle (design weights) used until a model has been trained."""
    return ModelBundle("heuristic-v0", now, source_label, None, default_head(), {}, {}, {})


def _version(sage_json: dict | None, head: Head, trained_at: float) -> str:
    h = hashlib.sha256(json.dumps({"s": sage_json, "h": head.to_json()}, sort_keys=True).encode()).hexdigest()[:8]
    day = iso(trained_at)[:10].replace("-", "")
    return f"gg-sage-{day}-{h}"


# --------------------------------------------------------------------------- inference
@dataclass
class Scored:
    wallets: np.ndarray
    score: np.ndarray  # int 0..100
    points: np.ndarray  # n x 5 int, rows sum to score
    smart: np.ndarray
    top: np.ndarray
    g: np.ndarray  # graph model percentile 0..1
    gnn_points: np.ndarray  # real valued points that come from the graph model term
    logit: np.ndarray


def score_snapshot(bundle: ModelBundle, snap: Snapshot, params: Params) -> Scored:
    ft = snap.ft
    n = ft.wallets.size
    model = bundle.sage()
    if model is None:
        g = np.zeros(n)
        logit = np.zeros(n)
    else:
        b = to_batch([snap])
        logit = predict_sage(model, b)
        g = snapshot_percentiles(logit, b.snap, b.active)
    head = bundle.head
    score, points = head.score(snap.H, g)
    gate = (ft.n_entries >= params.min_flag_entries) & (ft.hit_n >= params.min_flag_resolved) & ft.active
    smart = (score >= head.smart_threshold) & gate
    top = smart & (score >= head.top_threshold)
    return Scored(ft.wallets, score, points, smart, top, g, head.scale * head.w_gnn * Head.g_in(g), logit)


# --------------------------------------------------------------------------- metrics
def _auc(y: np.ndarray, s: np.ndarray) -> float | None:
    if len(np.unique(y)) < 2:
        return None
    return float(roc_auc_score(y, s))


def _ap(y: np.ndarray, s: np.ndarray) -> float | None:
    if len(np.unique(y)) < 2:
        return None
    return float(average_precision_score(y, s))


def grouped_bootstrap_auc(y: np.ndarray, s: np.ndarray, groups: np.ndarray, seed: int, n_boot: int = 200) -> list[float] | None:
    """95% interval of the AUC resampling whole funding groups (samples of one wallet are strongly correlated)."""
    ug = np.unique(groups)
    if ug.size < 5 or len(np.unique(y)) < 2:
        return None
    rng = np.random.default_rng(seed)
    idx_by = {g: np.nonzero(groups == g)[0] for g in ug}
    vals = []
    for _ in range(n_boot):
        pick = rng.choice(ug, size=ug.size, replace=True)
        idx = np.concatenate([idx_by[g] for g in pick])
        if len(np.unique(y[idx])) < 2:
            continue
        vals.append(roc_auc_score(y[idx], s[idx]))
    if len(vals) < 20:
        return None
    return [float(np.quantile(vals, 0.025)), float(np.quantile(vals, 0.975))]


# --------------------------------------------------------------------------- training
@dataclass
class TrainResult:
    bundle: ModelBundle
    split: Split
    test_snaps: dict  # cutoff -> Snapshot (every eval_stride-th test cutoff, with labels)


def train_model(ds: Dataset, params: Params, source_label: str, now: float, eval_stride: int = 7) -> TrainResult:
    """Train GraphSAGE + head on the train period and evaluate on the held out test period (after the embargo)."""
    split = make_split(ds.start_ts, ds.end_ts, params)
    wallets = ds.wallet_ids()
    groups = funding_groups(ds, wallets, params)

    train_snaps = [build_snapshot(ds, c, params, True, groups) for c in split.train_cutoffs]
    batch = to_batch(train_snaps)
    labeled = np.isfinite(batch.y) & batch.active
    pos = int((batch.y[labeled] > 0.5).sum()) if labeled.any() else 0
    seed = params.seed

    metrics: dict = {
        "n_train_snapshots": len(train_snaps),
        "n_train_labeled": int(labeled.sum()),
        "n_train_positive": pos,
        "train_base_rate": float(pos / max(1, labeled.sum())),
    }

    sage_json = None
    oof_g = np.zeros(batch.y.size)
    if labeled.sum() >= 50 and 0 < pos < labeled.sum():
        oof_logit, fold = cross_val_oof(batch, params, seed)
        oof_g = snapshot_percentiles(oof_logit, batch.snap, batch.active)
        metrics["cv_auc_graph_model"] = _auc(batch.y[labeled], oof_logit[labeled])
        final = train_sage(batch, labeled, params, seed)
        sage_json = state_to_json(final)
        metrics["cv_folds"] = int(fold.max()) + 1
    head = fit_head(batch.H, oof_g, batch.y, batch.active, params, use_gnn=sage_json is not None)
    head_h = fit_head(batch.H, np.zeros_like(oof_g), batch.y, batch.active, params, use_gnn=False)
    sc_train, _ = head.score(batch.H, oof_g)
    metrics["cv_auc_head"] = _auc(batch.y[labeled], sc_train[labeled]) if labeled.any() else None

    bundle = ModelBundle("tmp", now, source_label, sage_json, head, params.to_dict(), split.describe(), metrics)
    bundle.version = _version(sage_json, head, now)

    # ---- held out evaluation: test cutoffs, features from the past only, labels from the following window
    test_cut = list(split.test_cutoffs)[:: max(1, eval_stride)]
    test_snaps = {c: build_snapshot(ds, c, params, True, groups) for c in test_cut}
    ys, s_head, s_heur, s_gnn, s_hit, s_et, gs = [], [], [], [], [], [], []
    for c, snap in test_snaps.items():
        sc = score_snapshot(bundle, snap, params)
        sc_h, _ = head_h.score(snap.H, np.zeros(snap.H.shape[0]))
        m = np.isfinite(snap.y) & snap.ft.active
        ys.append(snap.y[m])
        s_head.append(sc.score[m])
        s_heur.append(sc_h[m])
        s_gnn.append(sc.logit[m])
        s_hit.append(snap.ft.hit_rate[m])
        s_et.append(snap.ft.entry_timing[m])
        gs.append(snap.groups[m])
    if ys:
        y = np.concatenate(ys)
        res = {
            "n_test_snapshots": len(test_snaps), "n_test_labeled": int(y.size), "n_test_positive": int((y > 0.5).sum()),
            "test_base_rate": float((y > 0.5).mean()) if y.size else None,
        }
        sh, shh, sg = np.concatenate(s_head), np.concatenate(s_heur), np.concatenate(s_gnn)
        res.update({
            "test_auc": _auc(y, sh), "test_pr_auc": _ap(y, sh),
            "test_auc_heuristic_only": _auc(y, shh), "test_pr_auc_heuristic_only": _ap(y, shh),
            "test_auc_graph_model_only": _auc(y, sg), "test_pr_auc_graph_model_only": _ap(y, sg),
            "test_auc_hit_rate_only": _auc(y, np.concatenate(s_hit)), "test_auc_entry_timing_only": _auc(y, np.concatenate(s_et)),
            "test_auc_ci95": grouped_bootstrap_auc(y, sh, np.concatenate(gs), seed),
        })
        metrics.update(res)
    return TrainResult(bundle, split, test_snaps)
