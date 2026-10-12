# Groundgraph backend services

Three long-running Node services plus two shared packages. All state lives in Postgres 16 and Redis; nothing needs a paid provider.
Public devnet RPC and Pyth are enough. Helius is an optional upgrade (see `HELIUS_API_KEY`).

| Part | Path | Role | Default port |
|---|---|---|---|
| API | `services/api` | REST, WebSocket (`/ws`), Solana Actions (Blinks), OG images, SIWS sessions, unsigned transaction builder | 8787 |
| Indexer | `services/indexer` | Follows program transactions, writes trades, positions, market state, ticks; publishes live deltas | 9102 (metrics, health) |
| Keeper | `services/keeper` | Oracle poller, fair values, volatility, market settlement and voiding, alerts | 9101 (metrics, health) |
| `@groundgraph/db` | `packages/db` | drizzle schema, SQL migrations (`packages/db/migrations`), typed queries | none |
| `@groundgraph/svc-core` | `packages/svc-core` | Env parsing, logger, metrics, Redis keys and channels, Pyth readers, chain reader, SDK adapter | none |

Per-service details: [`api/README.md`](api/README.md), [`indexer/README.md`](indexer/README.md), [`keeper/README.md`](keeper/README.md).

## Data flow

```
 Solana (devnet)                       Pyth (push feeds, Hermes)
   |  program logs                        |  prices
   v                                      v
 indexer  --writes-->  Postgres  <--writes--  keeper  --settle / void txs--> Solana
   |                      ^                      |
   | pub/sub (gg:ch:*)    | reads                | oracle:{feed}, fv:{market}, vol:{feed}, hb:keeper
   v                      |                      v
 Redis  <-----------------+-------------------- Redis
   |
   v
  API (REST + /ws fan-out)  -->  web app, wallets (Blinks), link unfurlers
```

Redis keys and channels are defined once in `packages/svc-core/src/redis.ts` (`RK`, `CH`).
Postgres is the system of record for history; Redis holds only caches, reservations, locks, heartbeats and pub/sub.

## Quick start (local)

```bash
# prerequisites: Node 22, pnpm 10 (corepack), Postgres 16, Redis
pnpm install                                  # always run installs under `flock /tmp/gg-pnpm.lock` on the shared dev box
scripts/dev-db.sh groundgraph                 # creates the database from packages/db/migrations (or let RUN_MIGRATIONS=true do it)
cp .env.example .env                          # then export the variables, services read process.env only
pnpm --filter @groundgraph/api start          # http://localhost:8787  (docs at /docs)
pnpm --filter @groundgraph/indexer start      # health at http://localhost:9102/healthz
pnpm --filter @groundgraph/keeper start       # health at http://localhost:9101/healthz
```

Services do not read `.env` files themselves. Export the variables (`set -a; . ./.env; set +a`) or pass them through your process manager or Docker.

One-off commands:

```bash
pnpm --filter @groundgraph/indexer backfill --reset               # rewind and walk the program history again (flags: --since --limit --before --batch)
pnpm --filter @groundgraph/db migrate                              # apply migrations without starting a service
```

## Docker

Images are built from the repository root (the build context must be the root):

```bash
docker build -f infra/docker/Dockerfile.api     -t groundgraph-api .
docker build -f infra/docker/Dockerfile.indexer -t groundgraph-indexer .
docker build -f infra/docker/Dockerfile.keeper  -t groundgraph-keeper .
```

Each image runs one process as the unprivileged `node` user, takes configuration from environment variables only, shuts down on SIGTERM and has a `HEALTHCHECK`.
`docker-compose.yml` is owned by the lead; the contract it needs is below.

| Service | Command (already the image CMD) | Port | Health check | Metrics |
|---|---|---|---|---|
| api | `node --import tsx src/index.ts` | `API_PORT` (8787) | `GET /health` (200 ok, 503 when Postgres, Redis or RPC is down) | `GET /metrics` |
| indexer | same | `INDEXER_METRICS_PORT` (9102) | `GET /healthz` (503 when no poll succeeded in the last 30 s or 10 poll intervals) | `GET /metrics` |
| keeper | same | `KEEPER_METRICS_PORT` (9101) | `GET /healthz` (503 when no oracle reading succeeded in the last 30 s or 10 oracle intervals) | `GET /metrics` |

