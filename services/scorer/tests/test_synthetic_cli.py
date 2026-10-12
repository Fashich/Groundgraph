"""Synthetic source (demo only), CLI refusal without DEMO_MODE, the scheduler loop with a fake clock, and a text lint."""

from __future__ import annotations

import io
import json
import re
import subprocess
import sys
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

import numpy as np
import pytest

from scorer import cli, loop, pipeline, store
from scorer.config import DS_SYNTHETIC, Params, Settings
from scorer.sources import b58decode
from scorer.sources.synthetic import SyntheticConfig, SyntheticSource, hash_str

ROOT = Path(__file__).resolve().parents[1]


# --------------------------------------------------------------------------- synthetic world
def test_world_is_labelled_deterministic_and_has_valid_addresses(small_cfg, params, small_ds):
    again = SyntheticSource(small_cfg, params).build_dataset(1791808200.0)
    assert small_ds.label == DS_SYNTHETIC == "demo-synthetic"
    assert small_ds.nodes == again.nodes
    for f in ("t_ts", "t_usd", "t_side", "t_wallet", "e_ts", "e_usd", "b_usd"):
        assert np.array_equal(getattr(small_ds, f), getattr(again, f)), f
    for a in small_ds.nodes:
        assert 32 <= len(a) <= 44 and len(b58decode(a)) == 32  # decodes to a 32 byte public key like a real address


def test_prices_do_not_explode_or_collapse(small_ds):
    """Regression: a sign error once made every jump positive and prices grew by a factor of 100000 in a year."""
    for a, ps in small_ds.prices.items():
        ratio = ps.px[-1] / ps.px[0]
        assert 0.02 < ratio < 50, (a, ratio)
        r = np.diff(np.log(ps.px))
        assert (r > 0.02).sum() > 0 and (r < -0.02).sum() > 0  # up and down jumps both occur


def test_outcomes_of_virtual_markets_are_not_one_sided(small_ds):
    out = np.array([m.outcome for m in small_ds.markets if m.outcome != 0])
    assert out.size > 50 and 0.2 < (out > 0).mean() < 0.8


def test_planted_structure_is_there_but_not_trivially_separable(small_ds, params):
    from scorer.features import compute_features

    ft = compute_features(small_ds, small_ds.end_ts, params)
    lat = small_ds.meta["latent"]
    informed = np.array([lat.get(small_ds.nodes[w], {"informed": False})["informed"] for w in ft.wallets.tolist()])
    assert 0.1 < informed.mean() < 0.6
    assert ft.entry_timing[informed & ft.active].mean() > ft.entry_timing[~informed & ft.active].mean()
    assert small_ds.meta["operators"] and len(small_ds.meta["whales"]) == 6


def test_current_positions_are_deterministic_per_market(small_ds, small_cfg, params):
    from fixtures import FIXTURE_MARKETS, NOW
    from scorer.types import OpenMarket

    ms = [OpenMarket(m[0], m[1], NOW.timestamp() - 3 * 86400, NOW.timestamp() + 20 * 86400, NOW.timestamp() + 21 * 86400, m[2], m[3]) for m in FIXTURE_MARKETS]
    src = SyntheticSource(small_cfg, params)
    a = src.current_positions(small_ds, ms, NOW.timestamp())
    b = src.current_positions(small_ds, list(reversed(ms)), NOW.timestamp())
    assert [(r.market_id, r.wallet, r.side, r.usdc) for r in a] == [(r.market_id, r.wallet, r.side, r.usdc) for r in b]
    assert a and all(r.data_source == "demo-synthetic" and r.usdc >= 1e6 for r in a)
    assert hash_str("abc") == hash_str("abc")


# --------------------------------------------------------------------------- DEMO_MODE guard and CLI
def test_settings_refuse_synthetic_without_demo_mode():
    off = Settings.from_env({"DEMO_MODE": "false"})
    with pytest.raises(PermissionError, match="DEMO_MODE"):
        off.check_source("synthetic")
    assert off.check_source("helius") == "helius" and off.check_source("onchain") == "onchain"
    on = Settings.from_env({"DEMO_MODE": "true"})
    assert on.check_source("synthetic") == "synthetic"
    assert Settings.from_env({"DEMO_MODE": "TRUE"}).demo_mode and not Settings.from_env({}).demo_mode
    with pytest.raises(ValueError):
        on.check_source("nonsense")


