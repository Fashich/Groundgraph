# @groundgraph/keeper

Permissionless upkeep for the markets: it polls Pyth prices, computes fair values, and **settles** (or **voids**) markets when their time comes. The keeper wallet only pays transaction fees; it holds no user funds and has no special rights on the program (anyone could call `settle_close` and `void_market`).

Environment variables: see [`../README.md`](../README.md#keeper-serviceskeeper). Health and metrics: `http://localhost:9101/healthz`, `/metrics`.

```bash
pnpm --filter @groundgraph/keeper start     # long-running process
pnpm --filter @groundgraph/keeper test      # real Postgres svc_keeper + Redis DB 2, mocked chain, Hermes and RPC
```

Safe dry run against devnet (reads prices, writes oracle and fair values, never sends):

```bash
KEEPER_SEND_TRANSACTIONS=false node --import tsx src/index.ts
```

## Loops

| Loop | Interval | What it does |
|---|---|---|
| oracle | `KEEPER_ORACLE_INTERVAL_MS` (2 s) | reads every allow-listed feed, writes `oracle:{feed}` (TTL 120 s) and publishes `gg:ch:oracle:{feed}` when the publish time or the stale flag changes; keeps a downsampled `oracle_status` history (15 s rows, immediate row on a stale flip); alerts when a feed with an open market is stale for 120 s |
| fair values | `KEEPER_FAIRVALUE_INTERVAL_SECS` (60 s) | for every unsettled market: `fair_values` row and `fv:{market}` (TTL 300 s) from spot, 30-day realized volatility and time to settle (closed-form for close markets, reflection formula for touch markets) |
| volatility | `KEEPER_VOL_REFRESH_MINUTES` (30) | SOL, BTC, ETH and every asset with an open market; `vol:{feed}` (TTL 2 h). Pyth Benchmarks with a key, Coinbase daily candles otherwise; a failure keeps the old value and backs off for 60 s |
| settle | `KEEPER_SETTLE_INTERVAL_SECS` (10 s, 2 s while a window is open) | see below |
| housekeeping | `KEEPER_HOUSEKEEPING_INTERVAL_MINUTES` (60) | prunes old `oracle_status` and `fair_values` of resolved markets, checks the wallet balance against `KEEPER_MIN_SOL` |
| heartbeat | 5 s | `hb:keeper` (read by the API `/health`) |

## Settlement and the Pyth decision

On chain, `settle_close` needs a **fully verified** `PriceUpdateV2` account owned by the Pyth receiver whose `publish_time` is in `[settle_ts, settle_ts + max_staleness_secs]` (60 s by default), price above zero and `conf * 10000 <= max_conf_bps * price`. Strictly above the target is ABOVE; equal or below is BELOW. If nobody settles within one hour of `settle_ts`, `void_market` refunds every share at 0.5 USDC.

Hermes (the HTTP source of signed price updates) now requires a Bearer key. So there are two modes, chosen by `KEEPER_SETTLEMENT_ORACLE`:

| Mode | When | How a market is settled | Limits |
|---|---|---|---|
| `hermes` | `PYTH_API_KEY` is set (`auto`), or forced | fetch the update for the first publish after `settle_ts`, post it through the Pyth receiver (`@pythnetwork/pyth-solana-receiver`), and settle in the **same transaction bundle** | all allow-listed feeds |
| `push-feed` | no key (`auto`), or forced | use the sponsored push feed account as `price_update`; the keeper acts as soon as the account's publish time falls inside the window | only `KEEPER_PUSH_FEED_ASSETS` (default `SOL,ETH`: the BTC and other devnet feeds are stale); a push account holds only the latest update, so the 60 s window is the only chance; stale feeds are skipped and, past `settle_ts + 1 h`, the market is **voided** |

The mode is never silent: the keeper logs a loud warning at start in push-feed mode, `/healthz` reports `settlementMode`, and an asset that cannot be settled is logged and alerted.

Per market, each scan: take a Redis lock `lock:settle:{id}` (NX, 90 s, owner-checked release), re-read the account (another keeper may have settled), run the pure decision function (`src/settle-logic.ts`: wait, skip, settle with Hermes, settle with a push feed, wait for the feed, unavailable, void), build, send, confirm. Retries back off 5, 10, 20, 40, 60 s with priority fees doubling from `KEEPER_PRIORITY_FEE_MICROLAMPORTS` up to `KEEPER_MAX_PRIORITY_FEE_MICROLAMPORTS`; an alert fires after `KEEPER_ALERT_AFTER_ATTEMPTS` failures. `MarketNotOpen` means somebody else won the race and counts as resolved. After sending, it publishes `gg:indexer:nudge` so the indexer picks the event up immediately.

## Alerts

`ALERT_WEBHOOK_URL` (Discord, Slack or generic JSON, auto-detected), Telegram (`ALERT_TELEGRAM_BOT_TOKEN` + `ALERT_TELEGRAM_CHAT_ID`) and Sentry (`SENTRY_DSN`) are optional. Without any of them alerts are only logged. The same alert key is sent at most once per `ALERT_DEDUPE_SECS`, recovery sends a resolve notice, and the alerter never throws into the loops.

Alerts: settlement failing repeatedly (`settle-failed`), a market that cannot be settled with the available price source (`settle-unavailable`), a market voided (`voided`), a feed stale for a watched asset, a low keeper wallet balance. Each has a matching recovery notice.

## Known gaps

- Settle and void transactions have only been exercised against mocks until the program is deployed to devnet.
- The Hermes path (post update plus settle in one bundle) needs a real `PYTH_API_KEY` to be tested end to end.
- Touch markets are Phase 2 in the program. The keeper skips any market whose kind is not `close` (`unsupported_kind`), although fair values are computed for them (reflection formula).

## Layout

```
src/index.ts     wiring, health, shutdown            src/settle.ts        SettleLoop (lock, retry, alerts)
src/run.ts       loop runner                         src/settle-logic.ts  pure decision rules
src/oracle.ts    OracleLoop                          src/poster.ts        transaction building and sending (RpcPoster, DryRunPoster)
src/fairvalue.ts FairValueLoop                       src/alerts.ts        Alerter
src/housekeeping.ts  pruning, balance check          src/wallet.ts        KeypairWallet for the Pyth receiver
```
