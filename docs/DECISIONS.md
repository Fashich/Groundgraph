# Architecture decision records

Short ADRs for the on-chain program, the SDK and the devnet tooling. One paragraph each: context, decision, consequence.
Newest entries are appended at the end.

## ADR-001: Virtual pool reserves instead of pooled token accounts

Status: accepted (12 Oct 2026). Context: an outcome-share AMM normally needs pool-owned token accounts for each side, extra rent and extra CPI calls per trade. Decision: the pool holds no outcome tokens; `reserve_above` and `reserve_below` are bookkeeping fields, the real supply of each outcome is `complete_sets - reserve`, and only USDC sits in one vault. Buys mint shares to the user and sells burn them. Consequence: a trade is one USDC transfer plus one mint or burn (about 18k compute units), the invariants `vault >= N + fee_pool` and `supply == N - reserve` are checkable on chain and in tests, and nobody can hold pool tokens by accident. The price is that a market cannot be inspected by looking at token balances alone; the SDK decodes the reserves from the Market account.

## ADR-002: Phase 1 ships Close markets only; Phase 2 features are reserved, not half built

Status: accepted. Context: the deadline allows one fully tested market type. Decision: `kind` and `direction` stay in the account layout and in `create_market`, and Touch markets, `add_liquidity` and the UserGuard fields exist as reserved variants that fail with `NotEnabledInThisVersion` before touching any state. Consequence: the account layout will not need a migration when Touch ships, and the program cannot be driven into an untested path. The cost is a few unused fields per market.

## ADR-003: TradingClosed is derived from the clock, not stored

Status: accepted. Context: a stored `TradingClosed` status would need a transaction to flip it, and nobody has an incentive to send one. Decision: the stored status is `Open | Settled | Voided`; `buy` checks `now < trading_end_ts` itself, and clients compute the `trading_closed` display state with `effectiveStatus(market, now)`. Sells and merges stay allowed after `trading_end_ts` while the market is Open so holders can always exit if the oracle is late. Consequence: no keeper dependency for the status, at the cost of adverse selection for liquidity providers in the last hour (see THREAT_MODEL.md section 4.4).

## ADR-004: Dynamic fee uses the decayed EMA before the trade, with a linear half-life approximation

Status: accepted. Context: the design gives the EMA decay as `(65536 >> n) * (3600 - rem) / 3600`, which is a linear interpolation of the half-life, and says the fee uses the EMA before the trade. Decision: the fee for a trade at time `now` is computed from the stored EMA decayed to `now` (so a quiet market loses its "Recent flow" surcharge over time without anyone touching it), the trade is then priced, and only afterwards is the price impact folded into the stored EMA. The same fixed-point function is used by the program and the SDK. Consequence: a single large trade cannot raise its own fee, fee quotes are exact for any `now`, and the approximation slightly overstates the EMA between half-lives (documented in AMM.md section 5).

## ADR-005: LP claim is snapshotted at settlement

Status: accepted. Context: liquidity providers must be paid the pool's remaining winning-side tokens plus the fee pool, but pool reserves and the LP supply would otherwise keep changing as users redeem. Decision: `settle_close` and `void_market` store `lp_claim_remaining` and `lp_supply_remaining`; `remove_liquidity` pays `floor(claim_remaining * lp / supply_remaining)` and decrements both, so the last provider gets the exact remainder. Settled claim: winning reserve plus fee pool. Void claim: `(N + fee_pool) - ceil((realA + realB) / 2)`, and voided redemptions pay `floor(amount / 2)` per side. Consequence: LP exits cannot be sandwiched or reordered, rounding always favors the vault, and a randomized test drains a settled vault to exactly zero.

## ADR-006: `trading_close_secs` is a Config field

Status: accepted (deviation from PROGRAM_DESIGN.md, which hard-codes one hour). Context: the devnet demo needs markets with a settlement 30 to 60 minutes away so a judge can watch one settle, which a fixed one-hour trading cutoff makes impossible. Decision: `Config.trading_close_secs` (default 3600, bounded to 24h and required to be smaller than `min_duration_secs`) sets the cutoff, and each market stores the resulting `trading_end_ts`, so later config changes never move an existing market's cutoff. The devnet bootstrap uses 300 seconds with a 1800 second minimum duration. Consequence: the production default is unchanged and the demo is possible; the extra field is exposed in the SDK `ConfigAccount` and in `ConfigUpdated`.

## ADR-007: Raw SPL Token CPIs, no `anchor-spl`

Status: accepted. Context: `anchor-spl` pulls in more of the Solana stack, adds binary size and parses token accounts through Anchor wrappers we do not need. Decision: `spl.rs` builds the handful of Token instructions we use (transfer, mint_to, burn, initialize_mint2, initialize_account3) and parses token accounts and mints by hand, checking owner program, mint and owner fields. Consequence: smaller binary (about 266 KB), full control over validation, and only the classic Token program is accepted. Token-2022 is out of scope.

## ADR-008: `initialize_config` is gated on the program upgrade authority

Status: accepted. Context: the config PDA is a singleton, so whoever calls `initialize_config` first becomes admin; a bot watching the deploy could front-run the deployer. Decision: the instruction takes the program's `ProgramData` account, parses the upgrade authority from it by hand, and requires the signer to equal it. Consequence: only the deployer (or the multisig that holds the authority) can initialize, at the cost of one extra account and a 20 line parser covered by tests (non-authority signer rejected, authority succeeds, second initialization fails, a program with no upgrade authority cannot be initialized).