@pytest.mark.parametrize("cmd", ["run-once", "train", "loop", "run"])
def test_cli_refuses_synthetic_without_demo_mode_before_touching_the_database(cmd):
    out, err = io.StringIO(), io.StringIO()
    argv = [cmd, "--source", "synthetic"] + (["--once"] if cmd == "run" else [])
    with redirect_stdout(out), redirect_stderr(err):
        code = cli.main(argv, env={"DEMO_MODE": "false", "DATABASE_URL": "postgres://nobody:none@127.0.0.1:1/none"})
    assert code == 2 and "refused" in err.getvalue() and "DEMO_MODE" in err.getvalue()


def test_cli_refuses_when_the_source_comes_from_the_environment():
    err = io.StringIO()
    with redirect_stderr(err):
        code = cli.main(["run-once"], env={"SCORER_SOURCE": "synthetic", "DEMO_MODE": "", "DATABASE_URL": "postgres://nobody:none@127.0.0.1:1/none"})
    assert code == 2


def test_module_entry_point_reports_the_refusal_with_exit_code_2():
    env = {"PATH": "/usr/bin:/bin", "PYTHONPATH": str(ROOT), "DEMO_MODE": "false", "DATABASE_URL": "postgres://nobody:none@127.0.0.1:1/none"}
    r = subprocess.run([sys.executable, "-m", "scorer", "run-once", "--source", "synthetic"], capture_output=True, text=True, env=env, cwd=str(ROOT), timeout=60)
    assert r.returncode == 2 and "refused" in r.stderr


def test_cli_has_the_documented_commands():
    parser = cli.build_parser()
    for argv in (["run-once"], ["run", "--once"], ["train"], ["radar"], ["track-record"], ["loop"], ["run-once", "--source", "helius", "--now", "2026-10-12T12:30:00Z"]):
        parser.parse_args(argv)
    assert cli._now("2026-10-12T12:30:00Z") == 1791808200.0


# --------------------------------------------------------------------------- loop
class FakeConn:
    closed = False

    def rollback(self):
        pass

    def close(self):
        self.closed = True


def run_fake_loop(monkeypatch, source, ticks, interval_overrides=None, have_model=True, failing=None):
    state = {"meta": {}, "bundle": object() if have_model else None}
    jobs = []
    t = {"now": 1_000_000.0}

    def fake_run_full(conn, settings, params, src, now, force_train=False, with_track=True):
        jobs.append(("train+full" if force_train else "full", now, with_track))
        state["meta"]["last_full_run_ts"] = now
        if force_train or state["bundle"] is None:
            state["meta"]["last_train_ts"] = now
            state["bundle"] = object()
        if with_track:
            state["meta"]["last_track_ts"] = now
        return {}

    class R:
        n_markets = 0

    def fake_track(conn, settings, params, src, now, ds=None):
        jobs.append(("track", now, None))
        state["meta"]["last_track_ts"] = now
        return R()

    calls = {"n": 0}

    def fake_radar(conn, settings, params, now):
        calls["n"] += 1
        if failing and calls["n"] in failing:
            jobs.append(("radar-fail", now, None))
            raise RuntimeError("boom")
        jobs.append(("radar", now, None))
        return []

    monkeypatch.setattr(pipeline, "run_full", fake_run_full)
    monkeypatch.setattr(pipeline, "track_record_only", fake_track)
    monkeypatch.setattr(pipeline, "radar_refresh", fake_radar)
    monkeypatch.setattr(pipeline, "load_meta", lambda conn, label: state["meta"])
    monkeypatch.setattr(pipeline, "load_bundle", lambda conn, label: state["bundle"])
    import contextlib

    @contextlib.contextmanager
    def lock(conn, name):
        yield True

    monkeypatch.setattr(store, "advisory_lock", lock)
    settings = Settings.from_env({"DEMO_MODE": "true", **(interval_overrides or {})})
    sleeps = []

    def sleep(s):
        sleeps.append(s)
        t["now"] += s

    executed = loop.run_loop(settings, Params(), source, connect=lambda url: FakeConn(), now_fn=lambda: t["now"], sleep_fn=sleep, max_ticks=ticks)
    return executed, jobs, sleeps, t


def test_loop_runs_radar_every_minute_and_the_full_run_every_hour(monkeypatch):
    executed, jobs, sleeps, t = run_fake_loop(monkeypatch, "synthetic", ticks=125, have_model=False)
    kinds = [j[0] for j in jobs]
    assert kinds[0] == "train+full"  # no model yet: the first tick trains
    assert kinds.count("train+full") == 1  # weekly retrain is not due again within two hours
    assert kinds.count("full") == 2  # hourly runs at t+1h and t+2h
    assert kinds.count("radar") == 126 - 0 or kinds.count("radar") >= 120  # one radar refresh per minute
    assert all(abs(s - 60.0) < 1e-6 for s in sleeps)
    radar_times = [j[1] for j in jobs if j[0] == "radar"]
    assert all(abs((b - a) - 60.0) < 1e-6 for a, b in zip(radar_times, radar_times[1:]))


