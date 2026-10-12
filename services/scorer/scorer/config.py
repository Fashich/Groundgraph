"""Runtime settings (environment) and model parameters (tunables).

`Settings` is read from the environment once per process. `Params` holds every number that
changes model behaviour, so tests can override them and the model card can print them.
"""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass
from typing import Mapping

DAY = 86400.0
HOUR = 3600.0
YEAR_SECONDS = 365.0 * DAY

DS_SYNTHETIC = "demo-synthetic"
DS_HELIUS = "helius-mainnet"
DS_ONCHAIN = "onchain"

SOURCES = ("synthetic", "helius", "onchain")

# Mapping from CLI source name to the data_source label written to the database.
SOURCE_LABEL = {
    "synthetic": DS_SYNTHETIC,
    "helius": DS_HELIUS,
    "onchain": DS_ONCHAIN,
}

# data_source label used for track record runs (honest about how the virtual markets were built).
TRACK_LABEL = {
    "synthetic": DS_SYNTHETIC,
    "helius": "helius-mainnet-backfill",
    "onchain": "helius-mainnet-backfill",
}


def _truthy(v: str | None) -> bool:
    return str(v or "").strip().lower() in ("1", "true", "on")


@dataclass(frozen=True)
class Settings:
    database_url: str = "postgres://groundgraph:groundgraph@localhost:5432/groundgraph"
    demo_mode: bool = False
    source: str = "helius"
    helius_api_key: str = ""
    helius_enhanced_rps: float = 2.0
    helius_rpc_rps: float = 8.0
    helius_backfill_days: int = 120
    pyth_benchmarks_url: str = "https://benchmarks.pyth.network"
    radar_interval_s: float = 60.0
    full_run_interval_s: float = 3600.0
    retrain_interval_s: float = 7 * 86400.0
    track_record_interval_s: float = 86400.0
    seed: int = 20261012
    log_level: str = "INFO"

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Settings":
        e = os.environ if env is None else env
        d = cls()
        return cls(
            database_url=e.get("DATABASE_URL", d.database_url),
            demo_mode=_truthy(e.get("DEMO_MODE")),
            source=(e.get("SCORER_SOURCE") or d.source).strip().lower(),
            helius_api_key=e.get("HELIUS_API_KEY", ""),
            helius_enhanced_rps=float(e.get("HELIUS_ENHANCED_RPS", d.helius_enhanced_rps)),
            helius_rpc_rps=float(e.get("HELIUS_RPC_RPS", d.helius_rpc_rps)),
            helius_backfill_days=int(e.get("HELIUS_BACKFILL_DAYS", d.helius_backfill_days)),
            pyth_benchmarks_url=e.get("PYTH_BENCHMARKS_URL", d.pyth_benchmarks_url).rstrip("/"),
            radar_interval_s=float(e.get("RADAR_INTERVAL_S", d.radar_interval_s)),
            full_run_interval_s=float(e.get("FULL_RUN_INTERVAL_S", d.full_run_interval_s)),
            retrain_interval_s=float(e.get("RETRAIN_INTERVAL_S", d.retrain_interval_s)),
            track_record_interval_s=float(e.get("TRACK_RECORD_INTERVAL_S", d.track_record_interval_s)),
            seed=int(e.get("SCORER_SEED", d.seed)),
            log_level=e.get("LOG_LEVEL", d.log_level).upper(),
        )

    def check_source(self, source: str | None = None) -> str:
        """Validate a source name. 'synthetic' is refused unless DEMO_MODE=true."""
        s = (source or self.source).lower()
        if s not in SOURCES:
            raise ValueError(f"unknown source {s!r}, expected one of {SOURCES}")
        if s == "synthetic" and not self.demo_mode:
            raise PermissionError(
                "source 'synthetic' generates demo data and is refused unless DEMO_MODE=true"
            )
        return s


