# Groundgraph threat model (Phase 1, devnet)

Scope: the `groundgraph` Anchor program (`programs/groundgraph`), the way the SDK builds transactions for it, and the devnet
operating setup (keys, bootstrap, keeper). The web app, API, indexer and scorer are out of scope here except where they
touch the chain. This is a design-time review by the authors, not an external audit; nothing in this document should be read
as an audit statement.

## 1. Assets and actors

| Asset | Where it lives | Who may move it |
|---|---|---|
| Collateral (USDC) | `vault` token account per market, authority = market PDA | only program instructions: buy (in), sell, merge, redeem, remove_liquidity (out) |
| Outcome shares (ABOVE, BELOW) and LP tokens | SPL mints created with the market PDA as mint authority and no freeze authority | minted only by buy and create_market |
| Program configuration | `Config` PDA | admin key |
| Program code | BPF upgradeable loader | upgrade authority (the deployer key on devnet) |

Actors: traders, liquidity providers (the market creator in Phase 1), a permissionless keeper that submits settlement
transactions, the admin (config and feed allowlist), the upgrade authority, and Pyth (oracle).

## 2. Trust assumptions

1. Pyth publishes an honest aggregate price and the Pyth receiver program verifies Wormhole signatures (we check the
   verification level is `Full` and the account is owned by the receiver program).
2. Solana's `Clock` sysvar is accurate to a few seconds. The oracle window is 60 seconds, so a clock error of that order only shifts when a market can settle.
3. The admin cannot take user funds (section 4.1) but can pause new buys and change oracle strictness (section 4.5). The upgrade authority can replace the program; on devnet that is a single hot key, before mainnet it must be a multisig (Squads) and then ideally frozen.
4. The collateral mint is a classic SPL Token mint with 6 decimals. Token-2022 is not supported and rejected by the token program id check.

## 3. Controls checklist

| Area | Control | Where |
|---|---|---|
| Account substitution | Config, market and feed PDAs are validated with `seeds` and `bump`; vault, outcome mints and LP mint are PDAs derived from the market and compared with `address =` against the fields stored in the market | `instructions/*` |
| Token accounts | the user's USDC and outcome accounts are parsed manually and must be owned by the signer, have the right mint and be owned by the token program; wrong accounts fail with `WrongTokenAccount` | `spl.rs` |
| Token program | the `Program<Token>` account must be the classic SPL Token program; CPIs are raw `invoke_signed` to that id (no `anchor-spl`) | `spl.rs` |
| Authorities | the market PDA is the only mint authority of ABOVE, BELOW and LP and the owner of the vault; the three mints are created without a freeze authority; the collateral mint is chosen once by the upgrade authority in `initialize_config` (must be an initialized 6 decimal classic SPL mint) and users cannot substitute their own | `create_market.rs`, `admin.rs` |
| Arithmetic | all math is checked, uses u128 intermediates, and never truncates with `as` without a bound; reserves and trade sizes must stay below 2^62 (`b^2` in the sell quadratic then fits in u128) | `math.rs` |
| Rounding | fees round up, shares out round down, pool reserves round up; property tests assert the product `ra * rb` never decreases and that all obligations stay below the vault | `math.rs`, `tests/` |
| Slippage | `min_shares_out` and `min_usdc_out` on every trade; zero amounts, buys below 1 USDC and sells paying under 0.01 USDC are rejected | `trade.rs` |
| Solvency | every buy and sell re-checks `vault >= complete_sets + fee_pool` and fails with `InvariantViolated` otherwise; redeem and remove_liquidity check the vault holds the payout; merge lowers `complete_sets` by exactly the USDC it transfers out | `trade.rs`, `redeem.rs` |
| Reentrancy | state is updated before CPIs and CPIs go only to the fixed SPL Token program | `trade.rs` |
| Pause | a `paused` flag blocks `create_market` and `buy` only; sell, merge, settle, void, redeem and remove_liquidity are never paused, so pausing cannot trap funds | `admin.rs`, `trade.rs` |
| Initialization | `initialize_config` can only be signed by the program's upgrade authority (the program parses `ProgramData`), so nobody can front-run the deployer and become admin; the config is a singleton PDA | `admin.rs` |
| Oracle | see section 4.5 | `settle.rs` |
| Phase 2 features | Touch markets, add_liquidity and UserGuard are reserved and rejected with `NotEnabledInThisVersion` | `create_market.rs` |