Compose notes:
- `depends_on` Postgres and Redis with health conditions. All three services run migrations on boot (guarded by a Postgres advisory lock), so start order between them does not matter. Set `RUN_MIGRATIONS=false` on two of them if you prefer a single owner.
- The keeper needs a keypair: mount the JSON file read-only and set `KEEPER_KEYPAIR=/run/secrets/keeper.json`, or pass the 64 byte JSON array inline. The API faucet uses `FAUCET_KEYPAIR` the same way.
- Run exactly one indexer. A second instance is harmless (it waits on a Postgres advisory lock and takes over if the leader dies) but does no work.
- The keeper also tolerates a second instance: settlement is guarded by a Redis lock per market and by a fresh on-chain check before sending.
- Behind a reverse proxy set `TRUST_PROXY=true`, `COOKIE_SECURE=true`, `WEB_ORIGIN` and `PUBLIC_API_URL` to the public URLs. WebSocket upgrades must reach `/ws` (or `/api/ws` when the proxy keeps the prefix).
- Do not publish 9101 and 9102 to the internet. Set `METRICS_TOKEN` if `/metrics` is reachable by anyone else.

## Environment variables

Types are validated with zod at start; an invalid value stops the process with a list of every problem. Booleans are true for `true/1/yes/on` (any case) and false otherwise; an empty value means the default.
`all` = read by every service, `api`, `idx` (indexer), `keep` (keeper).

### Shared

| Variable | Default | Used by | Meaning |
|---|---|---|---|
| `NODE_ENV` | `development` | all | `production` enables strict checks (API refuses the default `SESSION_SECRET`, keeper refuses to start without `KEEPER_KEYPAIR` unless `KEEPER_SEND_TRANSACTIONS=false`) |
| `LOG_LEVEL` | `info` | all | pino level; logs are JSON lines |
| `SOLANA_CLUSTER` | `devnet` | all | `devnet`, `mainnet-beta`, `localnet`, `testnet` |
| `RPC_URL` | `https://api.devnet.solana.com` | all | HTTP RPC. With `HELIUS_API_KEY` set and `RPC_URL` unset, the indexer uses the Helius endpoint |
| `RPC_WS_URL` | unset | idx | websocket RPC; enables the `logsSubscribe` nudge that wakes the poller early |
| `PROGRAM_ID` | from `programs/groundgraph/deployments/devnet.json` | all | Override the program id (read by the SDK) |
| `USDC_MINT` | unset | api, idx | devnet test USDC mint (set after bootstrap) |
| `DATABASE_URL` | `postgres://groundgraph:groundgraph@localhost:5432/groundgraph` | all | Postgres 16 |
| `REDIS_URL` | `redis://localhost:6379` | all | Redis (any version with pub/sub) |
| `RUN_MIGRATIONS` | `true` | all | apply `packages/db/migrations` on boot |
| `DEMO_MODE` | `false` | api | serve `data_source='demo-synthetic'` rows (labelled demo data); never true in production |
| `TOS_VERSION` | `2026-10-01` | api | version string users accept before trading |
| `PYTH_HERMES_URL` | `https://hermes.pyth.network` | keep, api | Hermes base URL |
| `PYTH_API_KEY` | unset | keep, api | Hermes and Benchmarks need a Bearer key. Without it the keeper falls back to on-chain push feeds (see keeper README) |
| `PYTH_BENCHMARKS_URL` | `https://benchmarks.pyth.network` | keep, api | historical closes for volatility (falls back to Coinbase candles when no key) |
| `HELIUS_API_KEY` | unset | idx, api | optional; better rate limits and `logsSubscribe` |
| `HELIUS_WEBHOOK_SECRET` | unset | api | enables `POST /webhooks/helius` (nudges the indexer); Helius must send it as `Authorization: <secret>` |
| `SENTRY_DSN` | unset | keep | optional error reporting for keeper alerts |
| `METRICS_TOKEN` | unset | all | when set, `GET /metrics` requires `Authorization: Bearer <token>`; health endpoints stay open |
| `DEFAULT_DAILY_LIMIT_USDC` | `500` | api, idx | default responsible-trading daily buy limit (whole USDC) |
| `ORACLE_STALE_SECS` | `60` | api, keep | a reading older than this is flagged stale (same name in both so they agree) |
| `FAIR_VALUE_MAX_SPOT_AGE_SECS` | `900` | api, keep | oldest spot allowed for fair values |

