"""Price history from the Pyth Benchmarks TradingView shim, cached per closed day in indexer_state.

Used by the Helius source to value swaps in USD and to build the virtual markets. NOT verified against the live
service in this repository's build environment: the parser follows the documented TradingView UDF response
({"s": "ok", "t": [...], "c": [...]} / {"s": "no_data"} / {"s": "error", "errmsg": ...}).
"""

from __future__ import annotations

import logging
from typing import Callable

import numpy as np

from ..config import ASSETS, DAY, Params
from ..prices import PriceSeries, resample_to_grid
from .http import HttpError, JsonClient

log = logging.getLogger("scorer.pyth")

STEP = 300.0  # 5 minute bars
SHIM_PATH = "/v1/shims/tradingview/history"


class PythError(RuntimeError):
    pass


def parse_tv_history(doc: dict) -> tuple[np.ndarray, np.ndarray]:
    """(timestamps in seconds, close prices) of one shim response. 'no_data' gives empty arrays."""
    status = doc.get("s")
    if status == "no_data":
        return np.zeros(0), np.zeros(0)
    if status != "ok":
        raise PythError(f"price service error: {doc.get('errmsg', status)}")
    t, c = doc.get("t") or [], doc.get("c") or []
    if len(t) != len(c):
        raise PythError("price service returned arrays of different length")
    ts = np.asarray(t, dtype=np.float64)
    px = np.asarray(c, dtype=np.float64)
    ok = np.isfinite(ts) & np.isfinite(px) & (px > 0)
    return ts[ok], px[ok]


class PythBenchmarks:
    def __init__(self, base_url: str, client: JsonClient | None = None, api_key: str = "", chunk_days: float = 5.0):
        self.base = base_url.rstrip("/")
        self.client = client or JsonClient(secrets=[api_key])
        self.api_key = api_key
        self.chunk = chunk_days * DAY

    def fetch(self, asset: str, t_from: float, t_to: float) -> tuple[np.ndarray, np.ndarray]:
        """5 minute closes for [t_from, t_to], fetched in chunks of chunk_days."""
        sym = ASSETS[asset]["pyth"]
        headers = {"Authorization": f"Bearer {self.api_key}"} if self.api_key else None
        ts_all, px_all = [], []
        t = t_from
        while t < t_to:
            hi = min(t + self.chunk, t_to)
            doc = self.client.get_json(
                self.base + SHIM_PATH,
                params={"symbol": sym, "resolution": "5", "from": int(t), "to": int(hi)},
                headers=headers,
            )
            ts, px = parse_tv_history(doc)
            ts_all.append(ts)
            px_all.append(px)
            t = hi
        if not ts_all:
            return np.zeros(0), np.zeros(0)
        ts = np.concatenate(ts_all)
        px = np.concatenate(px_all)
        order = np.argsort(ts, kind="stable")
        ts, px = ts[order], px[order]
        keep = np.concatenate([[True], np.diff(ts) > 0])  # chunk borders can repeat a bar
        return ts[keep], px[keep]

    def load_series(
        self, assets: list[str], t0: float, t_end: float, cache_get: Callable[[str], dict | None] | None = None,
        cache_put: Callable[[str, dict], None] | None = None,
    ) -> dict[str, PriceSeries]:
        """Regular 5 minute PriceSeries per asset on [t0, t_end]. Closed days are cached through cache_get/cache_put."""
        out: dict[str, PriceSeries] = {}
        n_days = int(np.ceil((t_end - t0) / DAY))
        for a in assets:
            ts_parts, px_parts = [], []
            for d in range(n_days):
                lo, hi = t0 + d * DAY, min(t0 + (d + 1) * DAY, t_end)
                closed = lo + DAY <= t_end - DAY  # a complete day that ended at least a day ago never changes
                key = f"scorer:prices:{a}:{int(lo)}"
                doc = cache_get(key) if (cache_get and closed) else None
                if doc is None:
                    ts, px = self.fetch(a, lo, hi)
                    doc = {"t": ts.tolist(), "c": px.tolist()}
                    if cache_put and closed and ts.size:
                        cache_put(key, doc)
                ts_parts.append(np.asarray(doc["t"], dtype=np.float64))
                px_parts.append(np.asarray(doc["c"], dtype=np.float64))
            ts = np.concatenate(ts_parts) if ts_parts else np.zeros(0)
            px = np.concatenate(px_parts) if px_parts else np.zeros(0)
            if ts.size < 100:
                raise PythError(f"not enough price history for {a}: {ts.size} bars")
            grid_t0 = float(np.ceil(ts[0] / STEP) * STEP)
            end = float(np.floor(min(ts[-1], t_end) / STEP) * STEP)
            out[a] = PriceSeries(a, grid_t0, STEP, resample_to_grid(ts, px, grid_t0, STEP, end))
        return out
