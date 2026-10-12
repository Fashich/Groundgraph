"""Regularly sampled price series with point-in-time trailing volatility."""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .config import DAY, YEAR_SECONDS


@dataclass
class PriceSeries:
    asset: str
    t0: float
    step: float
    px: np.ndarray
    default_vol: float = 0.8
    _cum_r2: np.ndarray = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self.px = np.asarray(self.px, dtype=np.float64)
        if self.px.size == 0:
            raise ValueError("empty price series")
        if np.any(self.px <= 0):
            raise ValueError("prices must be positive")
        lp = np.log(self.px)
        r = np.diff(lp, prepend=lp[0])
        self._cum_r2 = np.cumsum(r * r)

    @property
    def n(self) -> int:
        return int(self.px.size)

    @property
    def end_ts(self) -> float:
        return self.t0 + (self.n - 1) * self.step

    def times(self) -> np.ndarray:
        return self.t0 + self.step * np.arange(self.n)

    def idx(self, ts) -> np.ndarray:
        """Index of the last sample at or before ts (clipped into the series)."""
        i = np.floor((np.asarray(ts, dtype=np.float64) - self.t0) / self.step + 1e-9).astype(np.int64)
        return np.clip(i, 0, self.n - 1)

    def at(self, ts) -> np.ndarray:
        return self.px[self.idx(ts)]

    def vol_idx(self, i, window_days: float = 30.0, min_days: float = 1.0) -> np.ndarray:
        """Annualised realised volatility using only samples up to and including index i."""
        i = np.asarray(i, dtype=np.int64)
        w = max(2, int(round(window_days * DAY / self.step)))
        lo = np.maximum(i - w, 0)
        cnt = (i - lo).astype(np.float64)
        var = (self._cum_r2[i] - self._cum_r2[lo]) / np.maximum(cnt, 1.0) / (self.step / YEAR_SECONDS)
        min_cnt = max(2.0, min_days * DAY / self.step)
        out = np.sqrt(np.maximum(var, 0.0))
        return np.where(cnt >= min_cnt, out, self.default_vol)

    def vol_at(self, ts, window_days: float = 30.0) -> np.ndarray:
        return self.vol_idx(self.idx(ts), window_days)

    def truncate(self, as_of: float) -> "PriceSeries":
        if as_of >= self.end_ts:
            return self
        n = int(np.floor((as_of - self.t0) / self.step + 1e-9)) + 1
        if n < 1:
            raise ValueError("as_of is before the first sample")
        return PriceSeries(self.asset, self.t0, self.step, self.px[:n].copy(), self.default_vol)

    def to_json(self) -> dict:
        return {"asset": self.asset, "t0": self.t0, "step": self.step, "px": [float(x) for x in self.px]}

    @classmethod
    def from_json(cls, d: dict, default_vol: float = 0.8) -> "PriceSeries":
        return cls(d["asset"], float(d["t0"]), float(d["step"]), np.asarray(d["px"], dtype=np.float64), default_vol)


def resample_to_grid(ts: np.ndarray, px: np.ndarray, t0: float, step: float, t_end: float) -> np.ndarray:
    """Forward fill irregular (ts, px) samples onto a regular grid [t0, t_end] using the last known price."""
    grid = np.arange(t0, t_end + 1e-9, step)
    order = np.argsort(ts, kind="stable")
    ts_s, px_s = np.asarray(ts, dtype=np.float64)[order], np.asarray(px, dtype=np.float64)[order]
    j = np.searchsorted(ts_s, grid, side="right") - 1
    j = np.clip(j, 0, len(ts_s) - 1)
    return px_s[j]