## 4. Threats and decisions

### 4.1 Admin and upgrade authority

* The admin can: pause and unpause buys and market creation, change configuration within hard bounds (`validate_config`: max fee 2% to 10%, min liquidity at least 1 USDC, min duration at least 60 s, oracle staleness 1 to 3600 s, confidence 1 to 1000 bps), add and remove feeds from the allowlist, and change the treasury (unused in Phase 1: the protocol fee share is 0).
* The admin cannot: move vault funds, mint outcome tokens, change a market's stored parameters (fee, settle time, trading end, collateral mint are fixed at creation), or block sells and redemptions.
* Removing a feed from the allowlist stops new markets on that feed; settlement of existing markets only needs the feed id stored in the market.
* The upgrade authority is the real root of trust. Devnet: `.keys/deployer.json`. Mainnet requirement: transfer to a Squads multisig, then decide whether to freeze the program.

### 4.2 Rounding drain and accounting

Every rounding direction favors the pool (AMM.md section 3). Two layers of tests back this up. Pure-math property tests (`cargo test -p groundgraph --lib`) assert that the product `ra * rb` never decreases, that a round trip never returns more than was paid, and that LP payouts sum to the claim. Randomized end to end runs through the real program in LiteSVM (`tests/tests/properties.rs`) compare every buy, sell and merge with the pure model and check after each step that `vault == N + fee_pool` and that each outcome supply equals `N` minus the matching virtual reserve. They then settle or void the market at random, let everyone redeem and the liquidity provider withdraw: after a settlement the vault ends at exactly zero, after a void at no more than one base unit per redemption (the floor of `amount / 2`). Donations (plain USDC transfers into a vault) make `vault > N + fee_pool`; the surplus is not claimable by anyone and cannot break the invariant, which is why the program checks `>=` and not `==`. Outcome mints cannot be inflated except by the program.

### 4.3 Market creation abuse (dust and spam)

* A creator must lock at least `min_liquidity` (100 USDC by default) and pay rent for the market, three mints, the vault and their token accounts; the liquidity is returned (plus fees, minus losses) through `remove_liquidity` after settlement. Spam therefore has a real cost, but there is no on-chain registry limit: any wallet can create markets on any allowlisted feed. Discovery layers (indexer, API) must apply their own curation.
* A creator can open a market away from the fair price. That only costs the creator (they are the liquidity provider) and is visible to every trader through the price. The SDK and the bootstrap scripts open at the digital-option fair value.
* Pre-funding a market PDA with lamports to break `create_account` does not work: the program tops up, allocates and assigns instead (`create_market.rs`).
* Duration is bounded by `min_duration_secs` and `max_duration_secs`, strictly greater than the trading close buffer, so every market has a trading window.

### 4.4 Liquidity provider risks

* In Phase 1 there is no `add_liquidity`, so LP tokens are minted once at creation (1 LP token per USDC of seed liquidity). That removes the classic attack of manipulating the price and then minting or redeeming LP shares around it, and it removes LP share price manipulation entirely.
* `remove_liquidity` works only after settlement or void, using a claim frozen at that moment, so it cannot be sandwiched.
* Adverse selection near expiry (accepted risk). Buying stops at `trading_end_ts` (by default one hour before settlement), but selling and merging stay open until settlement or void. A holder who becomes confident that their side will lose can sell back to the pool at a stale price during that final hour. They cannot add new exposure, only reduce theirs, and the pool receives the shares it will later see settle at $0, so the loss is bounded by the outcome tokens that holder already held. The optional dynamic fee adds up to 80 bps near expiry and up to 50 bps for recent flow to compensate. The alternative (blocking sells) would trap holders if the oracle fails, which was judged worse.
* LPs are exposed to price risk by design: if the market opens at the wrong price an arbitrageur extracts `L * (1 - 2 sqrt(p* (1 - p*)))` (AMM.md section 4).

### 4.5 Oracle and settlement

