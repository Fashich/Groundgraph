"""Explainable head (integer contributions, monotonicity, reasons) and the hand written GraphSAGE."""

from __future__ import annotations

import json

import numpy as np
import pytest
import torch

from scorer.config import DAY, Params
from scorer.head import Head, allocate_points, default_head, fit_head, fit_nonneg_logistic, reasons_for
from scorer.model import (
    GraphSAGE, build_snapshot, cross_val_oof, predict_sage, snapshot_percentiles, state_from_json, state_to_json, to_batch,
    train_sage,
)
from scorer.training import ModelBundle, cold_start_bundle, score_snapshot


# --------------------------------------------------------------------------- head
def test_cold_start_head_uses_the_design_weights():
    h = default_head()
    assert h.w.tolist() == [0.31, 0.26, 0.20, 0.13, 0.10]
    assert h.w.sum() == pytest.approx(1.0)
    score, pts = h.score(np.ones((1, 5)), np.zeros(1))
    assert score[0] == 100 and pts[0].tolist() == [31, 26, 20, 13, 10]


def test_contributions_are_integers_that_sum_exactly_to_the_score(rng):
    h = Head(w=np.array([1.1, 2.0, 0.7, 0.2, 0.08]), w_gnn=1.4, scale=28.0, fitted=True)
    H = rng.random((2000, 5))
    g = rng.random(2000)
    score, pts = h.score(H, g)
    assert pts.dtype.kind == "i" and score.dtype.kind == "i"
    assert (pts >= 0).all() and ((score >= 0) & (score <= 100)).all()
    assert (pts.sum(axis=1) == score).all()


def test_allocation_matches_real_values_within_one_point(rng):
    h = Head(w=np.array([1.0, 1.5, 0.5, 0.3, 0.1]), w_gnn=1.0, scale=30.0, fitted=True)
    H = rng.random((500, 5))
    g = rng.random(500)
    _, pts = h.score(H, g)
    real = h.real_points(H, g)
    assert (np.abs(pts - real) < 1.0 + 1e-9).all()


def test_largest_remainder_allocation_examples():
    out = allocate_points(np.array([[10.4, 10.4, 10.4, 0.0, 0.0], [0.5, 0.5, 0.5, 0.5, 0.0]]), np.array([31, 2]))
    assert out[0].tolist() == [11, 10, 10, 0, 0] and out[0].sum() == 31
    assert out[1].tolist() == [1, 1, 0, 0, 0]  # ties go to the lower row index
    assert allocate_points(np.zeros((1, 5)), np.array([0]))[0].sum() == 0


def test_score_is_monotone_in_every_input(rng):
    h = Head(w=np.array([1.1, 2.0, 0.7, 0.2, 0.08]), w_gnn=1.4, scale=25.0, fitted=True)
    for _ in range(200):
        H = rng.random((1, 5))
        g = rng.random(1)
        base, _ = h.score(H, g)
        for j in range(5):
            H2 = H.copy()
            H2[0, j] = min(1.0, H2[0, j] + 0.2)
            assert h.score(H2, g)[0][0] >= base[0]
        assert h.score(H, np.minimum(1.0, g + 0.2))[0][0] >= base[0]


def test_head_json_round_trip_and_row_caps():
    h = Head(w=np.array([1.0, 2.0, 0.5, 0.2, 0.08]), w_gnn=1.2, scale=20.0, smart_threshold=55.3, top_threshold=94.0, fitted=True)
    h2 = Head.from_json(json.loads(json.dumps(h.to_json())))
    assert h2.to_json() == h.to_json()
    caps = h.row_caps()
    assert caps["centrality"] == pytest.approx(20.0 * (0.2 + 1.2))
    assert caps["whale_overlap"] == pytest.approx(20.0)


def test_nonneg_logistic_has_no_negative_weights(rng):
    X = rng.random((600, 4))
    y = (X @ np.array([2.0, -3.0, 1.0, 0.0]) + rng.normal(0, 0.5, 600) > 0.2).astype(float)
    b, w = fit_nonneg_logistic(X, y)[:2]
    assert (np.asarray(w) >= -1e-9).all()


def test_fit_head_respects_floor_gnn_share_and_threshold_bounds(rng):
    n = 3000
    H = rng.random((n, 5)) ** 2
    g = rng.random(n)
    z = 1.5 * H[:, 1] + 1.0 * H[:, 2] + 0.8 * Head.g_in(g)
    y = (z + rng.normal(0, 0.4, n) > np.quantile(z, 0.92)).astype(float)
    prm = Params()
    head = fit_head(H, g, y, np.ones(n, dtype=bool), prm)
    assert head.fitted and (head.w >= prm.head_weight_floor - 1e-9).all()
    share = head.w_gnn / (head.w.sum() + head.w_gnn)
    assert share <= prm.gnn_share_cap + 1e-6
    assert head.smart_threshold <= 70.0 + 1e-9
    assert head.smart_threshold + 3.0 <= head.top_threshold <= 98.0
    score, _ = head.score(H, g)
    assert (score >= head.smart_threshold).mean() <= prm.max_flag_share + 0.03  # the flag share cap holds on training data


# --------------------------------------------------------------------------- reasons
class FT:  # the few FeatureTable fields reasons_for reads
    def __init__(self, **kw):
        self.n_whale_cp = np.array([kw.get("n_whale", 3)])
        self.n_early = np.array([kw.get("n_early", 8)])
        self.n_entries = np.array([kw.get("n_entries", 9)])
        self.hit_n = np.array([kw.get("hit_n", 12)])
        self.hit_k = np.array([kw.get("hit_k", 9)])
        self.centrality = np.array([kw.get("central", 0.95)])
        self.bridged = np.array([kw.get("bridged", 2)])
        self.lead_time_min = np.array([kw.get("lead", 47.2)])


