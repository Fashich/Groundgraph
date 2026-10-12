"""Shared fixtures. The small synthetic world is built once per session (a few seconds)."""

from __future__ import annotations

import dataclasses
import os
import subprocess
from pathlib import Path

import numpy as np
import pytest

from scorer.config import Params
from scorer.sources.synthetic import SyntheticConfig, SyntheticSource

ROOT = Path(__file__).resolve().parents[3]  # repository root
DB_NAME = "scorer_pytest"
PG = dict(host="127.0.0.1", port=5432, user="groundgraph", password="groundgraph")
SMALL_NOW = 1791808200.0  # 2026-10-12 12:30 UTC


def fast_params(**kw) -> Params:
    """Default parameters with a shorter GraphSAGE run (the test suite trains several models)."""
    return dataclasses.replace(Params(), sage_epochs=30, cv_folds=3, **kw)


@pytest.fixture(scope="session")
def params() -> Params:
    return fast_params()


@pytest.fixture(scope="session")
def small_cfg() -> SyntheticConfig:
    return SyntheticConfig(n_wallets=110, days=300, sybil_groups=(4, 3, 3))


@pytest.fixture(scope="session")
def small_ds(small_cfg, params):
    return SyntheticSource(small_cfg, params).build_dataset(SMALL_NOW)


# --------------------------------------------------------------------------- database
def _pg_available() -> bool:
    try:
        import psycopg

        with psycopg.connect(dbname="postgres", connect_timeout=3, **PG):
            return True
    except Exception:
        return False


@pytest.fixture(scope="session")
def db_url() -> str:
    """Throwaway database created from the canonical migrations by scripts/dev-db.sh (never the groundgraph DB)."""
    if not _pg_available():
        pytest.skip("PostgreSQL is not reachable on 127.0.0.1:5432")
    script = ROOT / "scripts" / "dev-db.sh"
    out = subprocess.run([str(script), DB_NAME], capture_output=True, text=True, timeout=120, env=dict(os.environ))
    if out.returncode != 0:
        pytest.skip(f"scripts/dev-db.sh failed: {out.stderr[-200:]}")
    return f"postgres://{PG['user']}:{PG['password']}@{PG['host']}:{PG['port']}/{DB_NAME}"


# indexer_state keeps the trained model between tests (training is the slow part); job bookkeeping is reset below
TABLES = ("market_radar, scored_positions, wallet_scores, wallet_features, graph_layout, wallet_edges, wallets, "
          "track_record_rows, track_record_runs, trades, positions, market_ticks, markets")


@pytest.fixture()
def db(db_url):
    """A connection to the throwaway database with every table emptied."""
    import psycopg

    conn = psycopg.connect(db_url)
    with conn.cursor() as cur:
        cur.execute(f"TRUNCATE {TABLES} RESTART IDENTITY CASCADE")
        cur.execute("DELETE FROM indexer_state WHERE key LIKE 'scorer:meta:%'")
    conn.commit()
    yield conn
    conn.close()


@pytest.fixture()
def rng():
    return np.random.default_rng(7)


@pytest.fixture(autouse=True)
def _isolate_model_card(tmp_path, monkeypatch):
    """Tests never overwrite the committed MODEL_CARD.md."""
    monkeypatch.setenv("MODEL_CARD_PATH", str(tmp_path / "MODEL_CARD.md"))