@dataclass(frozen=True)
class Params:
    """Model and pipeline tunables. Frozen so a run is fully described by (Params, data)."""

    seed: int = 20261012

    # graph window and time decay (edge weight = USD * 0.5 ** (age / half_life))
    window_days: float = 30.0
    half_life_days: float = 7.0
    pagerank_damping: float = 0.85

    # whales: top 1% of wallets by balance, never fewer than min_whales
    whale_frac: float = 0.01
    min_whales: int = 5

    # entry timing and lead time: a "move" is a 5 cent change of the market ABOVE price in the entry's favour
    move_size: float = 0.05
    move_horizon_h: float = 24.0
    entry_n: int = 14
    entry_lookback_days: float = 60.0
    # shrinkage prior strength (pseudo observations at 0.5) for hit rate and entry timing
    prior_strength: float = 3.0
    lead_cap_min: float = 120.0

    # flagging gates (a wallet needs evidence before it can be called smart money)
    min_flag_entries: int = 5
    min_flag_resolved: int = 3
    smart_threshold_default: float = 70.0
    top_quantile: float = 0.85
    head_weight_floor: float = 0.08
    head_baseline_q: float = 0.70
    head_cut_beta: float = 1.0  # F-beta used to place the smart money flag threshold
    max_flag_share: float = 0.15  # the flag threshold never admits more than this share of active wallets
    gnn_share_cap: float = 0.40

    # labels (smart money proxy, computed strictly AFTER the feature cutoff)
    label_days: float = 14.0
    label_min_events: int = 3
    label_pnl_quantile: float = 0.90
    label_early_min: float = 0.5

    # temporal split: train -> embargo -> test
    embargo_days: float = 14.0
    warmup_days: float = 30.0
    test_days: float = 70.0
    train_stride_days: float = 7.0
    test_stride_days: float = 1.0
    market_horizons_days: tuple = (21.0, 30.0, 45.0)

    # virtual markets
    market_open_every_h: float = 120.0
    min_remaining_h: float = 168.0
    p_floor: float = 0.02

    # GraphSAGE
    sage_hidden: int = 64
    sage_dropout: float = 0.2
    sage_lr: float = 0.01
    sage_weight_decay: float = 1e-4
    sage_epochs: int = 80
    cv_folds: int = 4

    # radar
    radar_min_flagged: int = 3
    radar_min_scored_trades: int = 10
    radar_gain: float = 1.4
    radar_shrink: float = 6.0
    radar_ci_scale: float = 164.0
    radar_hit_offset: float = 0.4
    radar_sybil_cap: float = 0.5
    radar_calibration_min: int = 60

    # sybil
    sybil_min_wallets: int = 3
    sybil_hops: int = 2
    sybil_max_fanout: int = 40

    # track record
    edge_threshold_cents: float = 3.0
    min_edge_trades: int = 10  # realised edge is only reported from at least this many hypothetical positions
    assumed_fee_bps: float = 100.0
    t_minus_h: float = 24.0

    @classmethod
    def for_source(cls, source: str, seed: int = 20261012) -> "Params":
        """Parameters per data source. The Helius backfill covers 120 days, too short for the 45 day markets and 14 day
        embargo of the synthetic world, so real data uses shorter virtual markets, labels, embargo and test window."""
        if source in ("helius", "onchain"):
            return cls(seed=seed, market_horizons_days=(7.0, 10.0, 14.0), min_remaining_h=48.0, market_open_every_h=48.0,
                       label_days=7.0, embargo_days=7.0, test_days=21.0)
        return cls(seed=seed)

    @property
    def max_market_days(self) -> float:
        return float(max(self.market_horizons_days))

    def to_dict(self) -> dict:
        return asdict(self)


DEFAULT_PARAMS = Params()

# Design weights from design/graph.js (FEAT), used as the cold start head before any model is trained.
DEFAULT_HEAD_WEIGHTS = {
    "whale_overlap": 0.31,
    "entry_timing": 0.26,
    "hit_rate": 0.20,
    "centrality": 0.13,
    "lead_time": 0.10,
}

FEATURE_KEYS = ("whale_overlap", "entry_timing", "hit_rate", "centrality", "lead_time")

# Allow-listed assets. symbol -> (pyth symbol, Solana mint). The mints are the canonical mainnet mints.
ASSETS: dict[str, dict[str, str]] = {
    "SOL": {"pyth": "Crypto.SOL/USD", "mint": "So11111111111111111111111111111111111111112"},
    "BTC": {"pyth": "Crypto.BTC/USD", "mint": "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh"},
    "ETH": {"pyth": "Crypto.ETH/USD", "mint": "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs"},
    "JUP": {"pyth": "Crypto.JUP/USD", "mint": "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"},
    "WIF": {"pyth": "Crypto.WIF/USD", "mint": "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm"},
    "BONK": {"pyth": "Crypto.BONK/USD", "mint": "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"},
}
USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
WSOL_MINT = "So11111111111111111111111111111111111111112"

# Annualised volatility used only to seed the synthetic world and as a fallback for the first days of a price series.
DEFAULT_VOL = {"SOL": 0.75, "BTC": 0.45, "ETH": 0.6, "JUP": 1.0, "WIF": 1.3, "BONK": 1.2}


def feature_fingerprint(p: Params) -> str:
    import hashlib
    import json

    return hashlib.sha256(json.dumps(p.to_dict(), sort_keys=True).encode()).hexdigest()[:8]


__all__ = [
    "ASSETS",
    "DAY",
    "DEFAULT_HEAD_WEIGHTS",
    "DEFAULT_PARAMS",
    "DEFAULT_VOL",
    "DS_HELIUS",
    "DS_ONCHAIN",
    "DS_SYNTHETIC",
    "FEATURE_KEYS",
    "HOUR",
    "Params",
    "SOURCES",
    "SOURCE_LABEL",
    "Settings",
    "TRACK_LABEL",
    "USDC_MINT",
    "USDT_MINT",
    "WSOL_MINT",
    "YEAR_SECONDS",
    "feature_fingerprint",
]
