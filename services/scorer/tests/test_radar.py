"""Radar formula: hand computed values, rounding, sybil cap, building rule, golden vectors and the TypeScript SDK."""

from __future__ import annotations

import json
import math
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

from scorer.config import Params
from scorer.radar import (
    Calibrator, RadarPos, ci_points, finalize, fit_isotonic, identity_calibrator, js_round, radar_raw,
)

HERE = Path(__file__).parent
VECTORS = json.loads((HERE / "radar_vectors.json").read_text())["cases"]
P = Params()


def pos(n, side=1, hit=0.7, usd=10_000.0, sybil=False):
    return [RadarPos(usd, side, hit, sybil) for _ in range(n)]


def test_known_value_four_sharp_wallets_on_above():
    # sy = 1, hr = 0.7, sig = 1 * 0.4 = 0.4, logit = 1.4 * 4/10 * 0.4 = 0.224, p = 1 / (1 + e^-0.224)
    r = radar_raw(0.5, pos(4), None, P)
    p = 1.0 / (1.0 + math.exp(-0.224))
    assert r["state"] == "ready" and r["n"] == 4
    assert r["p_raw"] == pytest.approx(p, abs=1e-12)
    assert r["ci_pts"] == max(2, js_round(164 * math.sqrt(p * (1 - p) / 26)))
    assert r["ci_pts"] == 16  # 164 * sqrt(0.5557 * 0.4443 / 26) = 15.98
    assert r["edge_cents"] == js_round(100 * (p - 0.5)) == 6


def test_weights_use_sqrt_of_usd_and_hit_offset():
    # two wallets ABOVE with usd 100 and 400 (sqrt 10 and 20), one BELOW with usd 900 (sqrt 30), equal hit rates
    r = radar_raw(0.5, [RadarPos(100, 1, 0.6), RadarPos(400, 1, 0.6), RadarPos(900, -1, 0.6)], None, P)
    w_above, w_below = (10 + 20) * 1.0, 30 * 1.0
    assert r["s_y"] == pytest.approx(w_above / (w_above + w_below))
    assert r["s_y"] == pytest.approx(0.5)
    assert r["sig"] == pytest.approx(0.0, abs=1e-12)
    assert r["p_raw"] == pytest.approx(0.5, abs=1e-12)


def test_sybil_weight_is_capped_at_half():
    # three sybil ABOVE wallets against three honest BELOW wallets with identical size and hit rate: the sybil side
    # carries exactly half the weight, so s_y = 0.5 / (0.5 + 1) = 1/3
    flagged = pos(3, 1, 0.8, 10_000, True) + pos(3, -1, 0.8, 10_000, False)
    r = radar_raw(0.5, flagged, None, P)
    assert r["s_y"] == pytest.approx(1.0 / 3.0, abs=1e-12)
    assert r["p_raw"] < 0.5
    # and without the flag the book is balanced
    plain = radar_raw(0.5, pos(3, 1, 0.8) + pos(3, -1, 0.8), None, P)
    assert plain["s_y"] == pytest.approx(0.5, abs=1e-12)
    assert plain["p_raw"] == pytest.approx(0.5, abs=1e-12)


def test_sybil_cap_is_exactly_one_half_of_the_weight():
    one = radar_raw(0.5, [RadarPos(10_000, 1, 0.8, True), RadarPos(10_000, -1, 0.8, False), RadarPos(10_000, -1, 0.8, False)], None, P)
    w = math.sqrt(10_000) * (0.4 + 0.8)
    assert one["s_y"] == pytest.approx(0.5 * w / (0.5 * w + 2 * w), abs=1e-12)


def test_no_skill_signal_when_hit_rate_is_one_half():
    r = radar_raw(0.37, pos(6, 1, 0.5), None, P)
    assert r["p_raw"] == pytest.approx(0.37, abs=1e-12)
    assert r["edge_cents"] == 0


def test_direction_follows_the_flagged_side_and_flips_symmetrically():
    up = radar_raw(0.4, pos(5, 1, 0.8), None, P)
    dn = radar_raw(0.6, pos(5, -1, 0.8), None, P)
    assert up["p_raw"] > 0.4 and dn["p_raw"] < 0.6
    assert up["p_raw"] == pytest.approx(1.0 - dn["p_raw"], abs=1e-12)
    assert up["edge_cents"] == -dn["edge_cents"] or abs(up["edge_cents"] + dn["edge_cents"]) <= 1


@pytest.mark.parametrize("n,ready", [(0, False), (1, False), (2, False), (3, True), (10, True)])
def test_building_state_needs_three_flagged_wallets(n, ready):
    r = radar_raw(0.5, pos(n), None, P)
    assert (r["state"] == "ready") is ready
    if not ready:
        assert r["p_raw"] is None and r["ci_pts"] is None and r["edge_cents"] is None


def test_building_state_needs_ten_scored_trades():
    assert radar_raw(0.5, pos(5), 9, P)["state"] == "building"
    assert radar_raw(0.5, pos(5), 10, P)["state"] == "ready"


def test_confidence_interval_floor_and_shrinkage():
    assert ci_points(0.5, 4) == 16
    assert ci_points(0.5, 1000) == 2  # never below 2 points
    assert ci_points(0.02, 3) >= 2
    widths = [ci_points(0.5, n) for n in (3, 6, 12, 24, 48)]
    assert widths == sorted(widths, reverse=True)


