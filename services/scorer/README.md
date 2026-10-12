# Groundgraph scorer

Python 3.11 service that turns wallet behaviour into the data behind the Smart-money radar, the wallet graph and the
Track record page. It writes only the tables the API already reads. It does not write `fair_values` and it does not
call the API.

What it produces, per run:

| Output | Table | Notes |
|---|---|---|
| Wallet score 0..100 with five named contributions that sum to the score | `wallet_scores`, `wallet_features` | `contributions` keys: `whale_overlap`, `entry_timing`, `hit_rate`, `centrality`, `lead_time` |
| Smart / top flags, cluster, sybil cluster | `wallet_scores`, `wallets` | sybil members get weight x0.5 in the radar |
| 3D layout | `graph_layout` | coordinates clipped to [-1.6, 1.6] |
| Per-market radar (P ABOVE, interval, edge, flagged wallets) | `market_radar` | one row per market per minute, thinned to hourly after 48 h |
| Mirror of positions used by the radar | `scored_positions` | `usdc` in base units, `entry_price` is the ABOVE price |
| Nightly backtest | `track_record_runs`, `track_record_rows` | virtual markets, ids like `vm:SOL:<ts>` |
| Model, calibrator, state, model card text | `indexer_state` | keys `scorer:model:*`, `scorer:calibrator:*`, `scorer:meta:*`, `scorer:model_card:*` |

No schema changes are needed. The model card of the last synthetic run is in `MODEL_CARD.md`.

## Status, stated plainly

* The full pipeline runs end to end on the **synthetic** source (about 30 s on 2 CPU cores, including training) and
  the output was checked against the real API (DEMO_MODE true and false).
* The **Helius** source is implemented and unit-tested against hand-written fixtures and mocked HTTP only. It has
  **never been run against the live Helius or Pyth services** (no key and no network were available when it was
  written). Treat the first real run as an integration test. Fixtures in `tests/fixtures_helius/` follow the public
  response formats; they are not recordings.
* `infra/docker/Dockerfile.scorer` has been written but **not built** in this environment.
* All numbers in `MODEL_CARD.md` come from DEMO SYNTHETIC data. They show that the code works, not that it finds
  smart money on Solana mainnet.

## Data sources

All sources return the same `Dataset` object (wallets, transfer edges, swap trades, prices, balances).

| `--source` | Label in tables | What it is |
|---|---|---|
| `synthetic` | `demo-synthetic` | Generated world with planted smart money, whales, hubs and sybil groups. **Refuses to start unless `DEMO_MODE=true`.** |
| `helius` | `helius-mainnet` | Real history from the Helius enhanced transactions API plus JSON-RPC, prices from Pyth Benchmarks. Needs `HELIUS_API_KEY`. 120 day backfill, resumable. |
| `onchain` | `onchain` | Mirrors `trades` and `positions` of Groundgraph markets into `scored_positions` (used by the radar when the app has its own flow). |

Wallet behaviour on `synthetic` and `helius` is spot swapping of six allow-listed assets (SOL, BTC, ETH, JUP, WIF,
BONK). A buy counts as an ABOVE position and a sell as a BELOW position on a virtual close market (see DECISIONS.md,
ADR-003).

## Setup

```bash
cd services/scorer
python3.11 -m venv ../../.venv-scorer            # or any venv outside the repo
. ../../.venv-scorer/bin/activate
pip install --extra-index-url https://download.pytorch.org/whl/cpu torch==2.14.1
pip install -e ".[dev]"
cp .env.example .env                              # then edit; never commit real keys
```

Torch is used on CPU only. Measured peak resident memory on the synthetic world: about 760 MB for `run-once` without
retraining (9 s) and 940 MB for the whole test suite (100 s).

## Commands

All commands are `python -m scorer <command>` and read configuration from the environment (see below).

```bash
# one full pass (data, features, scores, clusters, layout, radar, track record) and exit
DEMO_MODE=true python -m scorer run-once --source synthetic

# same, but force a retrain first
DEMO_MODE=true python -m scorer run-once --source synthetic --train

# long running scheduler (this is the Docker entrypoint)
python -m scorer loop --source helius

# individual jobs
python -m scorer train --source synthetic        # train + backtest + write model, track record and MODEL_CARD.md
python -m scorer radar --source synthetic        # refresh the radar of every open market (the per-minute job)
python -m scorer track-record --source synthetic # nightly backtest with the stored model
```

`run --once` is an alias of `run-once`. `--now 2026-10-12T12:30:00Z` pins the clock for reproducible runs.
`--no-track` skips the backtest step.

### What `loop` does

| Job | Cadence (env) | Default |
|---|---|---|
| radar refresh | `RADAR_INTERVAL_S` | 60 s |
| features, scores, clusters, layout | `FULL_RUN_INTERVAL_S` | 1 hour |
| retrain GraphSAGE and head | `RETRAIN_INTERVAL_S` | 7 days |
| track record | `TRACK_RECORD_INTERVAL_S` | 24 hours |

