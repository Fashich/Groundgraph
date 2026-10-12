"""Snapshots, a hand written 2-layer GraphSAGE (mean aggregator) and grouped cross validation.

No PyTorch Geometric: the mean aggregator is a row normalised sparse adjacency times the feature matrix, which is
plain torch.sparse.mm. See DECISIONS.md (ADR-001).
"""

from __future__ import annotations

import base64
from dataclasses import dataclass

import numpy as np
import scipy.sparse as sp
import torch
import torch.nn as nn
import torch.nn.functional as F

from .config import Params
from .dataset import Dataset
from .features import FeatureTable, compute_features
from .funding import funding_groups
from .graph import percentile_rank
from .labels import compute_labels
from .splits import group_kfold

WHALE_SCALE = 0.25  # whale_overlap of 0.25 or more saturates the head input (a quarter of all counterparties are whales)
GNN_IN_DIM = 7
HEAD_KEYS = ("whale_overlap", "entry_timing", "hit_rate", "centrality", "lead_time")


def raw_inputs(ft: FeatureTable, params: Params) -> np.ndarray:
    """The five features scaled to [0, 1], in HEAD_KEYS order (whale overlap and lead time are saturated)."""
    x = np.stack(
        [
            np.minimum(1.0, ft.whale_overlap / WHALE_SCALE),
            ft.entry_timing,
            ft.hit_rate,
            ft.centrality,
            np.minimum(1.0, ft.lead_time_min / params.lead_cap_min),
        ],
        axis=1,
    )
    x = np.clip(x, 0.0, 1.0)
    x[~ft.active] = 0.0
    return x


def head_inputs(ft: FeatureTable, params: Params) -> np.ndarray:
    """Inputs of the explainable head: each feature measured ABOVE a cross sectional baseline of active wallets.

    x = clip((raw - b) / (1 - b), 0, 1) with b the head_baseline_q quantile (default 70th percentile) of the feature over
    active wallets. A wallet at or below the baseline earns 0 points for that feature, so chance level behaviour is not
    rewarded (a 50% hit rate or the market wide share of early entries adds nothing). The baseline is computed from the
    same snapshot (data before as_of only).
    """
    raw = raw_inputs(ft, params)
    act = ft.active
    base = np.quantile(raw[act], params.head_baseline_q, axis=0) if act.sum() >= 5 else np.zeros(raw.shape[1])
    x = np.clip((raw - base) / np.maximum(1.0 - base, 1e-6), 0.0, 1.0)
    x[~act] = 0.0
    return x


def gnn_inputs(ft: FeatureTable, params: Params) -> np.ndarray:
    """Heuristic features (absolute values) plus degree (log scaled) plus an activity flag."""
    x5 = raw_inputs(ft, params)
    deg = np.minimum(1.0, np.log1p(ft.degree) / np.log(101.0))
    out = np.concatenate([x5, deg[:, None], ft.active.astype(np.float64)[:, None]], axis=1)
    out[~ft.active] = 0.0
    return out


def normalized_wallet_adjacency(ft: FeatureTable) -> sp.csr_matrix:
    """Mean aggregator matrix over the scored wallets only: row normalised, log damped USD weights."""
    w = ft.wallets
    A = ft.graph.A[w][:, w].tocsr().astype(np.float64)
    A.data = np.log1p(A.data)
    rs = np.asarray(A.sum(axis=1)).ravel()
    inv = np.divide(1.0, rs, out=np.zeros_like(rs), where=rs > 0)
    return (sp.diags(inv) @ A).tocsr()


@dataclass
class Snapshot:
    cutoff: float
    ft: FeatureTable
    X: np.ndarray  # GNN inputs
    H: np.ndarray  # head inputs
    A: sp.csr_matrix
    y: np.ndarray  # labels, nan when unknown (or not requested)
    groups: np.ndarray


def build_snapshot(ds: Dataset, cutoff: float, params: Params, with_labels: bool, groups: np.ndarray | None = None) -> Snapshot:
    ft = compute_features(ds, cutoff, params)
    wallets = ft.wallets
    if groups is None:
        groups = funding_groups(ds, wallets, params)
    if with_labels:
        y = compute_labels(ds, cutoff, params).y.copy()
        y[~ft.active] = np.nan
    else:
        y = np.full(wallets.size, np.nan)
    return Snapshot(cutoff, ft, gnn_inputs(ft, params), head_inputs(ft, params), normalized_wallet_adjacency(ft), y, groups)


# --------------------------------------------------------------------------- batching
@dataclass
class Batch:
    X: torch.Tensor
    A: torch.Tensor  # sparse COO
    y: np.ndarray
    snap: np.ndarray  # snapshot index per node
    groups: np.ndarray
    active: np.ndarray
    H: np.ndarray


def to_batch(snaps: list[Snapshot]) -> Batch:
    X = np.vstack([s.X for s in snaps]).astype(np.float32)
    A = sp.block_diag([s.A for s in snaps], format="coo").astype(np.float32)
    idx = torch.tensor(np.vstack([A.row, A.col]), dtype=torch.long)
    At = torch.sparse_coo_tensor(idx, torch.tensor(A.data), size=A.shape, check_invariants=False).coalesce()
    return Batch(
        X=torch.tensor(X),
        A=At,
        y=np.concatenate([s.y for s in snaps]),
        snap=np.concatenate([np.full(s.y.size, i) for i, s in enumerate(snaps)]),
        groups=np.concatenate([s.groups for s in snaps]),
        active=np.concatenate([s.ft.active for s in snaps]),
        H=np.vstack([s.H for s in snaps]),
    )