@pytest.mark.parametrize("x,expected", [(0.5, 1), (1.5, 2), (2.5, 3), (-0.5, 0), (-1.5, -1), (-2.5, -2), (2.4999, 2), (-2.5001, -3)])
def test_rounding_is_half_up_like_javascript_math_round(x, expected):
    assert js_round(x) == expected


def test_market_price_clamp_only_touches_the_logit():
    r0 = radar_raw(0.0, pos(5, 1, 0.8), None, P)
    r1 = radar_raw(1e-6, pos(5, 1, 0.8), None, P)
    assert r0["p_raw"] == pytest.approx(r1["p_raw"], rel=1e-12)  # same clamped logit
    assert r0["p_market"] == 0.0  # the edge is measured against the real market price
    assert r0["edge_cents"] == js_round(100 * r0["p_raw"])


def test_sizes_are_floored_and_hit_rates_clamped():
    r = radar_raw(0.5, [RadarPos(-500, 1, 0.9), RadarPos(100, -1, 1.7), RadarPos(100, -1, -0.3), RadarPos(100, -1, 0.5)], None, P)
    w_neg = 0.0
    w = [math.sqrt(100) * (0.4 + 1.0), math.sqrt(100) * (0.4 + 0.0), math.sqrt(100) * 0.9]
    assert r["s_y"] == pytest.approx(w_neg / (w_neg + sum(w)), abs=1e-12)


# --------------------------------------------------------------------------- golden vectors
def test_there_are_at_least_fifty_vectors():
    assert len(VECTORS) >= 50
    assert sum(1 for c in VECTORS if c["expected"]["state"] == "building") >= 3
    assert sum(1 for c in VECTORS if c["expected"]["state"] == "ready") >= 40


@pytest.mark.parametrize("case", VECTORS, ids=[c["name"] for c in VECTORS])
def test_golden_vectors_replay(case):
    flagged = [RadarPos(f["positionUsd"], 1 if f["side"] == "above" else -1, f["hitRate"], f["sybil"]) for f in case["flagged"]]
    r = radar_raw(case["pMarket"], flagged, None, P)
    e = case["expected"]
    assert (r["state"], r["n"]) == (e["state"], e["n"])
    if e["state"] == "ready":
        assert r["p_raw"] == e["p"]  # same code, same machine: exact
        assert (r["ci_pts"], r["edge_cents"]) == (e["ci"], e["edge"])


def _tsx() -> Path | None:
    root = HERE.parents[2]
    for c in (root / "packages/sdk/node_modules/.bin/tsx", root / "services/api/node_modules/.bin/tsx", root / "node_modules/.bin/tsx"):
        if c.exists():
            return c
    return None


@pytest.mark.skipif(_tsx() is None or shutil.which("node") is None, reason="node or tsx is not installed")
def test_vectors_match_the_typescript_sdk():
    """Runs packages/sdk/src/radar.ts on every vector: state, n, ci and edge exactly, p to 1e-12 (V8 and glibc exp/log
    can differ by one ulp; observed max relative difference is about 2e-16)."""
    tsx = _tsx()
    out = subprocess.run([str(tsx), str(HERE / "radar_ts_check.mts"), str(HERE / "radar_vectors.json")],
                         capture_output=True, text=True, timeout=120, cwd=str(HERE.parents[2] / "packages" / "sdk"))
    assert out.returncode == 0, out.stderr[-500:]
    res = json.loads(out.stdout.strip().splitlines()[-1])
    assert res["total"] == len(VECTORS)
    assert res["mismatches"] == 0, res["first"]
    assert res["maxRelDiffP"] < 1e-12


# --------------------------------------------------------------------------- calibration
def test_identity_calibrator_and_small_samples():
    assert identity_calibrator().apply(0.37) == 0.37
    cal = fit_isotonic(np.array([0.2, 0.8]), np.array([0.0, 1.0]), 60)
    assert cal.kind == "identity"  # fewer than 60 settled markets: no calibration
    assert cal.ident() == "identity"


def test_isotonic_calibrator_is_monotone_bounded_and_serialisable(rng):
    p = rng.uniform(0.02, 0.98, size=400)
    y = (rng.random(400) < p).astype(float)
    cal = fit_isotonic(p, y, 60)
    assert cal.kind == "isotonic" and cal.n == 400
    grid = np.linspace(0, 1, 101)
    out = np.array([cal.apply(v) for v in grid])
    assert np.all(np.diff(out) >= -1e-12)
    assert out.min() >= 0.01 - 1e-12 and out.max() <= 0.99 + 1e-12
    again = Calibrator.from_json(json.loads(json.dumps(cal.to_json())))
    assert [again.apply(v) for v in grid] == list(out)
    assert again.ident() == cal.ident() and cal.ident().startswith("iso-")


def test_finalize_recomputes_interval_and_edge_from_the_calibrated_probability():
    raw = radar_raw(0.30, pos(8, 1, 0.8), None, P)
    cal = Calibrator([0.0, 1.0], [0.2, 0.6], 100, "isotonic")
    out = finalize(raw, cal, P)
    assert out["p"] == pytest.approx(0.2 + 0.4 * raw["p_raw"])
    assert out["edge_cents"] == js_round(100 * (out["p"] - 0.30))
    assert out["ci_pts"] == ci_points(out["p"], 8, P)
    assert finalize(radar_raw(0.5, pos(2)), cal, P)["state"] == "building"
