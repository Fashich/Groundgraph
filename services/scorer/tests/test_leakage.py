"""No look-ahead: features at a cutoff must be identical when everything after the cutoff is removed or scrambled."""

from __future__ import annotations

import dataclasses

import numpy as np
import pytest

from scorer.config import DAY
from scorer.features import compute_features
from scorer.labels import compute_labels
from scorer.model import build_snapshot
from scorer.prices import PriceSeries
from scorer.splits import make_split

FIELDS = ("whale_overlap", "entry_timing", "hit_rate", "centrality", "lead_time_min", "n_markets", "n_cp", "n_whale_cp",
          "n_entries", "n_early", "hit_n", "hit_k", "degree", "trade_rate", "median_size", "pagerank")


def cutoffs(ds):
    return [ds.start_ts + d * DAY for d in (90, 140, 200)]


def assert_same_features(a, b, ctx=""):
    assert np.array_equal(a.active, b.active), ctx
    for f in FIELDS:
        x, y = getattr(a, f), getattr(b, f)
        assert np.allclose(x, y, rtol=1e-9, atol=1e-12), f"{ctx}: feature {f} differs"


def scramble_future(ds, as_of, params, seed=99):
    """A copy of the dataset whose trades, edges, balances and prices after as_of are replaced by different random data."""
    rng = np.random.default_rng(seed)
    t_after = ds.t_ts > as_of
    e_after = ds.e_ts > as_of
    b_after = ds.b_ts > as_of
    t_side = np.where(t_after, rng.choice([-1, 1], size=ds.t_side.size), ds.t_side).astype(ds.t_side.dtype)
    t_usd = np.where(t_after, ds.t_usd * rng.uniform(0.2, 5.0, ds.t_usd.size), ds.t_usd)
    t_wallet = np.where(t_after, rng.choice(ds.wallet_ids(), size=ds.t_wallet.size), ds.t_wallet).astype(ds.t_wallet.dtype)
    e_usd = np.where(e_after, ds.e_usd * rng.uniform(0.1, 9.0, ds.e_usd.size), ds.e_usd)
    e_dst = np.where(e_after, rng.choice(ds.wallet_ids(), size=ds.e_dst.size), ds.e_dst).astype(ds.e_dst.dtype)
    b_usd = np.where(b_after, ds.b_usd * rng.uniform(0.01, 100.0, ds.b_usd.size), ds.b_usd)
    prices = {}
    for a, ps in ds.prices.items():
        k = int(ps.idx(as_of))
        px = ps.px.copy()
        if k + 1 < px.size:
            px[k + 1:] = px[k] * np.exp(np.cumsum(rng.normal(0.0, 0.02, px.size - k - 1)))
        prices[a] = PriceSeries(a, ps.t0, ps.step, px, ps.default_vol)
    alt = dataclasses.replace(ds, t_side=t_side, t_usd=t_usd, t_wallet=t_wallet, e_usd=e_usd, e_dst=e_dst, b_usd=b_usd,
                              prices=prices, markets=[], positions=None, _index=None)
    return alt.finalize(params)


@pytest.mark.parametrize("day", [90, 140, 200])
def test_features_unchanged_when_the_future_is_removed(small_ds, params, day):
    as_of = small_ds.start_ts + day * DAY
    full = compute_features(small_ds, as_of, params)
    cut = compute_features(small_ds.truncate(as_of, params), as_of, params)
    assert full.wallets.tolist() == cut.wallets.tolist()
    assert_same_features(full, cut, f"truncate@{day}")
    assert full.active.sum() > 20 and full.hit_n.sum() > 0 and full.n_entries.sum() > 0  # the comparison is not vacuous


@pytest.mark.parametrize("day", [100, 180])
def test_features_unchanged_when_the_future_is_scrambled(small_ds, params, day):
    as_of = small_ds.start_ts + day * DAY
    base = compute_features(small_ds, as_of, params)
    alt_ds = scramble_future(small_ds, as_of, params)
    assert not np.array_equal(alt_ds.t_side, small_ds.t_side)  # the scramble really changed the future
    alt = compute_features(alt_ds, as_of, params)
    assert_same_features(base, alt, f"scramble@{day}")


def test_snapshot_inputs_do_not_depend_on_labels_or_the_future(small_ds, params):
    as_of = small_ds.start_ts + 150 * DAY
    a = build_snapshot(small_ds, as_of, params, with_labels=False)
    b = build_snapshot(scramble_future(small_ds, as_of, params), as_of, params, with_labels=True)
    assert np.allclose(a.X, b.X, atol=1e-12) and np.allclose(a.H, b.H, atol=1e-12)
    assert np.allclose(a.A.toarray(), b.A.toarray(), atol=1e-12)
    assert np.isnan(a.y).all() and np.isfinite(b.y).any()


def test_labels_do_depend_on_the_future_by_construction(small_ds, params):
    as_of = small_ds.start_ts + 150 * DAY
    a = compute_labels(small_ds, as_of, params)
    b = compute_labels(scramble_future(small_ds, as_of, params), as_of, params)
    assert not np.array_equal(a.y, b.y, equal_nan=True)  # sanity: the scramble does reach the labels


def test_training_labels_resolve_before_the_test_period_starts(small_ds, params):
    split = make_split(small_ds.start_ts, small_ds.end_ts, params)
    pos = small_ds.positions
    for c in split.train_cutoffs:
        m = (pos.first_ts > c) & (pos.first_ts <= c + params.label_days * DAY) & (pos.win != 0)
        assert (pos.settle_ts[m] <= split.train_end + 1e-6).all(), f"label of cutoff {c} leaks past train_end"
    assert split.test_cutoffs[0] >= split.train_end + params.embargo_days * DAY - 1e-6
    # nothing that trains the model is observed at or after the first test cutoff
    last_train_obs = max(split.train_cutoffs) + (params.label_days + params.max_market_days) * DAY
    assert last_train_obs <= split.test_start - params.embargo_days * DAY + 1e-6
