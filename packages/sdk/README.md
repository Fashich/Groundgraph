# @groundgraph/sdk

TypeScript client for the Groundgraph program (ABOVE/BELOW price markets on Solana, settled by Pyth) and the shared model
code of the apps: AMM math that is bit-exact with the Rust program, fair value and smart money radar math, account and
event decoders, instruction builders and the API contract types. All on-chain amounts are `bigint` base units (6 decimals).

```
pnpm --filter @groundgraph/sdk test        # 131 tests: parity vectors, decoders, builders vs IDL, properties, LiteSVM end to end
pnpm --filter @groundgraph/sdk typecheck   # tsc --noEmit, strict
pnpm --filter @groundgraph/sdk sync-idl    # copy programs/groundgraph/idl/groundgraph.json into src/idl after a program change
```

The package is consumed from source (`main` and `types` point at `src/index.ts`). Runtime dependencies: `@solana/web3.js` 1.99.0 and
`@solana/spl-token` 0.4.15 only.

## Program id

`PROGRAM_ID` resolves from the `PROGRAM_ID` environment variable (node) and otherwise from
`programs/groundgraph/deployments/devnet.json` (`DEVNET_DEPLOYMENT`), which `scripts/deploy-devnet.sh` rewrites after a deploy.

## Quick tour

```ts
import {
  Connection, PublicKey,
} from '@solana/web3.js';
import {
  decodeConfig, decodeMarket, simulateBuy, buildBuyIx, toUnsignedV0Tx, parseEventsFromLogs, pda, effectiveStatus,
} from '@groundgraph/sdk';

const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
const marketPk = new PublicKey('...');
const market = decodeMarket((await conn.getAccountInfo(marketPk))!.data);
const config = decodeConfig((await conn.getAccountInfo(pda.config()))!.data);

// Quote exactly what the program will do (fee, impact, new reserves), including the dynamic fee at `now`.
const now = Math.floor(Date.now() / 1000);
const sim = simulateBuy(market, config.maxFeeBps, 'above', 5_000_000n, now);
console.log(sim.quote.sharesOut, sim.fee.totalBps, sim.quote.priceAfter);

// Build an unsigned transaction for the wallet to sign (ATA creation is included, idempotent).
const ixs = buildBuyIx({ market, marketPk, user, side: 'above', usdcIn: 5_000_000n, minSharesOut: sim.quote.sharesOut });
const tx = toUnsignedV0Tx({ payer: user, instructions: ixs, blockhash, computeUnitLimit: 250_000 });

// After confirmation: decode the program's events from the transaction logs.
const events = parseEventsFromLogs(logMessages);          // only lines emitted by this program
```

## Surface

Everything is re-exported from `src/index.ts`. The names required by `build-notes/SDK_INTERFACE.md` are all present with the same semantics.

| Module | Exports |
|---|---|
| `api-types` | the fixed HTTP/WS contract (unchanged) |
| `constants` | `USDC_DECIMALS`, `MIN_TRADE_USDC`, `MIN_SELL_GROSS_USDC`, `MAX_RESERVE`, `P0_MIN_BPS`, `P0_MAX_BPS`, `ALLOWED_BASE_FEES_BPS`, `VOID_GRACE_SECS`, `PROGRAM_ID`, `DEVNET_DEPLOYMENT`, `PYTH_RECEIVER_PROGRAM_ID`, `PYTH_PUSH_ORACLE_PROGRAM_ID`, `TOKEN_PROGRAM_ID`, `ASSOCIATED_TOKEN_PROGRAM_ID`, `BPF_LOADER_UPGRADEABLE_PROGRAM_ID`, `PYTH_FEEDS` (SOL, BTC, ETH, JUP, WIF, BONK with `feedIdHex`, `symbol`, `expo`), `parseAssetFeed`, `feedIdFromHex`, `feedIdToHex`, `pythPushFeedAddress` |
| `math` | `priceBps`, `priceAbove`, `feeCeil`, `isqrt`, `ceilSqrt`, `impactBps`, `quoteBuy`, `quoteSell`, `seedReserves`, `applySlippage`, `nearFeeBps`, `flowFeeBps`, `updateEma`, `feeBpsNow`, `settledLpClaim`, `voidLpClaim`, `voidRedeemPayout`, `lpPayout`, `comparePrice`, `confidenceOk`, `GgMathError`, types `Pool`, `FeeState`, `BuyQuote`, `SellQuote`, `SeedResult` |
| `simulate` | `simulateBuy`, `simulateSell` (quote plus fee breakdown plus the market account after the trade) |
| `fair-value` | `normCdf`, `fairValueClose`, `fairValueTouch`, `expectedArbLossUsdc`, `impliedProbability`, `realizedVol`, `toOpeningBps` |
| `radar` | `radarProbability` |
| `format` | `formatUsdc`, `formatPct`, `formatPrice`, `buildQuestion` |
| `pda` | `pda.config()`, `pda.feed(feedId)`, `pda.market(creator, nonce)`, `pda.vault`, `pda.aboveMint`, `pda.belowMint`, `pda.lpMint`, `pda.programData()` |
| `accounts` | `decodeMarket`, `decodeConfig`, `decodeFeed`, `encodeMarket`, `encodeConfig`, `encodeFeed`, `effectiveStatus`, `marketPool`, `marketFeeState`, types `MarketAccount`, `ConfigAccount`, `FeedAccount` |
| `events` | `GgEvent` (MarketCreated, Trade, Settled, Voided, Redeemed, Merged, LiquidityChanged, ConfigUpdated, FeedUpdated), `parseEventsFromLogs`, `decodeEvent`, `encodeEvent`, `encodeEventLogs`, `EVENT_NAMES` |
| `instructions` | `buildBuyIx`, `buildSellIx`, `buildMergeIx`, `buildRedeemIx`, `buildRemoveLiquidityIx`, `buildCreateMarketIx`, `buildSettleCloseIx`, `buildVoidMarketIx`, `buildInitializeConfigIx`, `buildUpdateConfigIx`, `buildAllowFeedIx`, `buildDisallowFeedIx`, `buildInstruction`, `userAccounts`, `ata`, `DEFAULT_CONFIG_PARAMS`, `INSTRUCTION_NAMES` |
| `tx` | `toUnsignedV0Tx` |
| `pyth` | `decodePriceUpdateV2`, `encodePriceUpdateV2`, `PRICE_UPDATE_V2_DISCRIMINATOR`, `PRICE_UPDATE_V2_SIZE` (used by tests and scripts to read and fabricate update accounts) |
| `idl`, `codec` | the vendored IDL (`IDL`), `PROGRAM_ERRORS`, `programErrorName(code)`, discriminator helpers, and the borsh `BorshReader`/`BorshWriter` plus `decodeDefined`/`encodeDefined` used by everything above |

