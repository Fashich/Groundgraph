"""Louvain determinism, behaviour based names, stable ids, sybil clusters (x0.5 weight cap) and the 3D layout."""

from __future__ import annotations

import dataclasses
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
import scipy.sparse as sp

from scorer.clusters import louvain_communities, merge_small, name_communities, stabilize_ids, sybil_assignments
from scorer.config import DAY, Params
from scorer.dataset import DatasetBuilder
from scorer.features import compute_features
from scorer.funding import ancestors, funder_fanout, funding_groups, sybil_cluster_id, sybil_groups
from scorer.layout import LIMIT, fibonacci_centers, layout_wallets
from scorer.radar import RadarPos, radar_raw

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def ft(small_ds, params):
    return compute_features(small_ds, small_ds.end_ts, params)


# --------------------------------------------------------------------------- Louvain
def test_louvain_is_deterministic_for_a_fixed_seed(ft, params):
    a = louvain_communities(ft, params, 20261012)
    b = louvain_communities(ft, params, 20261012)
    assert np.array_equal(a, b)
    assert np.unique(a[a >= 0]).size >= 3


def test_louvain_is_identical_across_processes_with_different_hash_seeds():
    code = (
        "import sys, hashlib, dataclasses\n"
        "from scorer.config import Params\n"
        "from scorer.sources.synthetic import SyntheticConfig, SyntheticSource\n"
        "from scorer.features import compute_features\n"
        "from scorer.clusters import louvain_communities\n"
        "p = dataclasses.replace(Params(), sage_epochs=5)\n"
        "ds = SyntheticSource(SyntheticConfig(n_wallets=80, days=120, sybil_groups=(3,)), p).build_dataset(1791808200.0)\n"
        "ft = compute_features(ds, ds.end_ts, p)\n"
        "c = louvain_communities(ft, p, 7)\n"
        "print(hashlib.sha256(c.tobytes()).hexdigest())\n"
    )
    outs = []
    for hs in ("0", "1", "12345"):
        env = dict(os.environ, PYTHONHASHSEED=hs, PYTHONPATH=str(ROOT))
        r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env, timeout=240, cwd=str(ROOT))
        assert r.returncode == 0, r.stderr[-400:]
        outs.append(r.stdout.strip().splitlines()[-1])
    assert len(set(outs)) == 1


def test_communities_recover_the_planted_behaviour_clusters(ft, small_ds, params):
    """Not a quality claim about real data: on the synthetic world the planted clusters are recoverable (purity)."""
    comm = louvain_communities(ft, params, params.seed)
    lat = small_ds.meta["latent"]
    known = np.array([small_ds.nodes[w] in lat for w in ft.wallets.tolist()])  # whales are in the universe but have no cluster
    truth = np.array([lat[small_ds.nodes[w]]["cluster"] if small_ds.nodes[w] in lat else 0 for w in ft.wallets.tolist()])
    ok = (comm >= 0) & known
    purity = sum(np.bincount(truth[ok & (comm == c)]).max() for c in np.unique(comm[ok])) / ok.sum()
    assert purity > 0.5  # chance level with 6 unequal clusters is about 0.26


def test_small_communities_are_merged_and_all_wallets_with_edges_keep_a_community(ft, params):
    comm = louvain_communities(ft, params, params.seed)
    merged = merge_small(comm, ft, 6)
    sizes = np.bincount(merged[merged >= 0])
    assert sizes[sizes > 0].min() >= 6
    assert ((merged >= 0) == (comm >= 0)).all()


def test_names_come_from_the_design_list_and_duplicates_get_ordinals():
    from scorer.clusters import _STATS

    stats = {0: {k: 0.0 for k in _STATS}, 1: {k: 0.0 for k in _STATS}, 2: {k: 0.0 for k in _STATS}}
    uni = {k: (0.0, 1.0) for k in _STATS}
    names = name_communities(stats, uni, {0: 30, 1: 20, 2: 10})
    allowed = ("Early LP cohort", "Momentum desks", "MEV searchers", "Treasury rotators", "Retail flow", "Airdrop farmers")
    assert len(set(names.values())) == 3  # identical statistics give the same base name, made unique by ordinals
    assert all(any(n.startswith(a) for a in allowed) for n in names.values())
    assert names[0] in allowed  # the largest community keeps the plain name


def test_stable_ids_follow_the_overlap_with_the_previous_run():
    prev = {"a": 4, "b": 4, "c": 4, "d": 7, "e": 7, "f": 7}
    members = {0: ["a", "b", "c", "x"], 1: ["d", "e", "f"], 2: ["y", "z"]}
    ids = stabilize_ids(members, prev)
    assert ids[0] == 4 and ids[1] == 7 and ids[2] > 7
    again = stabilize_ids({5: ["d", "e", "f"], 6: ["a", "b", "c"]}, prev)
    assert again == {5: 7, 6: 4}  # ids follow membership, not the raw label
    assert sorted(stabilize_ids({0: ["p", "q"], 1: ["r"]}, {}).values()) == [1, 2]


