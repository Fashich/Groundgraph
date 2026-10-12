"""Training on a time split, determinism, the held-out evaluation and the track record backtest."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from scorer.config import DAY
from scorer.model import state_to_json
from scorer.track_record import (
    SnapshotCache, calibration_bins, contested_metrics, expected_calibration_error, lead_histogram, paired_bootstrap_diff,
    raw_radar_at_t24, run_backtest,
)
from scorer.training import train_model
from test_leakage import scramble_future

ROOT = Path(__file__).resolve().parents[1]
NOW = 1791808200.0


@pytest.fixture(scope="module")
def trained(small_ds, params):
    return train_model(small_ds, params, "demo-synthetic", NOW)


@pytest.fixture(scope="module")
def backtest(small_ds, params, trained):
    cache = SnapshotCache(small_ds, trained.bundle, params, preload=dict(trained.test_snaps))
    return run_backtest(small_ds, trained.bundle, params, trained.split.test_start, cache)


# --------------------------------------------------------------------------- training
def test_training_reports_honest_held_out_metrics(trained):
    m = trained.bundle.metrics
    for k in ("test_auc", "test_pr_auc", "test_base_rate", "n_test_labeled", "cv_auc_graph_model", "test_auc_heuristic_only",
              "test_auc_graph_model_only", "test_auc_ci95"):
        assert k in m and m[k] is not None, k
    assert 0.5 < m["test_auc"] <= 1.0
    lo, hi = m["test_auc_ci95"]
    assert lo <= m["test_auc"] <= hi + 1e-9 and hi - lo < 0.5
    # PR AUC must be judged against the base rate: with rare positives it is far below the ROC AUC
    assert m["test_pr_auc"] < m["test_auc"]
    assert m["test_pr_auc"] > m["test_base_rate"]
    assert m["n_test_positive"] >= 10


def test_the_split_used_for_training_has_an_embargo(trained, params):
    s = trained.split
    assert s.test_cutoffs[0] - s.train_end >= params.embargo_days * DAY - 1e-6
    d = trained.bundle.split
    assert d["n_train_cutoffs"] == len(s.train_cutoffs) and d["embargo_days"] == params.embargo_days


def test_graph_term_enters_the_centrality_row_only(trained):
    h = trained.bundle.head
    assert h.fitted and h.w_gnn >= 0.0  # the fit may give the graph model no weight on a small world
    assert h.w_gnn / (h.w.sum() + h.w_gnn) <= 0.40 + 1e-6
    # with a graph weight, moving the graph percentile changes the centrality row and nothing else (ADR-002)
    from scorer.head import Head

    hh = Head(w=h.w.copy(), w_gnn=0.7, scale=h.scale, fitted=True)
    H = np.full((1, 5), 0.3)
    lo, hi = hh.real_points(H, np.array([0.5])), hh.real_points(H, np.array([1.0]))
    changed = np.nonzero(np.abs(hi - lo)[0] > 1e-12)[0].tolist()
    assert changed == [3]


def test_training_is_deterministic_in_process(small_ds, params, trained):
    again = train_model(small_ds, params, "demo-synthetic", NOW)
    assert again.bundle.version == trained.bundle.version
    assert state_to_json(again.bundle.sage()) == state_to_json(trained.bundle.sage())
    assert again.bundle.head.to_json() == trained.bundle.head.to_json()


def test_training_is_deterministic_across_processes_and_hash_seeds():
    code = (
        "import dataclasses\n"
        "from scorer.config import Params\n"
        "from scorer.sources.synthetic import SyntheticConfig, SyntheticSource\n"
        "from scorer.training import train_model\n"
        "p = dataclasses.replace(Params(), sage_epochs=20, cv_folds=3)\n"
        "ds = SyntheticSource(SyntheticConfig(n_wallets=70, days=300, sybil_groups=(3,)), p).build_dataset(1791808200.0)\n"
        "print(train_model(ds, p, 'demo-synthetic', 1791808200.0).bundle.version)\n"
    )
    outs = []
    for hs in ("0", "777"):
        env = dict(os.environ, PYTHONHASHSEED=hs, PYTHONPATH=str(ROOT), PYTHONWARNINGS="ignore")
        r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env, timeout=400, cwd=str(ROOT))
        assert r.returncode == 0, r.stderr[-500:]
        outs.append(r.stdout.strip().splitlines()[-1])
    assert outs[0] == outs[1] and outs[0].startswith("gg-sage-")


# --------------------------------------------------------------------------- backtest
def test_backtest_only_uses_markets_that_settled_after_the_embargo(backtest, trained, small_ds):
    assert backtest.n_markets >= 10
    assert backtest.window_start == trained.split.test_start
    settle = {m.id: m.settle_ts for m in small_ds.markets}
    assert all(settle[r["market_id"]] > trained.split.test_start + DAY for r in backtest.rows)
    assert all(r["outcome"] in ("above", "below") and r["closer"] in ("radar", "market", "tie") for r in backtest.rows)
    assert all(0.0 <= r["radar_t24"] <= 1.0 and 0.0 <= r["market_t24"] <= 1.0 for r in backtest.rows)


def test_backtest_metrics_are_consistent_with_the_rows(backtest):
    rows = backtest.rows
    y = np.array([1.0 if r["outcome"] == "above" else 0.0 for r in rows])
    pr = np.array([r["radar_t24"] for r in rows])
    pm = np.array([r["market_t24"] for r in rows])
    assert backtest.brier_radar == pytest.approx(float(np.mean((pr - y) ** 2)))
    assert backtest.brier_market == pytest.approx(float(np.mean((pm - y) ** 2)))
    assert sum(b["n"] for b in backtest.calibration) == len(rows)
    assert backtest.extra["ece"] == pytest.approx(expected_calibration_error(pr, y))
    assert backtest.n_markets + backtest.n_building == backtest.n_total
    # the realised edge needs a minimum number of positions, otherwise it is withheld instead of reported
    if backtest.n_edge_trades < 10:
        assert backtest.edge_realized_cents is None
    assert backtest.calibrator.kind in ("identity", "isotonic")
    if not backtest.extra["calibration_adopted"]:
        assert backtest.calibrator.kind == "identity"


def test_the_radar_at_t24_ignores_everything_after_t24(small_ds, params, trained):
    cache = SnapshotCache(small_ds, trained.bundle, params)
    cand = [i for i, m in enumerate(small_ds.markets) if m.outcome != 0 and m.settle_ts > trained.split.test_start + 3 * DAY][:60]
    picked = []
    for mi in cand:
        raw = raw_radar_at_t24(small_ds, cache, mi, params)
        if raw is not None and raw["state"] == "ready":
            picked.append((mi, raw))
        if len(picked) == 3:
            break
    assert picked, "no market with a ready radar in the small world"
    for mi, raw in picked:
        t24 = raw["t24"]
        alt = scramble_future(small_ds, t24, params, seed=mi)
        raw2 = raw_radar_at_t24(alt, SnapshotCache(alt, trained.bundle, params), mi, params)
        assert raw2["state"] == "ready" and raw2["n"] == raw["n"]
        assert raw2["p_raw"] == pytest.approx(raw["p_raw"], abs=1e-9)
        assert raw2["p_market"] == pytest.approx(raw["p_market"], abs=1e-9)


def test_calibration_bins_hand_values():
    p = np.array([0.05, 0.08, 0.5, 0.55, 0.95, 1.0])
    y = np.array([0.0, 1.0, 1.0, 0.0, 1.0, 1.0])
    bins = {b["bin"]: b for b in calibration_bins(p, y)}
    assert set(bins) == {0, 5, 9}  # empty bins are omitted
    assert bins[0] == {"bin": 0, "predicted": pytest.approx(0.065), "observed": 0.5, "n": 2}
    assert bins[9]["n"] == 2 and bins[9]["observed"] == 1.0


def test_expected_calibration_error_hand_values():
    p = np.array([0.1, 0.1, 0.9, 0.9])
    assert expected_calibration_error(p, np.array([0.0, 0.0, 1.0, 1.0])) == pytest.approx(0.1)
    assert expected_calibration_error(p, np.array([1.0, 0.0, 1.0, 0.0])) == pytest.approx((2 * 0.4 + 2 * 0.4) / 4)
    assert expected_calibration_error(np.array([0.25] * 4), np.array([1.0, 0.0, 0.0, 0.0])) == pytest.approx(0.0)
    assert np.isnan(expected_calibration_error(np.array([]), np.array([])))


def test_lead_histogram_buckets_and_contested_metrics():
    h = {b["bucketMin"]: b["count"] for b in lead_histogram([0.0, 14.9, 15.0, 59.0, 60.0, 500.0])}
    assert h[0] == 2 and h[15] == 1 and h[45] == 1 and h[60] == 1 and h[240] == 1 and sum(h.values()) == 6
    c = contested_metrics(np.array([0.5, 0.99]), np.array([0.5, 0.98]), np.array([1.0, 1.0]))
    assert c["n"] == 1 and c["brier_radar"] == pytest.approx(0.25) and c["brier_market"] == pytest.approx(0.25)
    assert contested_metrics(np.array([0.99]), np.array([0.99]), np.array([1.0]))["n"] == 0


def test_paired_bootstrap_interval_brackets_the_mean_difference(rng):
    y = (rng.random(300) < 0.5).astype(float)
    pm = np.clip(y * 0.6 + 0.2 + rng.normal(0, 0.1, 300), 0.01, 0.99)
    pr = np.clip(pm + 0.05 * (y - 0.5), 0.01, 0.99)  # slightly better on average
    lo, hi = paired_bootstrap_diff(pr, pm, y, 1)
    d = float(np.mean((pr - y) ** 2 - (pm - y) ** 2))
    assert lo <= d <= hi and hi < 0.0
    assert paired_bootstrap_diff(pr[:5], pm[:5], y[:5], 1) is None