### API (`services/api`)

| Variable | Default | Meaning |
|---|---|---|
| `API_HOST` / `API_PORT` | `0.0.0.0` / `8787` | listen address |
| `WEB_ORIGIN` | `http://localhost:3000` | browser origin; CORS and the CSRF origin check are pinned to it, and its host is the SIWS domain |
| `PUBLIC_API_URL` | `http://localhost:8787` | public base URL used in Blink links and OG image URLs |
| `SESSION_SECRET` | placeholder | at least 16 characters; must be changed in production |
| `SESSION_TTL_HOURS` | `168` | session lifetime |
| `COOKIE_NAME` | `gg_session` | session cookie name |
| `COOKIE_STRICT` / `COOKIE_SECURE` | `false` / `false` | `SameSite=Strict` instead of Lax; `Secure` flag (needed for HTTPS) |
| `TRUST_PROXY` | `false` | trust `X-Forwarded-*` (client IP for rate limits, faucet and geo checks) |
| `BLOCKED_COUNTRIES` | `US` | comma separated ISO codes refused for buying and creating (reads `CF-IPCountry`, `X-Vercel-IP-Country`, `CloudFront-Viewer-Country`, `X-Country-Code`, `X-Geo-Country`); sells, merges and redeems are never blocked |
| `SIMULATE_TX` | `true` | simulate every unsigned transaction before returning it |
| `DEFAULT_PRIORITY_FEE_MICROLAMPORTS` / `MAX_PRIORITY_FEE_MICROLAMPORTS` | `5000` / `200000` | compute unit price for built transactions |
| `FAUCET_KEYPAIR` | unset | mint authority of the devnet test USDC; without it `POST /faucet/usdc` answers `faucet_unavailable` |
| `FAUCET_AMOUNT_USDC` | `1000` | whole USDC per request |
| `FAUCET_MAX_PER_WALLET_PER_DAY` / `FAUCET_MAX_PER_IP_PER_DAY` | `3` / `6` | UTC day limits |
| `RATE_LIMIT_PER_MINUTE` | `600` | per client IP |
| `WS_MAX_CONNECTIONS_PER_IP` / `WS_MAX_BUFFER_BYTES` | `30` / `1048576` | websocket guard rails |

### Indexer (`services/indexer`)

| Variable | Default | Meaning |
|---|---|---|
| `INDEXER_POLL_INTERVAL_MS` | `2000` | signature poll interval; a websocket log event or a `gg:indexer:nudge` publish polls earlier |
| `INDEXER_BATCH_SIZE` | `100` | signatures per `getSignaturesForAddress` page (max 1000) |
| `INDEXER_TX_CONCURRENCY` | `4` | parallel `getTransaction` calls; keep low on the public RPC |
| `INDEXER_RECONCILE_INTERVAL_SECS` | `60` | re-read market accounts (authoritative reserves, status, fee state) |
| `INDEXER_FINALIZE_INTERVAL_SECS` | `20` | promote confirmed rows to finalized, drop rows whose transaction vanished |
| `INDEXER_TICK_INTERVAL_SECS` | `60` | `market_ticks` snapshot cadence for open markets |
| `INDEXER_BACKFILL_ON_START` | `true` | on an empty database, walk program history backwards in idle time |
| `INDEXER_WS_NUDGE` | auto | force the `logsSubscribe` nudge on or off; auto = on when `HELIUS_API_KEY` or `RPC_WS_URL` is set |
| `INDEXER_DROP_GRACE_SLOTS` | `64` | slots below finalized before a missing transaction counts as dropped |
| `INDEXER_METRICS_HOST` / `INDEXER_METRICS_PORT` | `0.0.0.0` / `9102` | `/metrics` and `/healthz` |

### Keeper (`services/keeper`)