def test_reasons_use_the_design_templates_and_the_top_three_rows():
    pts = np.array([29, 25, 8, 38, 0])
    r = reasons_for(pts, FT(), 0, 0.99, 30.0, Params())
    assert len(r) == 3
    assert r[0] == "Graph model ranks it in the top 1% of wallets, bridges 2 clusters"
    assert r[1] == "Shares 3 counterparties with known whale wallets"
    assert r[2] == "Entered 8 of last 9 markets before a 5¢+ price move"
    r2 = reasons_for(np.array([0, 10, 30, 20, 40]), FT(), 0, 0.2, 0.0, Params())
    assert r2 == ["Median lead of 47 min ahead of price moves", "75% hit rate on resolved markets (30d, n=12)",
                  "Top 5% by graph centrality, bridges 2 clusters"]


def test_a_reason_is_only_given_when_the_observation_backs_it():
    pts = np.array([30, 30, 30, 5, 5])
    r = reasons_for(pts, FT(n_whale=0, n_early=0, hit_k=0), 0, 0.1, 0.0, Params())
    assert all("counterpart" not in x and "Entered" not in x and "hit rate" not in x for x in r)
    assert reasons_for(np.zeros(5, dtype=int), FT(), 0, 0.5, 0.0, Params()) == []


# --------------------------------------------------------------------------- GraphSAGE
@pytest.fixture(scope="module")
def batch(small_ds, params):
    cut = [small_ds.start_ts + d * DAY for d in (100, 107, 114, 121)]
    snaps = [build_snapshot(small_ds, c, params, True) for c in cut]
    return to_batch(snaps)


def test_sage_forward_matches_the_dense_two_layer_formula(batch):
    torch.manual_seed(1)
    m = GraphSAGE(batch.X.shape[1], 8, 0.0).eval()
    A = batch.A.to_dense()
    x = batch.X
    h1 = torch.relu(x @ m.l1s.weight.T + m.l1s.bias + (A @ x) @ m.l1n.weight.T)
    h2 = torch.relu(h1 @ m.l2s.weight.T + m.l2s.bias + (A @ h1) @ m.l2n.weight.T)
    expected = (h2 @ m.out.weight.T + m.out.bias).squeeze(-1)
    assert torch.allclose(m(batch.X, batch.A), expected, atol=1e-5)
    assert m.l1s.out_features == 8 and GraphSAGE().l1s.out_features == 64  # hidden size 64 by default


def test_mean_aggregator_rows_are_normalised(batch):
    rs = np.asarray(batch.A.to_dense().sum(dim=1)).ravel()
    assert np.all((np.abs(rs - 1.0) < 1e-5) | (rs == 0.0))


def test_training_is_deterministic_for_a_seed_and_differs_across_seeds(batch, params):
    mask = np.isfinite(batch.y) & batch.active
    a = state_to_json(train_sage(batch, mask, params, 5))
    b = state_to_json(train_sage(batch, mask, params, 5))
    c = state_to_json(train_sage(batch, mask, params, 6))
    assert a == b
    assert a != c


def test_serialisation_round_trip_preserves_predictions(batch, params):
    mask = np.isfinite(batch.y) & batch.active
    m = train_sage(batch, mask, params, 3)
    m2 = state_from_json(json.loads(json.dumps(state_to_json(m))))
    assert np.allclose(predict_sage(m, batch), predict_sage(m2, batch), atol=1e-6)


def test_model_learns_something_on_a_training_fold(batch, params):
    from sklearn.metrics import roc_auc_score

    mask = np.isfinite(batch.y) & batch.active
    m = train_sage(batch, mask, params, 11)
    lab = mask
    auc = roc_auc_score(batch.y[lab] > 0.5, predict_sage(m, batch)[lab])
    assert auc > 0.7  # in sample on its own training data: a sanity floor, not a quality claim


def test_out_of_fold_predictions_never_use_a_wallets_own_group(batch, params):
    oof, fold = cross_val_oof(batch, params, 9)
    assert oof.shape == batch.y.shape
    for g in np.unique(batch.groups):
        assert np.unique(fold[batch.groups == g]).size == 1
    assert len(np.unique(fold)) == params.cv_folds


def test_snapshot_percentiles_are_per_snapshot(batch):
    v = np.arange(batch.y.size, dtype=float)
    pct = snapshot_percentiles(v, batch.snap, batch.active)
    assert pct[~batch.active].max() == 0.0
    for s in np.unique(batch.snap):
        sel = (batch.snap == s) & batch.active
        assert 0.0 < pct[sel].min() and pct[sel].max() < 1.0


def test_scoring_with_a_bundle_json_round_trip(small_ds, params):
    snap = build_snapshot(small_ds, small_ds.start_ts + 200 * DAY, params, False)
    cold = cold_start_bundle("demo-synthetic", 0.0)
    s1 = score_snapshot(cold, snap, params)
    again = ModelBundle.from_json(json.loads(json.dumps(cold.to_json())))
    s2 = score_snapshot(again, snap, params)
    assert (s1.score == s2.score).all() and (s1.points.sum(axis=1) == s1.score).all()
    # the smart gate needs evidence, regardless of the score
    assert not s1.smart[(snap.ft.n_entries < params.min_flag_entries)].any()