# --------------------------------------------------------------------------- sybil clusters
def funding_world(hub_size=0):
    P = Params()
    b = DatasetBuilder("test", 0.0, 100 * DAY)
    # operator O funds w1, w2, w3 directly; w4 is funded by an intermediary I that O funds (two hops); w5 by another operator
    for w, f in [("w1", "O"), ("w2", "O"), ("w3", "O"), ("w4", "I"), ("w5", "O2"), ("w6", "O2")]:
        b.wallet(w, 0.0, f)
    b.node("I", 0.0, "O")
    for k in range(hub_size):
        b.wallet(f"h{k:03d}", 0.0, "HUB")
    return b.build(P), P


def test_three_flagged_wallets_with_one_funder_form_a_sybil_cluster():
    ds, P = funding_world()
    ix = ds.index
    flagged = np.array([ix["w1"], ix["w2"], ix["w3"]])
    groups = sybil_groups(ds, flagged, P)
    assert set(groups) == set(flagged.tolist()) and set(groups.values()) == {"O"}
    # two flagged wallets are not enough
    assert sybil_groups(ds, flagged[:2], P) == {}
    # funding two hops away counts: w4 -> I -> O
    g2 = sybil_groups(ds, np.array([ix["w1"], ix["w2"], ix["w4"]]), P)
    assert set(g2.values()) == {"O"} and len(g2) == 3
    # unflagged wallets are never part of a cluster, whatever their funder
    assert sybil_groups(ds, np.array([ix["w1"], ix["w2"], ix["w5"]]), P) == {}
    assert ancestors(ds, ix["w4"], 2) == ["I", "O"] and ancestors(ds, ix["w4"], 1) == ["I"]


def test_exchange_like_hubs_do_not_create_sybil_clusters():
    ds, P = funding_world(hub_size=60)
    ix = ds.index
    hubs = np.array([ix[f"h{k:03d}"] for k in range(10)])
    assert funder_fanout(ds)["HUB"] == 60 > P.sybil_max_fanout
    assert sybil_groups(ds, hubs, P) == {}
    grp = funding_groups(ds, ds.wallet_ids(), P)
    assert len({int(grp[list(ds.wallet_ids()).index(h)]) for h in hubs}) == 10  # hub funded wallets stay in separate CV groups


def test_sybil_cluster_id_is_stable_positive_and_distinct():
    assert sybil_cluster_id("O") == sybil_cluster_id("O") > 0
    assert sybil_cluster_id("O") != sybil_cluster_id("O2")
    assert sybil_cluster_id("O") < 2 ** 31


def test_sybil_members_carry_half_weight_in_the_radar():
    """End to end contract: a wallet inside a sybil cluster is passed to the radar with sybil=True and counts x0.5."""
    ds, P = funding_world()
    ix = ds.index
    sy = sybil_groups(ds, np.array([ix["w1"], ix["w2"], ix["w3"]]), P)
    pos = [RadarPos(10_000.0, 1, 0.8, w in sy) for w in (ix["w1"], ix["w2"], ix["w3"])] + [RadarPos(10_000.0, -1, 0.8, False)] * 3
    r = radar_raw(0.5, pos, None, P)
    assert r["s_y"] == pytest.approx(1.0 / 3.0, abs=1e-12)  # 3 * 0.5 w against 3 * 1.0 w


def test_synthetic_sybil_operators_are_found_among_flagged_wallets(small_ds, params, ft):
    lat = small_ds.meta["latent"]
    in_group = np.array([lat.get(small_ds.nodes[w], {"sybil_group": -1})["sybil_group"] for w in ft.wallets.tolist()])
    smart = in_group >= 0  # pretend every planted sybil wallet was flagged
    out = sybil_assignments(small_ds, ft, smart, params)
    assert len(out) == int(smart.sum())
    assert len(set(out.values())) == len(set(in_group[smart].tolist()))
    smart_none = np.zeros(ft.wallets.size, dtype=bool)
    assert sybil_assignments(small_ds, ft, smart_none, params) == {}


# --------------------------------------------------------------------------- layout
def test_layout_stays_inside_the_cube_and_is_deterministic():
    rng = np.random.default_rng(5)
    n = 300
    addr = [f"addr{i:04d}" for i in range(n)]
    cl = rng.integers(0, 6, size=n)
    smart = rng.random(n) < 0.15
    rows, cols = rng.integers(0, n, 900), rng.integers(0, n, 900)
    A = sp.csr_matrix((np.ones(900), (rows, cols)), shape=(n, n))
    A = (A + A.T).tocsr()
    p1 = layout_wallets(addr, cl, smart, A)
    p2 = layout_wallets(addr, cl, smart, A)
    assert np.array_equal(p1, p2)
    assert p1.shape == (n, 3) and np.abs(p1).max() <= LIMIT + 1e-9 and np.isfinite(p1).all()
    # clusters occupy different regions: distance between centroids exceeds the spread inside them
    cent = np.array([p1[cl == c].mean(axis=0) for c in range(6)])
    spread = np.mean([np.linalg.norm(p1[cl == c] - cent[c], axis=1).mean() for c in range(6)])
    d = np.mean([np.linalg.norm(cent[i] - cent[j]) for i in range(6) for j in range(i + 1, 6)])
    assert d > spread


def test_fibonacci_centres_are_spread_over_the_sphere():
    c = fibonacci_centers(6)
    assert c.shape == (6, 3) and np.abs(c).max() <= 1.2
    dmin = min(np.linalg.norm(c[i] - c[j]) for i in range(6) for j in range(i + 1, 6))
    assert dmin > 0.5
