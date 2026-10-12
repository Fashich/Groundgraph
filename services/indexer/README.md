# @groundgraph/indexer

Follows the Groundgraph program on Solana and turns its events into rows in Postgres plus live deltas in Redis. It is the only writer of `trades`, `positions`, `scored_positions`, `liquidity_events`, `redemptions`, `merges`, `market_ticks` and of the market state columns (reserves, status, outcome, fee state).

Environment variables: see [`../README.md`](../README.md#indexer-servicesindexer). Health and metrics: `http://localhost:9102/healthz`, `/metrics`.

```bash
pnpm --filter @groundgraph/indexer start                 # long-running process
pnpm --filter @groundgraph/indexer backfill              # one-off history walk, then exits
pnpm --filter @groundgraph/indexer backfill --reset --since 2026-10-01 --limit 5000 --batch 100
pnpm --filter @groundgraph/indexer test                  # real Postgres svc_indexer + Redis DB 2, in-memory ledger
```

## How it works

1. **Poll.** Every `INDEXER_POLL_INTERVAL_MS` (or sooner when woken) it calls `getSignaturesForAddress(PROGRAM_ID, { until: cursor })` at `confirmed`, collects the new signatures newest first and processes them **oldest first**. The cursor `{signature, slot}` is persisted in `indexer_state` (`indexer:cursor`). If the cursor signature has vanished it restarts 64 slots earlier; reprocessing is harmless.
2. **Decode.** `getTransaction` for each signature, program events are parsed from the logs with the SDK (`parseEventsFromLogs`). Failed transactions are ignored. `ix_index` is the ordinal of the event among all program events of the transaction.
3. **Write.** Each event is inserted with `ON CONFLICT (tx_sig, ix_index) DO NOTHING`, so re-reading a range, a restart or a second pass never duplicates a row. Positions are **rebuilt from the sorted event list** of (wallet, market) by a pure fold (`src/positions.ts`: proportional cost release on sells, merges split by released cost, creator seed shares carried at the opening price) under a `SELECT ... FOR UPDATE` on the market row, so out-of-order arrival converges to the same result. `scored_positions` (what the radar scores) follows the same fold.
4. **Reconcile.** After each batch and every `INDEXER_RECONCILE_INTERVAL_SECS` the market account is read and copied (reserves, complete sets, fee pool, EMA, status, outcome, settle price). The account is authoritative, so a dropped `Settled` event reverts as well.
5. **Finalize.** Rows start unfinalized. Every `INDEXER_FINALIZE_INTERVAL_SECS` the signatures are checked with `getSignatureStatuses`: finalized rows are promoted; rows whose transaction is missing in two consecutive passes and whose slot is more than `INDEXER_DROP_GRACE_SLOTS` below the finalized slot are deleted and the positions rebuilt.
6. **Ticks.** A `market_ticks` row per trade plus a 1-minute snapshot of every open market (`INDEXER_TICK_INTERVAL_SECS`).
7. **Publish.** `gg:ch:market:{id}` gets a `WsMarketDelta` plus the trade (settle and void deltas add `status` and `outcome`); `gg:ch:me:{wallet}` gets `fill`, `created`, `redeemed`, `merged`, `liquidity`, `settled` or `voided` for each affected holder. It also publishes `hb:indexer` (with `indexedSlot`) every 5 s.

Other behaviors:

- **Fresh database.** The newest page is processed first so the app has data immediately, then the history is walked backwards in idle time (`indexer:backfill` `{before, done, processed}`, resumable). `backfill --reset` rewinds that walk. Live and backfill converge to identical rows (tested).
- **Unknown markets.** A `MarketCreated` event (or a trade on a market that is not in the database) is bootstrapped from the on-chain account; the question text is taken from the Redis hint `q:pending:{market}` the API wrote at build time, otherwise it is generated from the market parameters. Events for markets that do not exist on chain are skipped (orphan rule).
- **Responsible trading.** A buy or create fill consumes the API's `rt:pending:{wallet}` reservation and adds to `user_settings.spent_today` once, only on the first insert and only on the UTC day of the fill.
- **Leader election.** A Postgres advisory lock (key 7274101) makes a second indexer wait; the backfill CLI uses 7274102 so it can run next to the service.
- **Wake-ups.** A Redis message on `gg:indexer:nudge` (API after sending, Helius webhook) polls immediately. With `RPC_WS_URL` or `HELIUS_API_KEY` a `logsSubscribe` connection does the same on every program log.
- **RPC choice.** With `HELIUS_API_KEY` and no `RPC_URL`, the Helius endpoints are used. The key is never logged (the log shows `helius-devnet`).

## Known gaps

- Share balances are derived from program events only; SPL transfers of ABOVE/BELOW tokens between wallets are not followed.
- `lp_positions.fees_earned` is not computed.
- Trade ticks of a transaction that is later dropped are not deleted.
- Two transactions in the same slot are ordered by signature, not by their position in the block.

## Layout

```
src/index.ts      wiring, health endpoint, shutdown      src/positions.ts  pure position fold
src/run.ts        loops (poll, reconcile, finalize, ticks) src/store.ts      SQL
src/indexer.ts    Indexer: one batch, reconcile, finalize  src/publish.ts    Redis publishing
src/source.ts     ChainSource interface + RPC source       src/decode.ts     tx -> events
src/backfill.ts   CLI                                      src/helius.ts     optional logsSubscribe nudge
```
