"""Labels (computed only from the window after the cutoff), the temporal split with embargo, and group k-fold."""

from __future__ import annotations

import numpy as np
import pytest

from scorer.config import DAY, Params
from scorer.dataset import DatasetBuilder
from scorer.labels import compute_labels
from scorer.splits import InsufficientData, group_kfold, make_split
from test_features import make_positions

C = 200 * DAY  # feature cutoff
P = Params()


def label_world(rows):
    b = DatasetBuilder("test", 0.0, C + 100 * DAY)
    for k in range(6):
        b.wallet(f"w{k}", 0.0)
    ds = b.build(P)
    ds.positions = make_positions(ds, rows)
    return ds


def ev(w, ts, pnl, early, win=1):
    return dict(wallet=w, market=0, first_ts=ts, settle_ts=ts + 3 * DAY, win=win, pnl=pnl, fav_ts=ts + 600 if early else float("inf"))


def test_label_is_top_decile_pnl_and_early_rate_from_the_following_window():
    rows = []
    plan = {0: (100.0, True), 1: (80.0, False), 2: (10.0, True), 3: (-20.0, True), 4: (5.0, True)}
    for w, (pnl, early) in plan.items():
        for k in range(3):
            rows.append(ev(w, C + (k + 1) * DAY, pnl / 3, early))
    rows += [ev(5, C + DAY, 500.0, True), ev(5, C + 2 * DAY, 500.0, True)]  # only two events: unlabelled, not negative
    # noise that must not count: before the cutoff, exactly at the cutoff, after the window, unresolved
    rows += [ev(1, C - DAY, 9999.0, True), ev(1, C, 9999.0, True), ev(1, C + 14 * DAY + 1, 9999.0, True), ev(2, C + 5 * DAY, 9999.0, True, win=0)]
    lab = compute_labels(label_world(rows), C, P)
    y = lab.y
    assert y[0] == 1.0  # PnL 100 >= 0.9 quantile (92) and early rate 1
    assert list(y[1:5]) == [0.0, 0.0, 0.0, 0.0]  # w1 is in the top decile of PnL but never early
    assert np.isnan(y[5])
    assert lab.pnl_threshold == pytest.approx(92.0)
    assert lab.n_events.tolist() == [3, 3, 3, 3, 3, 2]


def test_a_event_at_the_end_of_the_window_counts_and_the_start_does_not():
    rows = [ev(0, C, 1.0, True), ev(0, C + 14 * DAY, 1.0, True), ev(0, C + 7 * DAY, 1.0, True), ev(0, C + 14 * DAY + 60, 1.0, True)]
    lab = compute_labels(label_world(rows), C, P)
    assert lab.n_events[0] == 2


def test_labels_do_not_depend_on_anything_before_the_cutoff():
    rows = [ev(w, C + (k + 1) * DAY, 10.0 * (w + 1), w % 2 == 0) for w in range(5) for k in range(3)]
    a = compute_labels(label_world(rows), C, P)
    pre = rows + [ev(w, C - (k + 1) * DAY, 1e6, True) for w in range(5) for k in range(5)]
    b = compute_labels(label_world(pre), C, P)
    assert np.array_equal(a.y, b.y, equal_nan=True)


# --------------------------------------------------------------------------- split
def test_split_has_an_embargo_and_labels_never_cross_it():
    t0, t1 = 0.0, 365 * DAY
    s = make_split(t0, t1, P)
    tail = (P.label_days + P.max_market_days) * DAY
    assert s.train_cutoffs[0] == t0 + P.warmup_days * DAY
    # the last training label (cutoff + tail) is known before train_end
    assert s.train_cutoffs[-1] + tail <= s.train_end + 1e-6
    # test features start only after the embargo
    assert s.test_cutoffs[0] - s.train_end >= P.embargo_days * DAY - 1e-6
    # every test label is resolved before the data ends
    assert s.test_cutoffs[-1] + tail <= t1 + 1e-6
    assert max(s.train_cutoffs) < min(s.test_cutoffs)
    # no training cutoff can see a position that belongs to a test cutoff's label window or vice versa
    assert s.train_cutoffs[-1] + P.label_days * DAY < s.test_cutoffs[0]


def test_split_refuses_short_histories():
    with pytest.raises(InsufficientData):
        make_split(0.0, 120 * DAY, P)


def test_group_kfold_keeps_groups_together_and_is_balanced_and_deterministic():
    rng = np.random.default_rng(3)
    groups = rng.integers(0, 40, size=500)
    f1 = group_kfold(groups, 4)
    f2 = group_kfold(groups.copy(), 4)
    assert np.array_equal(f1, f2)
    for g in np.unique(groups):
        assert np.unique(f1[groups == g]).size == 1  # a group never straddles two folds
    sizes = np.bincount(f1)
    assert sizes.size == 4 and sizes.max() - sizes.min() <= np.bincount(groups).max()


def test_group_kfold_with_fewer_groups_than_folds():
    f = group_kfold(np.array([0, 0, 1, 1, 1]), 4)
    assert set(f.tolist()) == {0, 1} and f[0] == f[1] and f[2] == f[3] == f[4]