Conventions: side is `'above' | 'below'` (lowercase, as on the wire), prices from the math are numbers in 0..1 or integer basis points,
timestamps are unix seconds as numbers in the math and `bigint` inside decoded accounts (`i64` fields).
Decoded accounts use camelCase field names that mirror the IDL (for example `reserveAbove`, `tradingEndTs`, `lpClaimRemaining`).

## How correctness is checked

* **Parity.** `test/vectors.json` is generated by the Rust program (`cargo test -p groundgraph --lib parity`): 2000+ cases for `quoteBuy`,
  `quoteSell`, `seedReserves`, `feeBpsNow`, `updateEma`, LP and void math, price comparison, `isqrt`. The TypeScript results must match to the last base unit, errors included.
  `test/account-samples.json` holds Market, Config and Feed account bytes with their decoded values, and the events section holds raw event bytes.
* **Properties.** fast-check: a buy never decreases the product `ra * rb`, buying ABOVE raises the ABOVE price, a buy followed by a sell never returns more than was paid, a sell is maximal (one more unit would break the invariant), seeds reproduce the requested price within one basis point, `feeCeil` and `isqrt` match their definitions, the EMA stays between its old value and the new impact, and random trade sequences conserve USDC (`vault == complete sets + fee pool`, every holder can exit at or below cost).
* **Builders vs IDL.** Every builder's account list is compared with the IDL order, writability and signer flags, and arguments round trip through the codec.
* **End to end.** `test/e2e.litesvm.test.ts` loads `target/deploy/groundgraph.so` into LiteSVM (npm `litesvm` 1.6.0), runs create, buy, sell, merge, settle (with a fabricated `PriceUpdateV2`), redeem, remove liquidity and void through the SDK builders, and checks that `simulateBuy`/`simulateSell` equal the on-chain Market account after each step. It is skipped automatically when the `.so` has not been built.
* **Known values.** fair value (`N(d2)`), touch fair value, expected arbitrage loss and the radar formulas are pinned to hand-computed numbers.

## Deviations and extensions

* Additions beyond SDK_INTERFACE.md: `simulateBuy`/`simulateSell`, `encode*` functions (used to fabricate accounts in tests), the PriceUpdateV2 codec, IDL and codec exports, `pda.programData()`, `toOpeningBps`, `realizedVol`, error-name helpers, and `buildCreateMarketIx` also returns the derived `accounts` (vault and mints).
* `buildQuestion` for Touch markets follows the semantics rather than the example string in SDK_INTERFACE.md: a `down` barrier reads "holds above $X or breaks below?" and an `up` barrier "holds below $X or breaks above?". This is the same wording the existing `packages/svc-core/src/sdk-double.ts` uses. Touch markets are not enabled on chain in this version.
* `ConfigAccount` has a `tradingCloseSecs` field (the program stores the trading cutoff in the config; see docs/DECISIONS.md ADR-006). `MarketAccount.tradingEndTs` is what clients should use per market.
* `effectiveStatus` derives `trading_closed` from the clock (`now >= tradingEndTs` while the stored status is open); the program never stores it.
* `packages/svc-core/src/sdk-double.ts` is now redundant: `chain.ts` already prefers the real SDK for each name it needs, and the real SDK exports every one of them. The file was not modified because it belongs to another package.
* The Pyth Hermes and Benchmarks HTTP APIs are not wrapped here (they need an API key). `settle_close` accepts any fully verified `PriceUpdateV2` account, so a keeper may obtain it from any source and pass its address to `buildSettleCloseIx`.