Checks in `settle_close`: the market is Open and of kind Close; `now >= settle_ts`; the account is a `PriceUpdateV2` owned by the Pyth receiver program (Anchor's `Account<PriceUpdateV2>` verifies owner and discriminator); verification level `Full`; the feed id equals the market's feed id; `publish_time` lies in `[settle_ts, settle_ts + max_staleness_secs]`; the price is positive; `conf * 10000 <= max_conf_bps * price`; exponents are normalised exactly with i128; strictly above the target means ABOVE.

Residual risks and how they are handled:

1. Price selection inside the window. Any fully verified update with a publish time in the 60 second window is valid, so a party with a position can choose which of the updates in that window to submit. The window is deliberately short and the keeper submits the first update it sees, but the risk is real and bounded by price movement within one minute. A tighter rule (the update closest to `settle_ts`, or a first-update-only rule) needs a Pyth feature the receiver does not offer on chain; it is listed as a known gap.
2. Oracle liveness. If nobody can produce a valid update for the window, the market stays Open. Holders can still sell and merge. After `settle_ts + 3600` anyone can call `void_market`: every share then pays 0.5 USDC and the LPs get the remainder. Voiding is a refund of the position at the midpoint, not a fair settlement, which is why the grace period is a full hour.
3. Sponsored push feeds. The shard-0 price feed accounts that Pyth sponsors update only every so often, so the latest account content will usually not fall inside a specific 60 second window. The keeper therefore has to obtain a signed update for the settlement time and post it (the program accepts any verified `PriceUpdateV2` account, whichever way it was created). Pyth's historical and Hermes APIs now require an API key; without one the keeper can only settle markets whose window happens to match a posted account, and everything else ends in a void after one hour. This is an operational dependency, not a program flaw.
4. Admin influence on oracle strictness. `max_staleness_secs` and `max_conf_bps` are read from the config at settlement time, so a malicious admin could widen them for existing markets (hard bounds: 1 hour and 10%). This is part of the admin trust assumption in section 2.
5. Edge cases covered by tests: both window boundaries are inclusive and one second outside fails, confidence exactly at the limit is accepted and just above it is rejected, an oracle exponent finer than the target's is compared exactly, and a price equal to the target settles BELOW.

### 4.6 Front-running and MEV

* Trades are protected by slippage limits. Public mempool-style sandwiching of a user's buy is limited by the user's `min_shares_out`; the fee and the price impact are visible in the quote the SDK returns.
* Settlement front-running: settlement is permissionless and idempotent in effect (the first valid transaction wins), and the program does not pay a settlement bounty, so there is nothing to race for except the price selection issue above.
* Redemption is unconditional once settled; nothing depends on transaction ordering.

### 4.7 Denial of service

Compute use is small and constant (AMM.md section 8). The only loop is the defensive `y -= 1` check in the sell root, which runs zero times on valid inputs. Accounts are fixed-size. Pausing buys is the only operation that can stop activity and it never affects exits.

### 4.8 Off-chain surface that touches the chain

* Events are decoded from `Program data:` log lines. `parseEventsFromLogs` follows the invocation stack and only accepts lines emitted while this program is the executing program, so another program cannot spoof an event by printing data.
* The SDK builds unsigned transactions; keys never leave the user's wallet. The scripts use keys from `.keys/` (git-ignored) and never print secret material.
* Account order and argument encoding are derived from the generated IDL, and tests compare every builder with the IDL, so a mismatch between SDK and program fails in CI, not on chain.

## 5. Known gaps and mainnet blockers

| Gap | Why it matters | Planned handling |
|---|---|---|
| Not externally audited | Phase 1 devnet scope | audit before any mainnet deployment |
| Upgrade authority is a single key | key loss or compromise replaces the program | Squads multisig, then freeze or timelock |
| Admin is a single key | can pause buys and tune oracle strictness | multisig admin |
| Price selection within the 60 s window | a position holder can choose among valid updates | shorter window and a keeper that always submits first; evaluate Pyth features that pin the update to `settle_ts` |
| Collateral mint freeze authority is not checked | if the collateral mint has a freeze authority (real USDC does), its issuer can freeze a vault and strand a market; the devnet test mint has none | accept the issuer trust assumption explicitly at mainnet design time, or restrict to mints without a freeze authority |
| Touch markets, add_liquidity, UserGuard | not implemented | reserved in the account layout and rejected with `NotEnabledInThisVersion` |
| Oracle history needs an API key | markets whose window was missed end in a void | operate a keeper with an API key, or post updates from a Hermes node |