| Variable | Default | Meaning |
|---|---|---|
| `KEEPER_KEYPAIR` | unset | path to a JSON keypair file or the 64 byte array inline. Pays fees only; never holds user funds. Unset = read-only keeper (an error in production) |
| `KEEPER_SEND_TRANSACTIONS` | `true` | `false` = dry run: decisions are logged, nothing is sent |
| `KEEPER_SETTLEMENT_ORACLE` | `auto` | `auto`: Hermes when `PYTH_API_KEY` is set, otherwise push feeds. `hermes`: requires the key. `push-feed`: always push feeds |
| `KEEPER_PUSH_FEED_ASSETS` | `SOL,ETH` | assets allowed to settle from push feed accounts (the other devnet feeds are stale) |
| `KEEPER_ORACLE_INTERVAL_MS` | `2000` | oracle poll |
| `KEEPER_FAIRVALUE_INTERVAL_SECS` | `60` | fair value refresh |
| `KEEPER_SETTLE_INTERVAL_SECS` | `10` | settle scan (every 2 s while a settle window is open) |
| `KEEPER_VOL_REFRESH_MINUTES` | `30` | realized volatility refresh |
| `KEEPER_HOUSEKEEPING_INTERVAL_MINUTES` | `60` | pruning and wallet balance check |
| `KEEPER_PRIORITY_FEE_MICROLAMPORTS` / `KEEPER_MAX_PRIORITY_FEE_MICROLAMPORTS` | `5000` / `200000` | fee for keeper transactions, doubled on every retry up to the maximum |
| `KEEPER_CONFIRM_TIMEOUT_SECS` | `45` | wait for confirmation before an attempt counts as failed |
| `KEEPER_ALERT_AFTER_ATTEMPTS` | `3` | failed attempts on one market before alerting |
| `KEEPER_MIN_SOL` | `0.2` | low balance alert threshold |
| `KEEPER_ORACLE_RETENTION_DAYS` / `KEEPER_FAIRVALUE_RETENTION_DAYS` | `7` / `14` | pruning horizon |
| `KEEPER_METRICS_HOST` / `KEEPER_METRICS_PORT` | `0.0.0.0` / `9101` | `/metrics` and `/healthz` |
| `ALERT_WEBHOOK_URL` | unset | Discord, Slack or any JSON endpoint; unset = alerts only in the log |
| `ALERT_WEBHOOK_FORMAT` | `auto` | `auto`, `discord`, `slack`, `json` |
| `ALERT_TELEGRAM_BOT_TOKEN` / `ALERT_TELEGRAM_CHAT_ID` | unset | Telegram alerts |
| `ALERT_DEDUPE_SECS` | `900` | the same alert key is sent at most once per window |

## Health and monitoring

| Endpoint | Meaning |
|---|---|
| `GET api:8787/health` | `{ ok, db, redis, rpc, indexerLagSlots, keeper: { ok, ageSec } }`. 200 when Postgres, Redis and the RPC answer; the indexer lag and keeper heartbeat are reported but do not change the status code |
| `GET indexer:9102/healthz` | `{ ok, indexedSlot, headSlot, lagSlots, lastPollAgeMs, backfillDone, lastError }` |
| `GET keeper:9101/healthz` | `{ ok, oracleSource, settlementMode, canSend, oracleAgeMs, settled, voided, failed }` |
| `GET */metrics` | Prometheus text; every metric is prefixed `gg_` (`gg_indexer_*`, `gg_keeper_*`, `gg_http_*` and `gg_ws_*` on the API) plus default process metrics |
| Redis `hb:indexer`, `hb:keeper` | heartbeat JSON refreshed every 5 s with a 30 s TTL (the API reads them) |

## Tests

Tests use a real Postgres and Redis (Redis DB index 2), never mocks of either. Each package has its own throwaway database, created by the package's vitest `globalSetup`:

| Package | Database | Command |
|---|---|---|
| `packages/db` | `svc_db` | `pnpm --filter @groundgraph/db test` |
| `packages/svc-core` | none (Redis DB 2) | `pnpm --filter @groundgraph/svc-core test` |
| `services/api` | `svc_api` | `pnpm --filter @groundgraph/api test` (includes `test/e2e.test.ts`, the cross-service run) |
| `services/indexer` | `svc_indexer` | `pnpm --filter @groundgraph/indexer test` |
| `services/keeper` | `svc_keeper` | `pnpm --filter @groundgraph/keeper test` |

The chain is an in-memory ledger in tests (`services/indexer/test/helpers.ts`, `services/keeper/test/helpers.ts`, `services/api/test/helpers.ts`), but transaction logs and accounts are encoded with the real `@groundgraph/sdk` codecs. Anything that needs the deployed program (real settle and void transactions, Hermes posting with a real key, decoding of real program logs) is not covered until the program exists on devnet.
