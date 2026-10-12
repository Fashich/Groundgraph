# groundgraph (Anchor program)

On-chain program for Groundgraph: non-custodial ABOVE/BELOW price markets on Solana. A market asks whether an asset's Pyth price will
be above a target at a settlement time. Outcome shares are SPL tokens that settle at $1 or $0; one ABOVE plus one BELOW (a complete set)
is always worth exactly 1 USDC. Prices come from a fixed-product AMM over virtual reserves (docs/AMM.md) and settlement reads a verified
Pyth `PriceUpdateV2` account.

* Program id: `5W8BS9j9ZFH7Uscjq2Sh7tU5SVmvf7Ay3fJMDjTnRPCC` (keypair in `.keys/program.json`, git-ignored)
* Framework: Anchor 1.2.1, SPL Token (classic) through raw CPIs, `pyth-solana-receiver-sdk` 2.0.0, SBPF v3 build of about 266 KB
* IDL: `programs/groundgraph/idl/groundgraph.json` (copied to `packages/sdk/src/idl/` with `pnpm --filter @groundgraph/sdk sync-idl`)
* Deployment record: `programs/groundgraph/deployments/devnet.json` (`deployed` is true only after `scripts/deploy-devnet.sh` succeeded)

## Layout

```
src/lib.rs              program entry, instruction dispatch
src/math.rs             pure integer AMM, fee and settlement math (mirrored by packages/sdk/src/math.ts)
src/parity.rs           test-only generator of packages/sdk/test/vectors.json and account-samples.json
src/state.rs            Config, FeedAllowlist, Market accounts and enums
src/spl.rs              raw SPL Token CPIs and hand-written token account / mint parsing
src/events.rs           emit! events (decoded off-chain from "Program data:" log lines)
src/errors.rs           error codes (6000+) and their messages
src/instructions/       admin, create_market, trade (buy, sell, merge), settle (settle_close, void_market), redeem (redeem, remove_liquidity)
../../tests/            LiteSVM integration suite (crate groundgraph-tests)
```

## PDAs

| Account | Seeds |
|---|---|
| Config | `["config"]` |
| FeedAllowlist | `["feed", feed_id]` |
| Market | `["market", creator, nonce (u64 LE)]` |
| Vault (USDC token account, owner = market) | `["vault", market]` |
| ABOVE mint, BELOW mint, LP mint (authority = market) | `["above", market]`, `["below", market]`, `["lp", market]` |

## Instructions

| Instruction | Who | What |
|---|---|---|
| `initialize_config(params)` | upgrade authority | creates the singleton config (admin, treasury, collateral mint, limits); `min_duration_secs` must exceed `trading_close_secs` |
| `update_config(params)` | admin | any subset of the fields, validated against hard bounds; also pauses and unpauses |
| `allow_feed(feed_id, symbol, expo)` / `disallow_feed(feed_id)` | admin | Pyth feed allowlist |
| `create_market(params)` | anyone | Close markets only; seeds liquidity at `p0_bps`, creates the vault and three mints, sends the creator LP tokens and any leftover shares; blocked while paused |
| `buy(side, usdc_in, min_shares_out)` | anyone | while Open and before `trading_end_ts`; blocked while paused |
| `sell(side, shares_in, min_usdc_out)` | anyone | while Open, also after `trading_end_ts`; never paused |
| `merge(amount)` | anyone | burns equal ABOVE and BELOW and returns USDC 1:1, no fee; while Open |
| `settle_close()` | anyone | at or after `settle_ts` with a fully verified `PriceUpdateV2` published in `[settle_ts, settle_ts + max_staleness_secs]`; strictly above the target means ABOVE |
| `void_market()` | anyone | `settle_ts + 3600` or later while still Open |
| `redeem(side, amount)` | holders | Settled: winning side at 1 USDC; Voided: either side at 0.5 USDC |
| `remove_liquidity(lp_amount)` | LP holders | after Settled or Voided, pro rata share of the frozen LP claim |

Reserved and rejected with `NotEnabledInThisVersion`: Touch markets (`kind = touch`), `add_liquidity` and the UserGuard fields.

Events: `MarketCreated`, `Trade`, `Settled`, `Voided`, `Redeemed`, `Merged`, `LiquidityChanged` (emitted by remove_liquidity; add_liquidity is reserved), `ConfigUpdated`, `FeedUpdated`.

## Build and test

```
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
cargo build-sbf --manifest-path programs/groundgraph/Cargo.toml --sbf-out-dir target/deploy   # target/deploy/groundgraph.so
cargo test -p groundgraph --lib                                   # 26 unit and property tests; regenerates the SDK parity vectors
cargo +1.99.0 test -p groundgraph-tests                           # 40 LiteSVM integration tests (needs rustc >= 1.97.1 for litesvm 0.18)
cargo +1.99.0 test -p groundgraph-tests --test cu -- --nocapture  # compute unit table (also in docs/AMM.md)
pnpm --filter @groundgraph/sdk test                               # SDK parity, builders vs IDL, LiteSVM end to end against the .so
```

The integration suite covers the full lifecycle (create, buy, sell, merge, settle, redeem, remove liquidity), the void path, pause, all
three base fees and the dynamic fee, exact vault draining, a randomized model comparison, and at least one negative test per account
constraint and error code. Set `CARGO_BUILD_JOBS=2` on small machines.

## Deploy to devnet

```
scripts/deploy-devnet.sh --check      # prints the deployer balance and the SOL required, exits 2 if short
scripts/deploy-devnet.sh              # deploys or upgrades, verifies the bytes by SHA-256, writes deployments/devnet.json
pnpm --filter @groundgraph/scripts bootstrap:devnet   # test USDC mint, config, feed allowlist, six seeded markets
pnpm --filter @groundgraph/scripts smoke:devnet       # buy/sell/merge on a seeded market, asserts SDK quote == on-chain fill
```

Keys live in `.keys/` (git-ignored): `program.json` (program address), `deployer.json` (payer and upgrade authority), `admin.json`,
`maker.json`, `keeper.json`, `faucet.json` (mint authority of the test USDC). Only the deployer needs SOL up front; the bootstrap
distributes what the other keys need. Rent for the 280,000 byte ProgramData allocation is about 1.42 SOL at the current devnet rate.

## Security notes

See docs/THREAT_MODEL.md. In short: all authorities are PDAs, all math is checked and rounds in favor of the pool, `vault >= complete_sets + fee_pool`
is re-checked on every trade, pause can never block exits, config initialization is restricted to the upgrade authority, and the oracle
check requires full verification, the right feed, a short publish window and a confidence bound. The program is unaudited; the upgrade authority is a
single devnet key and must move to a multisig before any mainnet use.
