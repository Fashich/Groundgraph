"""Explainable calibrated head: score 0..100 as a sum of five named integer contributions.

score = round( scale * ( w1*whale + w2*timing + w3*hit + w4*centrality + w5*lead + wg*graph_model ) )

* every weight is >= 0 (monotone: a better feature can never lower the score)
* the graph model percentile `g` is folded into the Centrality row ("Centrality (graph model)", ADR-002), so the UI
  still shows exactly five bars that add up to the displayed score
* integer points are allocated with the largest remainder method so they sum to the score exactly
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.optimize import minimize

from .config import DEFAULT_HEAD_WEIGHTS, FEATURE_KEYS, Params
from .features import FeatureTable
from .model import HEAD_KEYS

ROW_LABELS = {
    "whale_overlap": "Whale overlap",
    "entry_timing": "Entry timing",
    "hit_rate": "Hit rate",
    "centrality": "Centrality (graph model)",
    "lead_time": "Lead time",
}


def js_round(x):
    """Round half up, identical to JavaScript Math.round for the values we use."""
    return np.floor(np.asarray(x, dtype=np.float64) + 0.5)


@dataclass
class Head:
    w: np.ndarray  # 5 non negative weights in HEAD_KEYS order
    w_gnn: float = 0.0
    scale: float = 100.0  # score points per unit of z
    smart_threshold: float = 70.0
    top_threshold: float = 85.0
    intercept: float = 0.0
    fitted: bool = False
    meta: dict = field(default_factory=dict)

    # ---- scoring
    @staticmethod
    def g_in(g: np.ndarray) -> np.ndarray:
        """Graph model percentile measured above its median, like every other head input."""
        return np.clip(2.0 * np.asarray(g, dtype=np.float64) - 1.0, 0.0, 1.0)

    def z(self, H: np.ndarray, g: np.ndarray) -> np.ndarray:
        return H @ self.w + self.w_gnn * self.g_in(g)

    def real_points(self, H: np.ndarray, g: np.ndarray) -> np.ndarray:
        """Real valued contributions (n x 5, HEAD_KEYS order). Row sums are capped at 100."""
        P = self.scale * H * self.w[None, :]
        P[:, 3] += self.scale * self.w_gnn * self.g_in(g)
        tot = P.sum(axis=1)
        over = tot > 100.0
        if over.any():
            P[over] *= (100.0 / tot[over])[:, None]
        return P

    def score(self, H: np.ndarray, g: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Returns (integer scores, integer contributions n x 5 whose rows sum to the scores)."""
        P = self.real_points(H, g)
        total = js_round(P.sum(axis=1)).astype(np.int64)
        total = np.clip(total, 0, 100)
        return total, allocate_points(P, total)

    # ---- serialisation
    def to_json(self) -> dict:
        return {
            "w": [float(x) for x in self.w], "w_gnn": float(self.w_gnn), "scale": float(self.scale),
            "smart_threshold": float(self.smart_threshold), "top_threshold": float(self.top_threshold),
            "intercept": float(self.intercept), "fitted": bool(self.fitted), "meta": self.meta,
            "keys": list(HEAD_KEYS),
        }

    @classmethod
    def from_json(cls, d: dict) -> "Head":
        return cls(np.array(d["w"], dtype=np.float64), float(d["w_gnn"]), float(d["scale"]), float(d["smart_threshold"]),
                   float(d["top_threshold"]), float(d.get("intercept", 0.0)), bool(d.get("fitted", False)), d.get("meta", {}))

    def row_caps(self) -> dict[str, float]:
        """Maximum points each row can contribute (all inputs at 1.0), for drawing bar widths."""
        caps = (self.scale * self.w).copy()
        caps[3] += self.scale * self.w_gnn
        return {k: float(c) for k, c in zip(HEAD_KEYS, caps)}


def default_head() -> Head:
    """Cold start head: the design weights, no graph model term. Used until a model has been trained."""
    w = np.array([DEFAULT_HEAD_WEIGHTS[k] for k in FEATURE_KEYS], dtype=np.float64)
    return Head(w=w, w_gnn=0.0, scale=100.0, smart_threshold=70.0, top_threshold=85.0, fitted=False,
                meta={"note": "cold start weights from the design, not trained"})


