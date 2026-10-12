"""Smart money radar: positioning of flagged wallets -> P(ABOVE), confidence interval and edge versus the market.

This module is the reference for the TypeScript `radarProbability` in the SDK. The golden vectors in
tests/radar_vectors.json are generated from `radar_raw` here and pin the exact numbers (see tests/test_radar.py).

    w_i   = sqrt(position_usd_i) * (0.4 + hit_rate_i) * (0.5 if sybil_i else 1)
    s_y   = sum w_i[side=ABOVE] / sum w_i          hr = sum w_i * hit_rate_i / sum w_i
    sig   = (2 s_y - 1) * (2 hr - 1)
    logit(p_radar) = logit(p_market) + 1.4 * n / (n + 6) * sig
    ci_pts     = max(2, round(164 * sqrt(p (1 - p) / (4 n + 10))))
    edge_cents = round(100 * (p_radar - p_market))

Rounding is round-half-up (floor(x + 0.5)) like JavaScript Math.round. p_market is clamped to [1e-6, 1 - 1e-6]
before the logit only (the edge uses the unclamped market price), exactly like packages/sdk/src/radar.ts. Position
sizes are floored at 0 and hit rates clamped to [0, 1]. n is the number of flagged wallets (one aggregated position
per wallet). Operation order follows the TypeScript source so IEEE doubles agree bit for bit.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .config import Params

P_CLAMP = 1e-6  # same clamp as packages/sdk/src/radar.ts (applied to the logit input only)


def js_round(x: float) -> int:
    return int(math.floor(x + 0.5))


def logit(p: float) -> float:
    return math.log(p / (1.0 - p))


def sigmoid(x: float) -> float:
    """1 / (1 + e^-x), written exactly like the TypeScript SDK (|x| stays below 20 here, so no overflow)."""
    return 1.0 / (1.0 + math.exp(-x))


def clamp_p(p: float) -> float:
    return min(max(float(p), P_CLAMP), 1.0 - P_CLAMP)


@dataclass(frozen=True)
class RadarPos:
    usd: float  # position size in USD (not base units)
    side: int  # +1 ABOVE, -1 BELOW
    hit_rate: float  # 0..1
    sybil: bool = False


def ci_points(p: float, n: int, params: Params | None = None) -> int:
    scale = (params or Params()).radar_ci_scale
    return max(2, js_round(scale * math.sqrt((p * (1.0 - p)) / (4.0 * n + 10.0))))


def radar_raw(p_market: float, positions: list[RadarPos], n_scored_trades: int | None = None, params: Params | None = None) -> dict:
    """Uncalibrated radar for one market. Returns a dict with state 'ready' or 'building' and every intermediate value.

    State is 'building' when fewer than radar_min_flagged flagged wallets hold a position or fewer than
    radar_min_scored_trades scored trades exist (pass n_scored_trades=None to skip the second check).
    """
    prm = params or Params()
    pm_raw = float(p_market)
    pm = clamp_p(pm_raw)
    n = len(positions)
    vol_a = sum(p.usd for p in positions if p.side > 0)
    vol_b = sum(p.usd for p in positions if p.side < 0)
    out = {
        "state": "building", "n": n, "p_market": pm_raw, "s_y": None, "hr": None, "sig": None, "p_raw": None,
        "ci_pts": None, "edge_cents": None, "vol_above": vol_a, "vol_below": vol_b,
    }
    if n < prm.radar_min_flagged:
        return out
    if n_scored_trades is not None and n_scored_trades < prm.radar_min_scored_trades:
        return out
    w_sum = 0.0
    w_above = 0.0
    hr_sum = 0.0
    for p in positions:
        usd = max(0.0, p.usd if math.isfinite(p.usd) else 0.0)
        hit = min(max(p.hit_rate, 0.0), 1.0)
        w = math.sqrt(usd) * (prm.radar_hit_offset + hit) * (prm.radar_sybil_cap if p.sybil else 1.0)
        w_sum += w
        if p.side > 0:
            w_above += w
        hr_sum += w * hit
    if w_sum <= 0:
        return out
    s_y = w_above / w_sum
    hr = hr_sum / w_sum
    sig = (2.0 * s_y - 1.0) * (2.0 * hr - 1.0)
    p_raw = sigmoid(logit(pm) + prm.radar_gain * (n / (n + prm.radar_shrink)) * sig)
    out.update(
        state="ready", s_y=s_y, hr=hr, sig=sig, p_raw=p_raw, ci_pts=ci_points(p_raw, n, prm),
        edge_cents=js_round(100.0 * (p_raw - pm_raw)),
    )
    return out


# --------------------------------------------------------------------------- calibration
@dataclass
class Calibrator:
    """Isotonic mapping raw radar probability -> observed frequency. Identity when there is not enough data."""

    x: list
    y: list
    n: int = 0
    kind: str = "identity"

    def apply(self, p: float) -> float:
        if self.kind == "identity" or not self.x:
            return float(p)
        return float(np.interp(p, self.x, self.y))

    def to_json(self) -> dict:
        return {"x": [float(v) for v in self.x], "y": [float(v) for v in self.y], "n": self.n, "kind": self.kind}

    @classmethod
    def from_json(cls, d: dict | None) -> "Calibrator":
        if not d:
            return identity_calibrator()
        return cls(list(d["x"]), list(d["y"]), int(d.get("n", 0)), d.get("kind", "identity"))

    def ident(self) -> str:
        import hashlib
        import json

        if self.kind == "identity":
            return "identity"
        return "iso-" + hashlib.sha256(json.dumps(self.to_json(), sort_keys=True).encode()).hexdigest()[:6]


def identity_calibrator() -> Calibrator:
    return Calibrator([], [], 0, "identity")


def fit_isotonic(p_raw: np.ndarray, outcome: np.ndarray, min_n: int) -> Calibrator:
    """Isotonic regression of the realised outcome (1 = ABOVE) on the raw radar probability."""
    from sklearn.isotonic import IsotonicRegression

    p = np.asarray(p_raw, dtype=np.float64)
    y = np.asarray(outcome, dtype=np.float64)
    if p.size < min_n or len(np.unique(y)) < 2:
        return Calibrator([], [], int(p.size), "identity")
    iso = IsotonicRegression(y_min=0.01, y_max=0.99, out_of_bounds="clip", increasing=True)
    iso.fit(p, y)
    return Calibrator([float(v) for v in iso.X_thresholds_], [float(v) for v in iso.y_thresholds_], int(p.size), "isotonic")


def finalize(raw: dict, calibrator: Calibrator, params: Params | None = None) -> dict:
    """Apply the calibrator to a ready radar result: calibrated p, ci_pts and edge are recomputed from the calibrated p."""
    if raw["state"] != "ready":
        return raw
    prm = params or Params()
    p = calibrator.apply(raw["p_raw"])
    if calibrator.kind != "identity":
        p = min(max(p, 0.01), 0.99)
    out = dict(raw)
    out.update(p=p, ci_pts=ci_points(p, raw["n"], prm), edge_cents=js_round(100.0 * (p - raw["p_market"])))
    return out
