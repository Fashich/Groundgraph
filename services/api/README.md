# @groundgraph/api

Fastify 5 + Zod 4 REST and WebSocket API for the Groundgraph web app, wallets and link unfurlers. It never holds user keys: it builds **unsigned** v0 transactions that the wallet signs and sends, and it reads everything else from Postgres (history, positions, radar) and Redis (live oracle, fair values, heartbeats).

Environment variables: see [`../README.md`](../README.md#api-servicesapi). Interactive docs: `GET /docs` (OpenAPI at `/docs/json`).

```bash
pnpm --filter @groundgraph/api start         # tsx src/index.ts, listens on API_HOST:API_PORT (0.0.0.0:8787)
pnpm --filter @groundgraph/api typecheck
pnpm --filter @groundgraph/api test          # 12 files + test/e2e.test.ts, real Postgres svc_api and Redis DB 2
```

## What it serves

| Area | Endpoints |
|---|---|
| Auth (SIWS) | `POST /auth/nonce`, `POST /auth/verify`, `POST /auth/view` (read-only session for any address), `POST /auth/logout`, `GET /auth/session`, `POST /auth/tos` |
| Markets | `GET /markets` (filters, sort, cursor `o:<offset>`), `GET /markets/:id`, `GET /markets/:id/trades`, `GET /markets/:id/wallets`, `GET /markets/:id/quote`, `GET /fair-value`, `GET /assets` |
| Radar | `GET /radar/wallets`, `GET /wallets/:addr`, `GET /track-record/latest`, `POST /flags/dispute` |
| Account | `GET /me`, `GET /me/positions?tab=open\|redeem\|resolved`, `GET /me/activity`, `PUT /me/settings`, `POST /me/break`, `POST /me/watch/:marketId`, `POST /me/track/:wallet` |
| Unsigned transactions | `POST /tx/buy`, `/tx/sell`, `/tx/merge`, `/tx/redeem`, `/tx/create` (the wallet signs; amounts are base-unit strings) |
| Blinks | `GET /actions.json`, `GET\|POST /actions/m/:id` (POST needs a prior ToS acceptance for the wallet) |
| Images | `GET /og/m/:file` (SVG to PNG, Inter font bundled) |
| Ops | `GET /health`, `GET /metrics`, `POST /webhooks/helius` (only when `HELIUS_WEBHOOK_SECRET` is set), `POST /faucet/usdc` (devnet and only when `FAUCET_KEYPAIR` is set) |
| WebSocket | `/ws` (also `/api/ws`) |

Errors use one envelope: `{ "error": { "code", "message", ... } }` with a stable `code` from `ApiErrorCode` in `packages/sdk/src/api-types.ts` (`bad_request`, `unauthorized`, `view_only`, `tos_required`, `break_active`, `daily_limit_exceeded`, `oracle_stale`, `market_closed`, `slippage_exceeded`, `below_min_trade`, `insufficient_liquidity`, `not_found`, `rate_limited`, `geo_blocked`, `faucet_unavailable`, `internal`). Contracts for all bodies are `packages/sdk/src/api-types.ts`; the API tests assert them.

### WebSocket

Client messages: `{op:'subscribe'|'unsubscribe', channels:[...]}` and `{op:'ping'}`. Server messages: `{ch, type:'snapshot'|'delta', seq, ts, data}`, `{op:'pong'}`, `{op:'error', message}`. Reconnect = subscribe again (a fresh snapshot is the resume mechanism).

| Channel | Source | Data |
|---|---|---|
| `markets:summary` | API timer (2.5 s) | `{ markets: MarketSummary[] }`, only changed markets |
| `market:{id}` | indexer (`gg:ch:market:{id}`) | snapshot `MarketDetail`-style; deltas carry price, reserves, volume and the trade; on settle or void also `status` and `outcome` |
| `radar:{id}` | Postgres poll | radar state of the market |
| `oracle:{feedId}` | keeper (`gg:ch:oracle:{feedId}`) | `OracleInfo` |
| `me` | indexer (`gg:ch:me:{wallet}`), needs a session cookie | `{kind: 'fill'\|'created'\|'redeemed'\|'merged'\|'liquidity'\|'settled'\|'voided', marketId, ...}` |

Guard rails: 30 connections per IP, 16 KiB message limit, 50 channels per connection, token bucket per connection, 1 MiB send buffer (slower clients are dropped), 20 s protocol ping.

## Behaviors worth knowing

- **Status.** `markets.status` in Postgres mirrors the chain (`open`, `settled`, `voided`). `trading_closed` is derived at read time from `trading_end_ts`, so the indexer never has to write it.
- **Responsible trading.** Buys and market creation check the per-wallet daily limit (`user_settings`, default `DEFAULT_DAILY_LIMIT_USDC`), the break/cool-off flag and the geofence (`BLOCKED_COUNTRIES`). The API reserves the amount in Redis (`rt:pending:{wallet}`, member `<usdc>:<nonce>`, expires with the transaction); the indexer consumes the reservation when the fill lands and adds it to `spent_today` once. Sells, merges and redeems are never limited or geofenced.
- **Sessions.** SIWS message is verified server-side (nonce, domain = host of `WEB_ORIGIN`, expiry); the session is an HMAC-signed httpOnly cookie. View sessions (`/auth/view`) are read-only and cannot reach `/tx/*` or settings writes. State-changing requests must carry an allowed `Origin`.
- **Oracle freshness.** When the keeper's reading is older than `ORACLE_STALE_SECS`, buying is paused (`/tx/buy` and `/tx/create` answer `oracle_stale`, quotes carry an `oracle_stale` warning) and `oracle.stale` is true. Selling, merging and redeeming keep working.
- **Demo data.** Rows with `data_source = 'demo-synthetic'` are returned only when `DEMO_MODE=true` and are always labelled; real `onchain` rows are never mixed with them in one response.
- **Simulation.** With `SIMULATE_TX=true` every built transaction is simulated against the RPC before it is returned; Anchor errors are mapped to the stable error codes.

## Layout

```
src/index.ts          process wiring (config, db, redis, chain reader, graceful shutdown)
src/app.ts            Fastify app: cors, cookies, rate limit, origin check, request metrics, swagger
src/routes/*.ts       one file per area (auth, markets, account, tx, actions, og, radar, ops)
src/services/*.ts     read models and builders (markets, fairvalue, txbuild, positions, radar, ...)
src/ws/hub.ts         WebSocket hub and Redis fan-out
test/                 contract, per-route and websocket tests plus e2e.test.ts
```