def allocate_points(P: np.ndarray, total: np.ndarray) -> np.ndarray:
    """Largest remainder allocation: integer rows that sum exactly to `total` and stay close to the real values."""
    P = np.maximum(np.asarray(P, dtype=np.float64), 0.0)
    n, k = P.shape
    out = np.zeros((n, k), dtype=np.int64)
    for i in range(n):
        row = P[i]
        t = int(total[i])
        s = row.sum()
        if t <= 0 or s <= 0:
            continue
        target = row * (t / s)  # rescale to hit the total (a no-op unless rounding moved it)
        fl = np.floor(target).astype(np.int64)
        rem = t - int(fl.sum())
        if rem > 0:
            frac = target - fl
            order = np.lexsort((np.arange(k), -frac))  # larger remainder first, lower row index on ties
            for j in order[:rem]:
                fl[j] += 1
        out[i] = fl
    return out


# --------------------------------------------------------------------------- fitting
def _nll_and_grad(theta: np.ndarray, Z: np.ndarray, y: np.ndarray, sw: np.ndarray, l2: float):
    b, w = theta[0], theta[1:]
    s = Z @ w + b
    p = 1.0 / (1.0 + np.exp(-np.clip(s, -30, 30)))
    eps = 1e-12
    nll = -(sw * (y * np.log(p + eps) + (1 - y) * np.log(1 - p + eps))).sum() + l2 * (w @ w)
    r = sw * (p - y)
    g = np.concatenate([[r.sum()], Z.T @ r + 2 * l2 * w])
    return nll, g


def fit_nonneg_logistic(Z: np.ndarray, y: np.ndarray, l2: float = 1e-3, lower: np.ndarray | None = None,
                        upper: np.ndarray | None = None) -> tuple[float, np.ndarray]:
    """Class balanced logistic regression, unconstrained intercept, weights inside [lower, upper] (default [0, inf))."""
    pos = y > 0.5
    n_pos, n_neg = int(pos.sum()), int((~pos).sum())
    sw = np.where(pos, 0.5 / max(n_pos, 1), 0.5 / max(n_neg, 1))
    d = Z.shape[1]
    lo = np.zeros(d) if lower is None else np.asarray(lower, dtype=np.float64)
    hi = [None] * d if upper is None else [None if u is None else float(u) for u in upper]
    x0 = np.concatenate([[0.0], np.maximum(lo, 0.5)])
    bounds = [(None, None)] + [(float(lo[j]), hi[j]) for j in range(d)]
    res = minimize(_nll_and_grad, x0, args=(Z, y.astype(np.float64), sw, l2), jac=True, method="L-BFGS-B", bounds=bounds,
                   options={"maxiter": 500})
    return float(res.x[0]), np.maximum(res.x[1:], lo)


def _fit_capped(H: np.ndarray, g: np.ndarray, y: np.ndarray, floor: float, cap: float, use_gnn: bool) -> tuple[float, np.ndarray, float]:
    """Fit heuristic weights (>= floor) and the graph model weight (share of total weight <= cap)."""
    if not use_gnn:
        b, w = fit_nonneg_logistic(H, y, lower=np.full(5, floor))
        return b, w, 0.0
    Z = np.concatenate([H, Head.g_in(g)[:, None]], axis=1)
    lower = np.concatenate([np.full(5, floor), [0.0]])
    b, w = fit_nonneg_logistic(Z, y, lower=lower)
    for _ in range(4):  # fixed point on the upper bound: wg <= cap / (1 - cap) * sum(w_heuristic)
        if w[5] / max(w.sum(), 1e-12) <= cap + 1e-9:
            break
        ub = cap / (1.0 - cap) * float(w[:5].sum())
        b, w = fit_nonneg_logistic(Z, y, lower=lower, upper=[None] * 5 + [ub])
    return b, w[:5], float(w[5])


def best_fbeta_cut(z: np.ndarray, y: np.ndarray, beta: float = 0.5, lo_q: float = 0.50, hi_q: float = 0.995, steps: int = 200) -> float | None:
    """Cut on the raw head index z that maximises F-beta for the label, searched between two quantiles of z.

    beta < 1 weights precision more than recall: a wallet flag should be right more often than it is complete.
    Returns None when there are too few positives or negatives to say anything.
    """
    ok = np.isfinite(y) & np.isfinite(z)
    zz, t = z[ok], y[ok] > 0.5
    if t.sum() < 5 or (~t).sum() < 5:
        return None
    best, best_f1 = None, -1.0
    for c in np.unique(np.quantile(zz, np.linspace(lo_q, hi_q, steps))):
        pred = zz >= c
        tp = float((pred & t).sum())
        fp = float((pred & ~t).sum())
        fn = float((~pred & t).sum())
        b2 = beta * beta
        f1 = (1 + b2) * tp / max((1 + b2) * tp + b2 * fn + fp, 1.0)
        if f1 > best_f1 + 1e-12:
            best, best_f1 = float(c), f1
    return best