Last-run timestamps live in `indexer_state` (`scorer:meta:<label>`), so a container restart does not retrain
or re-run a batch that is not due. Runs are guarded by Postgres advisory locks, so two replicas do not collide, and
every write is an idempotent upsert keyed by the table primary key. A failed tick is logged and retried on the
next tick with a fresh connection.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | local `groundgraph` DB | Postgres, the same one the API uses |
| `DEMO_MODE` | `false` | Must be `true` for `--source synthetic`. Demo rows are labelled `demo-synthetic` and the API serves them only when its own `DEMO_MODE` is true |
| `SCORER_SOURCE` | `helius` | Default for `--source` |
| `HELIUS_API_KEY` | empty | Needed for `helius`. Never logged; URLs are redacted in errors |
| `HELIUS_ENHANCED_RPS`, `HELIUS_RPC_RPS` | 2, 8 | Client-side rate limits |
| `HELIUS_BACKFILL_DAYS` | 120 | Backfill depth |
| `HELIUS_MAX_REQUESTS_PER_RUN` | 3000 | Request budget per run; the backfill resumes from its checkpoint next run |
| `PYTH_BENCHMARKS_URL`, `PYTH_API_KEY` | public URL, empty | Price history |
| `RADAR_INTERVAL_S`, `FULL_RUN_INTERVAL_S`, `RETRAIN_INTERVAL_S`, `TRACK_RECORD_INTERVAL_S` | 60, 3600, 604800, 86400 | Loop cadence |
| `SCORER_SEED` | 20261012 | Seed for the model and the synthetic world |
| `MODEL_CARD_PATH` | `services/scorer/MODEL_CARD.md` | Where the card is written (the Docker image uses `/data/MODEL_CARD.md`) |
| `LOG_LEVEL` | `INFO` | |

## Checking the output against the API

```bash
scripts/dev-db.sh scorer_demo                              # creates a throwaway DB with migrations
export DATABASE_URL=postgres://groundgraph:groundgraph@127.0.0.1:5432/scorer_demo
DEMO_MODE=true python -m scorer run-once --source synthetic
DATABASE_URL=$DATABASE_URL DEMO_MODE=true API_PORT=8787 pnpm --filter @groundgraph/api start &
curl -s localhost:8787/radar/wallets | head -c 400
curl -s localhost:8787/markets | head -c 600                       # each market carries its latest radar row
curl -s localhost:8787/markets/<market_id>/wallets | head -c 400   # flagged wallets of a market
curl -s localhost:8787/track-record/latest | head -c 400
```

Use a throwaway database, not the shared `groundgraph` one, for experiments.

## Tests

```bash
cd services/scorer
python -m pytest tests -q -p no:cacheprovider
```

The DB tests create a database named `scorer_pytest` through `scripts/dev-db.sh` and need Postgres on 127.0.0.1:5432.
Everything else runs without a database or network.

| File | Covers |
|---|---|
| `test_radar.py`, `radar_vectors.json` | radar formula, sybil cap x0.5, building state, 74 golden vectors |
| `test_features.py` | feature definitions on a hand-built world |
| `test_labels_splits.py`, `test_leakage.py` | labels, temporal split with embargo, group folds, no look-ahead (truncate and scramble-the-future tests) |
| `test_model_head.py` | GraphSAGE shapes, determinism, monotone head, integer contributions summing to the score |
| `test_clusters.py` | Louvain determinism with a fixed seed (also across processes with different `PYTHONHASHSEED`), sybil rules, layout |
| `test_pipeline.py` | calibration, ECE, bootstrap, track record on a small world, reproducible training |
| `test_db.py` | real Postgres: upserts, idempotency, hidden wallets, API shaped rows |
| `test_helius.py` | Helius parsers, retries, budget, resume, Pyth shim, all with mocked HTTP |
| `test_synthetic_cli.py` | synthetic source, CLI refusal outside DEMO_MODE, loop with a fake clock, lint (no em dash, no banned terms, no secrets) |

### Radar versus the TypeScript SDK

The radar must agree with `packages/sdk/src/radar.ts`. `tests/radar_vectors.json` holds 74 golden cases generated by
`tests/gen_radar_vectors.py` (`PYTHONPATH=. python tests/gen_radar_vectors.py`). To compare them with the real SDK:

```bash
services/api/node_modules/.bin/tsx services/scorer/tests/radar_ts_check.mts services/scorer/tests/radar_vectors.json
```

The last comparison gave 74 cases and 0 mismatches. State, `n`, `ci` and `edge` match exactly. `p_above` matches to a
relative difference of at most 2e-16: V8 and glibc can differ by one unit in the last place in `exp` and `log`, so it is
not bit-identical. A rounding tie right at the edge could in theory differ by one point.

## Regenerating the model card

```bash
DEMO_MODE=true python -m scorer train --source synthetic --now 2026-10-12T12:30:00Z
```

The card is built from measured values only (nothing is typed by hand) and always carries the data source and the
synthetic-data statement when the source is `synthetic`.

## Docker

```bash
docker build -f infra/docker/Dockerfile.scorer -t groundgraph-scorer .   # NOT yet built or run by the author
docker run --rm --env-file services/scorer/.env groundgraph-scorer       # default command: loop
```

The image is CPU only, runs as a non-root user and has a database healthcheck.

## Known gaps

* Helius and Pyth paths are tested with fixtures and mocks only.
* On real data a 120 day backfill gives 3 training cutoffs, so the model is thin and its metrics have wide intervals.
* Virtual trades are not rows in `trades` or `scored_positions` (the latter has a foreign key to `markets`), so a
  synthetic wallet's `volumeUsd` in `/wallets/:addr` is 0 unless it holds a position in a current market.
* Open-market positions in the demo are seeded from the market id, so they are self-consistent but not informative.
* ECE is imprecise when most backtest prices are near 0 or 1.
* Funding source on real data is the first inbound SOL transfer inside the window, not necessarily the true funder.
