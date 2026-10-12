"""Nightly backtest on VIRTUAL markets and the numbers behind the Track record page.

For every virtual market that settled in the test window (after the embargo, never seen in training):
  * T24 = settle time minus 24h. The radar is computed from information available at T24 only: wallet scores as of the
    last daily cutoff before T24 and the positions flagged wallets had taken in that market by T24.
  * p_market is the virtual market price (fair value digital option with trailing volatility) at T24.
  * the isotonic calibrator is cross-fitted over the test markets (5 folds) so the reported numbers are out of sample.
It is a backtest on virtual markets built from price history, NOT live Groundgraph markets.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .clusters import sybil_assignments
from .config import DAY, HOUR, Params
from .dataset import Dataset, market_price, usd_by_position_asof
from .model import Snapshot, build_snapshot
from .radar import Calibrator, RadarPos, fit_isotonic, js_round, radar_raw
from .training import ModelBundle, Scored, score_snapshot

LEAD_BUCKETS = [0, 15, 30, 45, 60, 90, 120, 180, 240]


@dataclass
class DayState:
    snap: Snapshot
    scored: Scored
    smart_by_node: dict  # node index -> position in wallets array (only flagged)
    sybil_nodes: set


class SnapshotCache:
    """Daily scored snapshots (features, graph model scores, flags) shared by the backtest steps."""

    def __init__(self, ds: Dataset, bundle: ModelBundle, params: Params, preload: dict | None = None):
        self.ds, self.bundle, self.params = ds, bundle, params
        self._snaps: dict[float, Snapshot] = dict(preload or {})
        self._day: dict[float, DayState] = {}

    def get(self, cutoff: float) -> DayState:
        if cutoff in self._day:
            return self._day[cutoff]
        snap = self._snaps.get(cutoff)
        if snap is None:
            snap = build_snapshot(self.ds, cutoff, self.params, with_labels=False)
        sc = score_snapshot(self.bundle, snap, self.params)
        smart_by_node = {int(self.ds.wallet_ids()[i]): i for i in np.nonzero(sc.smart)[0].tolist()}
        syb = sybil_assignments(self.ds, snap.ft, sc.smart, self.params)
        sybil_nodes = {int(snap.ft.wallets[i]) for i in syb}
        st = DayState(snap, sc, smart_by_node, sybil_nodes)
        self._day[cutoff] = st
        return st


@dataclass
class BacktestRow:
    market_id: str
    question: str
    settle_ts: float
    outcome: int  # 1 ABOVE, 0 BELOW
    p_market: float
    p_raw: float
    n_flagged: int
    mi: int = -1
    p_radar: float = float("nan")  # cross-fitted calibrated probability
    lead_min: float | None = None


@dataclass
class TrackRecordResult:
    window_start: float
    window_end: float
    n_markets: int
    n_building: int
    n_total: int
    brier_radar: float | None
    brier_market: float | None
    hit_rate_radar: float | None
    hit_rate_market: float | None
    median_lead_min: float | None
    edge_realized_cents: float | None
    edge_realized_gross_cents: float | None
    n_edge_trades: int
    calibration: list
    lead_hist: list
    rows: list
    calibrator: Calibrator
    extra: dict = field(default_factory=dict)


def format_question(asset: str, strike: float, settle_ts: float) -> str:
    from datetime import datetime, timezone

    d = datetime.fromtimestamp(settle_ts, tz=timezone.utc)
    if strike >= 1000:
        s = f"${strike:,.0f}"
    elif strike >= 1:
        s = f"${strike:,.2f}"
    else:
        s = f"${strike:.6f}".rstrip("0")
    return f"{asset} above or below {s} at the {d.strftime('%b')} {d.day} close?"


def raw_radar_at_t24(ds: Dataset, cache: SnapshotCache, mi: int, params: Params) -> dict | None:
    """Raw radar for virtual market index mi using only information available 24h before it settled."""
    m = ds.markets[mi]
    t24 = m.settle_ts - params.t_minus_h * HOUR
    cutoff = np.floor(t24 / DAY) * DAY
    day = cache.get(float(cutoff))
    pos = ds.positions
    ps = ds.prices[m.asset]
    p_mkt = float(market_price(ps, m, t24, params))
    sel = np.nonzero((pos.market == mi) & (pos.first_ts <= t24))[0]
    usd = usd_by_position_asof(ds, t24)
    # aggregate every wallet to one net position
    net: dict[int, float] = {}
    for k in sel.tolist():
        net[int(pos.wallet[k])] = net.get(int(pos.wallet[k]), 0.0) + float(pos.side[k]) * float(usd[k])
    rp: list[RadarPos] = []
    for w, v in sorted(net.items()):
        i = day.smart_by_node.get(w)
        if i is None or abs(v) < 1e-9:
            continue
        rp.append(RadarPos(abs(v), 1 if v > 0 else -1, float(day.snap.ft.hit_rate[i]), w in day.sybil_nodes))
    raw = radar_raw(p_mkt, rp, n_scored_trades=int(sel.size), params=params)
    raw["market_idx"] = mi
    raw["t24"] = t24
    return raw


def lead_time_for_market(ds: Dataset, cache: SnapshotCache, mi: int, params: Params, test_start: float) -> float | None:
    """Minutes from the earliest flagged wallet entry in the market to the next 5 cent move in its favour.

    Only entries at or after test_start count, so the flags come from a model that has not seen those days."""
    pos = ds.positions
    sel = np.nonzero(pos.market == mi)[0]
    if sel.size == 0:
        return None
    order = sel[np.argsort(pos.first_ts[sel], kind="stable")]
    for k in order.tolist():
        if pos.first_ts[k] < test_start:
            continue
        c = float(np.floor(pos.first_ts[k] / DAY) * DAY)
        day = cache.get(c)
        if int(pos.wallet[k]) in day.smart_by_node:
            fav = pos.fav_ts[k]
            return float((fav - pos.first_ts[k]) / 60.0) if np.isfinite(fav) else None
    return None


def calibration_bins(p: np.ndarray, y: np.ndarray, nbins: int = 10) -> list[dict]:
    out = []
    b = np.minimum((p * nbins).astype(int), nbins - 1)
    for k in range(nbins):
        m = b == k
        if m.any():
            out.append({"bin": k, "predicted": float(p[m].mean()), "observed": float(y[m].mean()), "n": int(m.sum())})
    return out


def expected_calibration_error(p: np.ndarray, y: np.ndarray, nbins: int = 10) -> float:
    """Weighted mean absolute gap between the predicted probability and the observed frequency over equal width bins."""
    if p.size == 0:
        return float("nan")
    b = np.minimum((p * nbins).astype(int), nbins - 1)
    total = 0.0
    for k in range(nbins):
        m = b == k
        if m.any():
            total += m.sum() * abs(float(p[m].mean()) - float(y[m].mean()))
    return float(total / p.size)


def contested_metrics(p_radar: np.ndarray, p_market: np.ndarray, y: np.ndarray, lo: float = 0.05, hi: float = 0.95) -> dict:
    """Brier scores on the markets that were still undecided at T-24h (market price between lo and hi)."""
    m = (p_market > lo) & (p_market < hi)
    if not m.any():
        return {"n": 0, "brier_radar": None, "brier_market": None}
    return {"n": int(m.sum()), "brier_radar": float(np.mean((p_radar[m] - y[m]) ** 2)), "brier_market": float(np.mean((p_market[m] - y[m]) ** 2))}


def paired_bootstrap_diff(p_radar: np.ndarray, p_market: np.ndarray, y: np.ndarray, seed: int, n_boot: int = 500) -> list[float] | None:
    """95% interval of (Brier radar - Brier market), resampling markets. Negative means the radar was closer."""
    n = y.size
    if n < 20:
        return None
    d = (p_radar - y) ** 2 - (p_market - y) ** 2
    rng = np.random.default_rng(seed + 7)
    means = np.array([d[rng.integers(0, n, size=n)].mean() for _ in range(n_boot)])
    return [float(np.quantile(means, 0.025)), float(np.quantile(means, 0.975))]


def lead_histogram(leads: list[float]) -> list[dict]:
    counts = [0] * len(LEAD_BUCKETS)
    for v in leads:
        j = max(i for i, lo in enumerate(LEAD_BUCKETS) if v >= lo)
        counts[j] += 1
    return [{"bucketMin": lo, "count": c} for lo, c in zip(LEAD_BUCKETS, counts)]


def run_backtest(ds: Dataset, bundle: ModelBundle, params: Params, test_start: float, cache: SnapshotCache | None = None,
                 folds: int = 5) -> TrackRecordResult:
    """Backtest every resolved virtual market that settled after test_start + 1 day."""
    cache = cache or SnapshotCache(ds, bundle, params)
    cand = [i for i, m in enumerate(ds.markets) if m.outcome != 0 and m.settle_ts > test_start + DAY and m.open_ts < m.settle_ts - DAY * 2]
    cand.sort(key=lambda i: (ds.markets[i].settle_ts, ds.markets[i].id))
    rows: list[BacktestRow] = []
    n_building = 0
    for mi in cand:
        raw = raw_radar_at_t24(ds, cache, mi, params)
        if raw is None or raw["state"] != "ready":
            n_building += 1
            continue
        m = ds.markets[mi]
        rows.append(BacktestRow(m.id, format_question(m.asset, m.strike, m.settle_ts), m.settle_ts, 1 if m.outcome > 0 else 0,
                                raw["p_market"], raw["p_raw"], raw["n"], mi))
    window_start = float(test_start)
    window_end = float(ds.end_ts)
    n = len(rows)
    if n == 0:
        return TrackRecordResult(window_start, window_end, 0, n_building, len(cand), None, None, None, None, None, None, None, 0,
                                 [], lead_histogram([]), [], Calibrator.from_json(None), {"note": "no markets with a ready radar"})

    p_raw = np.array([r.p_raw for r in rows])
    y = np.array([r.outcome for r in rows], dtype=np.float64)
    p_mkt = np.array([r.p_market for r in rows])

    # cross fitted isotonic calibration: each market is calibrated by a model that never saw it. The calibrator is only
    # adopted when it lowers the out of fold Brier score of the raw radar; with few markets isotonic regression is noisy
    # and the honest choice is then the identity mapping.
    p_cal = np.zeros(n)
    idx = np.arange(n)
    for f in range(folds):
        te = idx % folds == f
        cal = fit_isotonic(p_raw[~te], y[~te], params.radar_calibration_min)
        p_cal[te] = [cal.apply(v) if cal.kind == "identity" else min(max(cal.apply(v), 0.01), 0.99) for v in p_raw[te]]
    production = fit_isotonic(p_raw, y, params.radar_calibration_min)
    brier_raw = float(np.mean((p_raw - y) ** 2))
    brier_cal_oof = float(np.mean((p_cal - y) ** 2))
    adopted = production.kind != "identity" and brier_cal_oof < brier_raw - 1e-4
    if not adopted:
        p_cal = p_raw.copy()
        production = Calibrator([], [], int(n), "identity")
    for r, v in zip(rows, p_cal):
        r.p_radar = float(v)

    brier_r = float(np.mean((p_cal - y) ** 2))
    brier_m = float(np.mean((p_mkt - y) ** 2))
    lean = lambda p: np.where(p > 0.5, 1.0, np.where(p < 0.5, 0.0, 0.5))  # noqa: E731
    hit_r = float(np.mean(1.0 - np.abs(lean(p_cal) - y)))
    hit_m = float(np.mean(1.0 - np.abs(lean(p_mkt) - y)))

    # realised edge: buy the side the radar likes when the edge exceeds 3 cents, net of an assumed trading fee
    fee = params.assumed_fee_bps / 10000.0
    gains, gross = [], []
    for pr, pm, yy in zip(p_cal, p_mkt, y):
        e = 100.0 * (pr - pm)
        if e > params.edge_threshold_cents:
            gains.append(yy - pm / (1.0 - fee))
            gross.append(yy - pm)
        elif e < -params.edge_threshold_cents:
            gains.append((1.0 - yy) - (1.0 - pm) / (1.0 - fee))
            gross.append((1.0 - yy) - (1.0 - pm))
    # a mean over a handful of trades says nothing: report an edge only with at least min_edge_trades positions
    enough = len(gains) >= params.min_edge_trades
    edge = float(100.0 * np.mean(gains)) if enough else None
    edge_gross = float(100.0 * np.mean(gross)) if enough else None

    leads = []
    for r in rows:
        v = lead_time_for_market(ds, cache, r.mi, params, test_start)
        r.lead_min = v
        if v is not None:
            leads.append(v)

    out_rows = []
    for r in rows:
        e_r, e_m = abs(r.p_radar - r.outcome), abs(r.p_market - r.outcome)
        closer = "tie" if abs(e_r - e_m) < 1e-9 else ("radar" if e_r < e_m else "market")
        out_rows.append({"market_id": r.market_id, "question": r.question, "radar_t24": r.p_radar, "market_t24": r.p_market,
                         "outcome": "above" if r.outcome else "below", "closer": closer})
    wins = sum(1 for r in out_rows if r["closer"] == "radar")
    return TrackRecordResult(
        window_start=window_start, window_end=window_end, n_markets=n, n_building=n_building, n_total=len(cand),
        brier_radar=brier_r, brier_market=brier_m, hit_rate_radar=hit_r, hit_rate_market=hit_m,
        median_lead_min=float(np.median(leads)) if leads else None, edge_realized_cents=edge, edge_realized_gross_cents=edge_gross,
        n_edge_trades=len(gains), calibration=calibration_bins(p_cal, y), lead_hist=lead_histogram(leads), rows=out_rows,
        calibrator=production,
        extra={"radar_closer_count": wins, "raw_brier": brier_raw, "calibrated_oof_brier": brier_cal_oof, "calibration_adopted": bool(adopted),
               "ece": expected_calibration_error(p_cal, y), "ece_market": expected_calibration_error(p_mkt, y),
               "contested": contested_metrics(p_cal, p_mkt, y), "n_leads": len(leads),
               "brier_diff_ci95": paired_bootstrap_diff(p_cal, p_mkt, y, params.seed),
               "calibrator": production.kind, "calibration_n": production.n},
    )