def test_loop_retrains_weekly_and_runs_the_track_record_nightly(monkeypatch):
    executed, jobs, sleeps, t = run_fake_loop(monkeypatch, "synthetic", ticks=3, interval_overrides={"RADAR_INTERVAL_S": "86400", "FULL_RUN_INTERVAL_S": "86400", "RETRAIN_INTERVAL_S": "172800", "TRACK_RECORD_INTERVAL_S": "86400"})
    # ticks at day 0, 1, 2 (the radar interval sets the cadence): train, full, train again after 2 days
    assert [j[0] for j in jobs if j[0] != "radar"] == ["train+full", "full", "train+full"]
    assert all(j[2] for j in jobs if j[0] != "radar")


def test_onchain_loop_only_refreshes_the_radar(monkeypatch):
    executed, jobs, sleeps, t = run_fake_loop(monkeypatch, "onchain", ticks=5)
    assert {j[0] for j in jobs} == {"radar"} and len(jobs) == 5


def test_loop_survives_a_failing_tick_and_keeps_going(monkeypatch):
    executed, jobs, sleeps, t = run_fake_loop(monkeypatch, "onchain", ticks=6, failing={2, 3})
    assert "error" in executed and executed.count("radar") >= 3 and len(jobs) >= 5


def test_loop_stops_on_request(monkeypatch):
    flag = {"stop": False}
    monkeypatch.setattr(pipeline, "radar_refresh", lambda *a, **k: flag.update(stop=True) or [])
    monkeypatch.setattr(pipeline, "load_meta", lambda conn, label: {})
    monkeypatch.setattr(pipeline, "load_bundle", lambda conn, label: object())
    import contextlib

    @contextlib.contextmanager
    def lock(conn, name):
        yield True

    monkeypatch.setattr(store, "advisory_lock", lock)
    ex = loop.run_loop(Settings.from_env({}), Params(), "onchain", connect=lambda url: FakeConn(), now_fn=lambda: 5.0, sleep_fn=lambda s: None, should_stop=lambda: flag["stop"])
    assert ex == ["radar"]


# --------------------------------------------------------------------------- text lint
LINT_DIRS = [ROOT / "scorer", ROOT / "tests"]
LINT_FILES = [ROOT / n for n in ("README.md", "DECISIONS.md", "MODEL_CARD.md", ".env.example", "pyproject.toml")]
BANNED = [r"\bbet\b", r"\bbets\b", r"\bbetting\b", r"\bodds\b", r"\bgamble", r"\bgambling\b", r"\bjackpot\b", r"win big", r"claim winnings"]
TEXT_SUFFIXES = {".py", ".md", ".txt", ".json", ".mts", ".toml", ".example", ".sh"}


def lint_files():
    files = [f for f in LINT_FILES if f.exists()]
    for d in LINT_DIRS:
        files += [p for p in d.rglob("*") if p.is_file() and p.suffix in TEXT_SUFFIXES and "__pycache__" not in p.parts]
    infra = ROOT.parents[1] / "infra" / "docker" / "Dockerfile.scorer"
    if infra.exists():
        files.append(infra)
    return sorted(set(files))


def test_no_em_dashes_anywhere():
    bad = [str(p.relative_to(ROOT.parents[1])) for p in lint_files() if chr(0x2014) in p.read_text(encoding="utf-8")]
    assert bad == []


def test_terminology_lint():
    this = Path(__file__).resolve()
    hits = []
    for p in lint_files():
        if p.resolve() == this:
            continue  # this file spells out the banned words
        text = p.read_text(encoding="utf-8").lower()
        for pat in BANNED:
            for m in re.finditer(pat, text):
                hits.append(f"{p.name}: {text[max(0, m.start() - 20):m.end() + 20]!r}")
    assert hits == []


def test_yes_no_are_never_used_as_outcome_labels():
    outcome = re.compile(r"""["'](yes|no)["']""", re.I)
    this = Path(__file__).resolve()
    hits = [p.name for p in lint_files() if p.suffix == ".py" and p.resolve() != this and outcome.search(p.read_text(encoding="utf-8"))]
    assert hits == []


def test_no_secrets_in_the_repo_files():
    pat = re.compile(r"(api[-_]?key|secret|password)\s*[=:]\s*[\"'][A-Za-z0-9]{16,}[\"']", re.I)
    hits = [p.name for p in lint_files() if pat.search(p.read_text(encoding="utf-8"))]
    assert hits == []