def fit_head(H: np.ndarray, g: np.ndarray, y: np.ndarray, active: np.ndarray, params: Params, use_gnn: bool = True) -> Head:
    """Fit the monotone linear head on labelled, active training samples (out of fold graph model percentiles).

    The weights come from a class balanced logistic regression. The scale puts the 99th percentile of training scores at
    about 99 points (no saturation) and, if that would push the optimal cut above 70, lowers it so the flag threshold
    never exceeds the design value of 70. The smart money threshold is the F1 optimal cut in score units, searched only among cuts that flag at most max_flag_share (15%) of active wallets.
    """
    m = np.isfinite(y) & active
    if m.sum() < 30 or len(np.unique(y[m])) < 2:
        return default_head()
    b, w5, wg = _fit_capped(H[m], g[m], y[m], params.head_weight_floor, params.gnn_share_cap, use_gnn)
    zall = H[m] @ w5 + wg * Head.g_in(g[m])
    cut = best_fbeta_cut(zall, y[m], params.head_cut_beta, lo_q=max(0.5, 1.0 - params.max_flag_share))
    thr = float(params.smart_threshold_default)
    q99 = float(np.quantile(zall, 0.99))
    scale = 99.0 / q99 if q99 > 1e-9 else 100.0  # the top 1% of training samples sit at about 99 points, no saturation
    if cut is not None and cut > 1e-9:
        scale = min(scale, thr / cut)  # and the optimal cut never lands above the design threshold of 70
        thr = scale * cut
    head = Head(w=w5, w_gnn=wg, scale=scale, intercept=b, fitted=True)
    sc, _ = head.score(H[m], g[m])
    flagged = sc[sc >= thr]
    top = float(np.quantile(flagged, params.top_quantile)) if flagged.size >= 5 else thr + 0.5 * (100.0 - thr)
    head.smart_threshold = float(round(thr, 1))
    head.top_threshold = float(min(max(top, thr + 3.0), 98.0))
    head.meta = {"n_samples": int(m.sum()), "n_pos": int((y[m] > 0.5).sum()), "uses_gnn": use_gnn,
                 "cut_z": None if cut is None else float(cut), "cut_beta": params.head_cut_beta, "max_flag_share": params.max_flag_share}
    return head


# --------------------------------------------------------------------------- reasons
def _top_pct(c: float) -> int:
    return int(max(1, min(100, round((1.0 - c) * 100.0))))


def reasons_for(points: np.ndarray, ft: FeatureTable, i: int, gnn_pct: float, gnn_points: float, params: Params) -> list[str]:
    """Plain language reasons from the top 3 contributions (design templates, no em dashes).

    A contribution only produces a sentence when the underlying observation backs it (for example "entered 0 of 12
    markets early" is never shown as a reason).
    """
    order = sorted(range(5), key=lambda j: (-int(points[j]), j))
    out: list[str] = []
    for j in order:
        if points[j] <= 0 or len(out) >= 3:
            continue
        key = HEAD_KEYS[j]
        if key == "whale_overlap":
            n = int(ft.n_whale_cp[i])
            if n >= 1:
                out.append("Shares 1 counterparty with a known whale wallet" if n == 1 else f"Shares {n} counterparties with known whale wallets")
        elif key == "entry_timing":
            if int(ft.n_early[i]) >= 1:
                out.append(f"Entered {int(ft.n_early[i])} of last {int(ft.n_entries[i])} markets before a 5¢+ price move")
        elif key == "hit_rate":
            n, k = int(ft.hit_n[i]), int(ft.hit_k[i])
            if n >= 1 and k >= 1:
                out.append(f"{int(round(100.0 * k / n))}% hit rate on resolved markets (30d, n={n})")
        elif key == "centrality":
            c = float(ft.centrality[i])
            b = int(ft.bridged[i])
            tail = f", bridges {b} clusters" if b >= 2 else ""
            if gnn_points > 0 and gnn_points >= points[j] * 0.5 and gnn_pct >= 0.5:
                out.append(f"Graph model ranks it in the top {_top_pct(gnn_pct)}% of wallets{tail}")
            elif c >= 0.5:
                out.append(f"Top {_top_pct(c)}% by graph centrality{tail}")
        elif key == "lead_time":
            if float(ft.lead_time_min[i]) > 0 and int(ft.n_early[i]) >= 1:
                out.append(f"Median lead of {int(round(float(ft.lead_time_min[i])))} min ahead of price moves")
    return out