# --------------------------------------------------------------------------- model
class GraphSAGE(nn.Module):
    """h1 = relu(W1s x + W1n mean_N(x)); h2 = relu(W2s h1 + W2n mean_N(h1)); logit = w h2 + b."""

    def __init__(self, in_dim: int = GNN_IN_DIM, hidden: int = 64, dropout: float = 0.2):
        super().__init__()
        self.l1s = nn.Linear(in_dim, hidden)
        self.l1n = nn.Linear(in_dim, hidden, bias=False)
        self.l2s = nn.Linear(hidden, hidden)
        self.l2n = nn.Linear(hidden, hidden, bias=False)
        self.out = nn.Linear(hidden, 1)
        self.dropout = dropout
        self.in_dim, self.hidden = in_dim, hidden

    def forward(self, x: torch.Tensor, A: torch.Tensor) -> torch.Tensor:
        h = F.relu(self.l1s(x) + self.l1n(torch.sparse.mm(A, x)))
        h = F.dropout(h, self.dropout, self.training)
        h = F.relu(self.l2s(h) + self.l2n(torch.sparse.mm(A, h)))
        h = F.dropout(h, self.dropout, self.training)
        return self.out(h).squeeze(-1)


def _seed_all(seed: int) -> None:
    torch.manual_seed(seed)
    np.random.seed(seed % (2**32))
    torch.set_num_threads(1)
    try:
        torch.use_deterministic_algorithms(True, warn_only=True)
    except Exception:  # pragma: no cover
        pass


def train_sage(batch: Batch, train_mask: np.ndarray, params: Params, seed: int) -> GraphSAGE:
    """Full batch training with a masked, class weighted binary cross entropy."""
    _seed_all(seed)
    model = GraphSAGE(batch.X.shape[1], params.sage_hidden, params.sage_dropout)
    m = train_mask & np.isfinite(batch.y)
    if m.sum() == 0 or len(np.unique(batch.y[m])) < 2:
        return model  # nothing to learn from, keep the (seeded) initialisation
    y = torch.tensor(np.nan_to_num(batch.y), dtype=torch.float32)
    mt = torch.tensor(m)
    pos = float(batch.y[m].sum())
    neg = float(m.sum()) - pos
    pw = torch.tensor(float(np.clip(neg / max(pos, 1.0), 1.0, 8.0)))
    opt = torch.optim.Adam(model.parameters(), lr=params.sage_lr, weight_decay=params.sage_weight_decay)
    model.train()
    for _ in range(params.sage_epochs):
        opt.zero_grad()
        logit = model(batch.X, batch.A)
        loss = F.binary_cross_entropy_with_logits(logit[mt], y[mt], pos_weight=pw)
        loss.backward()
        opt.step()
    model.eval()
    return model


@torch.no_grad()
def predict_sage(model: GraphSAGE, batch: Batch) -> np.ndarray:
    model.eval()
    return model(batch.X, batch.A).numpy().astype(np.float64)


def snapshot_percentiles(values: np.ndarray, snap: np.ndarray, active: np.ndarray) -> np.ndarray:
    """Cross sectional percentile of `values` among the active wallets of each snapshot (inactive wallets get 0)."""
    out = np.zeros(values.size)
    for s in np.unique(snap):
        idx = np.nonzero((snap == s) & active)[0]
        if idx.size:
            out[idx] = percentile_rank(values[idx])
    return out


def cross_val_oof(batch: Batch, params: Params, seed: int) -> tuple[np.ndarray, np.ndarray]:
    """Out of fold GNN logits with group k-fold by funding cluster.

    Returns (oof logits for every node, fold id per node). A wallet's labels never train the model that scores it.
    """
    fold = group_kfold(batch.groups, params.cv_folds)
    oof = np.zeros(batch.y.size)
    for f in range(int(fold.max()) + 1):
        model = train_sage(batch, fold != f, params, seed + 1 + f)
        pred = predict_sage(model, batch)
        oof[fold == f] = pred[fold == f]
    return oof, fold


# --------------------------------------------------------------------------- serialisation
def state_to_json(model: GraphSAGE) -> dict:
    out = {"in_dim": model.in_dim, "hidden": model.hidden, "dropout": model.dropout, "tensors": {}}
    for k, v in model.state_dict().items():
        arr = v.detach().cpu().numpy().astype("<f4")
        out["tensors"][k] = {"shape": list(arr.shape), "b64": base64.b64encode(arr.tobytes()).decode()}
    return out


def state_from_json(d: dict) -> GraphSAGE:
    model = GraphSAGE(int(d["in_dim"]), int(d["hidden"]), float(d.get("dropout", 0.2)))
    sd = {}
    for k, t in d["tensors"].items():
        arr = np.frombuffer(base64.b64decode(t["b64"]), dtype="<f4").reshape(t["shape"]).copy()
        sd[k] = torch.tensor(arr)
    model.load_state_dict(sd)
    model.eval()
    return model
