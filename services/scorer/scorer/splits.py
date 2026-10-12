"""Temporal split (train -> embargo -> test) and deterministic group k-fold."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .config import DAY, Params


class InsufficientData(RuntimeError):
    pass


@dataclass(frozen=True)
class Split:
    data_start: float
    data_end: float
    warmup_end: float
    train_cutoffs: tuple
    train_end: float  # every label used for training is known before this instant
    embargo_days: float
    test_start: float  # first feature cutoff of the test period
    test_cutoffs: tuple
    tail_days: float  # days needed after a cutoff for its label to be fully resolved

    def describe(self) -> dict:
        return {
            "data_start": self.data_start,
            "data_end": self.data_end,
            "train_first_cutoff": self.train_cutoffs[0] if self.train_cutoffs else None,
            "train_last_cutoff": self.train_cutoffs[-1] if self.train_cutoffs else None,
            "train_end": self.train_end,
            "embargo_days": self.embargo_days,
            "test_start": self.test_start,
            "test_first_cutoff": self.test_cutoffs[0] if self.test_cutoffs else None,
            "test_last_cutoff": self.test_cutoffs[-1] if self.test_cutoffs else None,
            "n_train_cutoffs": len(self.train_cutoffs),
            "n_test_cutoffs": len(self.test_cutoffs),
        }


def make_split(data_start: float, data_end: float, params: Params, min_train: int = 3, min_test: int = 3) -> Split:
    """Layout (oldest to newest):

        |warm-up|---- train cutoffs ----|label tail|--embargo--|---- test cutoffs ----|label tail|
                                                      ^ train_end              ^ test_start

    A cutoff's label needs label_days plus the longest market life to be fully resolved (the "tail"). No label of
    a training cutoff reaches past train_end, and test cutoffs start embargo_days later, so no position spans both.
    """
    tail = (params.label_days + params.max_market_days) * DAY
    test_last = data_end - tail
    test_start = test_last - params.test_days * DAY
    train_end = test_start - params.embargo_days * DAY
    warm = data_start + params.warmup_days * DAY
    train_last = train_end - tail
    if train_last < warm:
        raise InsufficientData(
            f"history of {(data_end - data_start) / DAY:.0f} days is too short for warm-up {params.warmup_days:.0f}d, "
            f"label tail {tail / DAY:.0f}d, embargo {params.embargo_days:.0f}d and test {params.test_days:.0f}d"
        )
    tr = tuple(float(x) for x in np.arange(warm, train_last + 1e-6, params.train_stride_days * DAY))
    te = tuple(float(x) for x in np.arange(test_start, test_last + 1e-6, params.test_stride_days * DAY))
    if len(tr) < min_train or len(te) < min_test:
        raise InsufficientData(f"need at least {min_train} train and {min_test} test cutoffs, got {len(tr)} and {len(te)}")
    return Split(data_start, data_end, warm, tr, train_end, params.embargo_days, test_start, te, tail / DAY)


def group_kfold(groups: np.ndarray, k: int) -> np.ndarray:
    """Deterministic group k-fold: every group lands in exactly one fold, folds are balanced greedily.

    Returns an int array of fold ids (same length as groups). Groups are processed from largest to smallest,
    ties broken by group id, each assigned to the currently smallest fold (lowest fold id on ties).
    """
    groups = np.asarray(groups)
    uniq, inv, counts = np.unique(groups, return_inverse=True, return_counts=True)
    k = max(1, min(k, uniq.size))
    order = np.lexsort((uniq, -counts))
    load = np.zeros(k)
    fold_of_group = np.zeros(uniq.size, dtype=np.int64)
    for gi in order.tolist():
        f = int(np.argmin(load))
        fold_of_group[gi] = f
        load[f] += counts[gi]
    return fold_of_group[inv]