## ADR-009: The vault invariant is `vault >= N + fee_pool`, not equality

Status: accepted (deviation from the design text, which says `==`). Context: anyone can transfer USDC into a market vault, which would make an equality check fail on the next trade and permanently brick the market (a cheap denial of service). Decision: every buy and sell checks `>=`; the surplus is simply unclaimable. Consequence: griefing by donation is harmless, and tests that do not donate still assert exact equality.

## ADR-010: Oracle liveness uses a short publish window plus a one hour void

Status: accepted. Context: a settlement price must be close to `settle_ts`, but the sponsored Pyth push feeds update rarely and Pyth's historical APIs need an API key. Decision: `settle_close` accepts any fully verified `PriceUpdateV2` for the market's feed with `publish_time` in `[settle_ts, settle_ts + 60]` (the update account can be posted later), and `void_market` opens at `settle_ts + 3600` so funds are never stuck: voided shares pay 0.5 USDC. Consequence: settlement works with whatever mechanism the keeper uses to obtain a signed update, but a missed window ends in a void; picking among several valid updates inside the window is a known residual risk (THREAT_MODEL.md section 4.5).

## ADR-011: The program crate is `cdylib` only and optimized for size

Status: accepted. Context: devnet rent for program data is paid in SOL (about 5,080 lamports per byte), and the deployer faucet is rate limited. Decision: `crate-type = ["cdylib"]`, `opt-level = "z"`, fat LTO, `panic = "abort"`, no panic messages, and no `anchor-spl`. Rust tests that need the library code use `cargo test -p groundgraph --lib`. Consequence: a 266 KB binary, which keeps the rent for a 280,000 byte ProgramData allocation to about 1.42 SOL.

## ADR-012: Deploy with a bounded `--max-len`

Status: accepted. Context: `solana program deploy` reserves twice the binary size by default, which would cost about 2.7 SOL on devnet for a 266 KB program. Decision: `scripts/deploy-devnet.sh` passes `--max-len 280000` (override with `MAX_LEN`), checks the deployer balance first and exits with code 2 and the exact SOL shortfall when it is too low, keeps the buffer keypair so an interrupted deploy resumes, and verifies the on-chain bytes against the local binary by SHA-256 before writing `programs/groundgraph/deployments/devnet.json`. Consequence: cheaper deploys; a future binary larger than 280,000 bytes needs `solana program extend` first.

## ADR-013: The collateral mint is chosen by the upgrade authority and its freeze authority is not checked

Status: accepted for devnet, to be revisited before mainnet. Context: a freeze authority on the collateral mint lets its issuer freeze a market vault and strand every position, but real USDC has one, so rejecting such mints would make a mainnet launch impossible without a program change. Decision: `initialize_config` stores one collateral mint, which must be an initialized 6 decimal classic SPL mint, and the signer must be the program upgrade authority; `create_market` only accepts the configured mint, so users cannot bring their own. The three per-market mints (ABOVE, BELOW, LP) are created without a freeze authority. Consequence: the devnet test USDC (faucet key as mint authority, no freeze authority) carries no freeze risk; for real USDC the issuer's freeze power is an explicit trust assumption listed in THREAT_MODEL.md section 5.

## ADR-014: SDK is driven by the generated IDL; builders create associated accounts idempotently

Status: accepted. Context: hand-written account lists and layouts drift from the program. Decision: the SDK vendors the Anchor IDL and derives instruction account order, argument encoding, account layouts and event discriminators from it with one borsh codec; every builder that needs a token account of the user prepends an idempotent ATA creation. Tests compare each builder against the IDL and the end to end test runs the SDK against the real binary in LiteSVM. Consequence: SDK and program cannot silently diverge; transactions carry one extra instruction per new token account (about 4k compute units, only when the account does not exist yet).

## ADR-015: Devnet tooling uses default volatilities and the sponsored push feeds

Status: accepted. Context: the bootstrap needs spot prices and volatilities to open markets at a fair price, but Pyth Hermes and Benchmarks now require an API key. Decision: spot comes from the sponsored shard-0 push feed accounts on the cluster (read with plain RPC, no key), volatility comes from documented annualized defaults (SOL 0.8, BTC 0.5, ETH 0.65, JUP 1.1, WIF 1.4, BONK 1.3) that can be overridden with `VOL_<SYMBOL>`, and the script logs a note whenever a default was used. The scripts live in their own pnpm workspace package (`scripts/`) so they resolve the SDK like any other package. Consequence: the bootstrap has no external service dependency beyond the RPC; opening prices are reasonable but not calibrated to realized volatility.

## ADR-016: LiteSVM tests build on a newer Rust than the program

Status: accepted. Context: `litesvm` 0.18.0 requires rustc 1.97.1 or newer, while the shared machine's stock toolchain is 1.95.0 and the SBF toolchain bundles its own rustc. Decision: keep the stock toolchain for the program and its unit tests, install 1.99.0 as an extra toolchain and run the integration suite with `cargo +1.99.0 test -p groundgraph-tests` (wired into `Anchor.toml`). Consequence: two toolchains on a developer machine; documented in VERSIONS.md.
