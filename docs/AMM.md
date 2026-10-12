# Groundgraph AMM

This document specifies the pricing, fee and settlement arithmetic of the `groundgraph` program (Phase 1: Close markets).
The authoritative implementation is `programs/groundgraph/src/math.rs`; `packages/sdk/src/math.ts` mirrors it bit for bit and
`packages/sdk/test/vectors.json` (2000+ cases generated from the Rust code) enforces that.

All amounts are integers in base units. USDC, outcome shares and LP tokens all have 6 decimals, and one complete set
(1 ABOVE + 1 BELOW) is always redeemable for exactly 1 USDC.

## 1. State and notation

| Symbol | Market field | Meaning |
|---|---|---|
| N | `complete_sets` | complete sets outstanding (USDC locked behind them) |
| ra, rb | `reserve_above`, `reserve_below` | the pool's VIRTUAL holdings of ABOVE and BELOW tokens; never minted |
| F | `fee_pool` | accumulated trading fees, owned by liquidity providers |
| realA, realB | derived | real outstanding supply of each outcome: `N - ra`, `N - rb` |

The pool holds no token accounts for outcomes. Users only ever hold real minted tokens, and the virtual reserves record how
many tokens the pool would hand out. This keeps the pool exact without extra accounts and makes every trade a pure function of
`(ra, rb, N, F)`.

Price of ABOVE: `p = rb / (ra + rb)` (basis points: `floor(rb * 10000 / (ra + rb))`). The BELOW price is `1 - p`. The two prices always
sum to one, so a complete set costs exactly 1 USDC.

Solvency invariant: `vault.amount >= N + F`, with equality unless someone donates USDC directly to the vault (donations are
tolerated and never paid out to individuals, see THREAT_MODEL.md). Every trade checks it before moving tokens.

## 2. Fixed product over complete sets

A buy of ABOVE converts USDC into complete sets, then swaps the unwanted BELOW leg into the pool while the product
`k = ra * rb` is preserved (rounded in favor of the pool).

### Buy (side = ABOVE, `x` USDC in)

```
fee   = ceil(x * fee_bps / 10000)
x'    = x - fee                       (USDC that becomes complete sets)
rb'   = rb + x'
ra'   = ceil(ra * rb / rb')           (reserve rounds UP, so the user rounds DOWN)
out   = ra + x' - ra'                 (shares minted to the user)
N    += x',  F += fee,  ra = ra',  rb = rb'
```

Buying BELOW swaps the roles of ra and rb. Minimum gross trade is 1 USDC; `out >= min_shares_out` is enforced.

Worked example (static 100 bps fee, market opened at 50% with 500 USDC liquidity, so ra = rb = 500.000000):

| Step | Value |
|---|---|
| Buy ABOVE with 100 USDC | fee 1.000000, x' = 99.000000 |
| Pool after | ra = 417.362271, rb = 599.000000 |
| Shares out | 181.637729 ABOVE (average price 0.5505) |
| Price of ABOVE | 0.5000 to 0.5893 (impact 893 bps) |
| Sell all 181.637729 back | gross 98.999999, fee 0.990000, net 98.009999 |
| Pool after the round trip | ra = rb = 500.000001 (product grew by rounding) |

### Sell (side = ABOVE, `s` shares in)

The pool receives `s` ABOVE and redeems `y` complete sets so that the product does not decrease:

```
(ra + s - y) * (rb - y) >= ra * rb
y^2 - (ra + s + rb) y + s * rb >= 0
```

The valid solution is the smaller root. With `b = ra + s + rb` and `c = s * rb`:

```
y  = floor( (b - ceil_sqrt(b^2 - 4c)) / 2 )
```

Rounding the square root up and the division down keeps `y` at or below the true root, so the product can only grow; a
defensive loop decrements `y` while the exact inequality fails (it never triggers on valid inputs, and the Rust and SDK
implementations both contain it). Then:

```
fee    = ceil(y * fee_bps / 10000)
net    = y - fee                       (paid to the user; require net >= min_usdc_out and y >= 0.01 USDC)
ra'    = ra + s - y,  rb' = rb - y,  N -= y,  F += fee
```

Selling BELOW is symmetric. Reserves and trade sizes must stay below 2^62 so that `b^2` fits in a u128 (all intermediate
math is checked u128; there are no truncating casts).

Sells and merges are never blocked by pause, and remain possible after `trading_end_ts` while the market is Open.

### Merge and redeem

* `merge(m)`: burn `m` ABOVE and `m` BELOW, pay `m` USDC, `N -= m`. No fee. Allowed while Open, including after trading ends.
* `redeem` in a Settled market: only the winning side, 1 USDC per share (the loser settles at $0). `N -= amount`.
* `redeem` in a Voided market: either side pays `floor(amount / 2)` USDC per `amount` shares (0.5 USDC each).

## 3. Rounding rules (all in favor of the pool)

| Quantity | Rounding |
|---|---|
| fee on a buy or sell | up |
| shares out on a buy | down (reserve `ra'` rounds up) |
| complete sets released on a sell (`y`) | down (square root up, division down) |
| price in bps | down |
| voided redeem payout | down |
| LP payout | down |
| LP claim after void | down (`ceil` on the user-side obligation) |

The consequence, covered by property tests, is that the product `ra * rb` never decreases across any trade and the vault never
holds less than the obligations: `vault >= N + F` while Open and `vault >= redeemable value + lp_claim_remaining` afterwards.

## 4. Opening a market

`create_market` takes a fair opening price `p0_bps` in [200, 9800] and liquidity `L >= config.min_liquidity`:

```
vault += L,  N = L
p0 <  50%:  ra = L,  rb = floor(L * p0_bps / (10000 - p0_bps));   creator receives (L - rb) real BELOW
p0 >= 50%:  rb = L,  ra = floor(L * (10000 - p0_bps) / p0_bps);   creator receives (L - ra) real ABOVE
creator receives L LP tokens
```

Example: L = 500 USDC at p0 = 20% gives ra = 500, rb = 125 and the creator receives 375 BELOW plus 500 LP tokens.
The client computes `p0_bps` from the digital-option fair value (`fairValueClose`, zero drift) so that the market does not open
at a price an arbitrageur can exploit. Opening at 50% when the fair price is `p*` costs the liquidity provider about
`L * (1 - 2 sqrt(p* (1 - p*)))` (`expectedArbLossUsdc`); for L = 500 USDC and p* = 20% that is 100 USDC, which is why the seeding scripts open at the fair price.

## 5. Fees

`fee_bps` is chosen at creation from {50, 100, 200}. If `dynamic_fee` is false the fee is exactly that base.
If it is true the fee for a trade executed at time `now` is

```
fee_bps = min(max_fee_bps, base + near + flow)          (max_fee_bps defaults to 300)
near    = 80 * (72h - clamp(settle_ts - now, 0, 72h)) / 72h        (integer bps, "Near expiry")
flow    = clamp(ema / 4, 0, 50)                                    ("Recent flow")
```

| Time to settle | 96h | 72h | 48h | 24h | 6h | 1h | 0 |
|---|---|---|---|---|---|---|---|
| near (bps) | 0 | 0 | 26 | 53 | 73 | 78 | 80 |

`ema` is an exponential moving average of the absolute price move (`impact = |price_after_bps - price_before_bps|`) of recent
trades with a 30 minute half-life, kept in fixed point (16 fractional bits):

```
dt    = now - ema_ts;  n = dt / 1800;  rem = dt % 1800
decay = (65536 >> min(n, 16)) * (3600 - rem) / 3600          (linear approximation of 2^(-rem/1800))
ema'  = (ema * decay + impact * (65536 - decay)) >> 16
```

Two points worth knowing:

* The fee of a trade uses the EMA decayed to `now` but BEFORE that trade is folded in; then the EMA is updated. A single large
  trade therefore cannot raise its own fee.
* The linear approximation overestimates the remaining weight slightly between half-lives (an EMA of 400 bps decays to 300 after 15 minutes,
  200 after 30, 100 after 60). It is deterministic and identical on both sides of the parity test, which is what matters.

The fee pool belongs to liquidity providers (the protocol fee share is reserved at 0 in Phase 1).

## 6. Settlement and the liquidity provider claim

`settle_close` (callable by anyone) accepts a fully verified `PriceUpdateV2` for the market's feed whose `publish_time` lies in
`[settle_ts, settle_ts + max_staleness_secs]` and whose confidence satisfies `conf * 10000 <= max_conf_bps * price`. A price strictly
above the target settles ABOVE, equal or below settles BELOW (exponents are normalised with i128 arithmetic).

At that moment the program freezes the LP claim:

```
Settled, ABOVE won:  lp_claim = ra + F          Settled, BELOW won:  lp_claim = rb + F
Voided:              lp_claim = (N + F) - ceil((realA + realB) / 2)
```

and stores `lp_claim_remaining` and `lp_supply_remaining` (the LP mint supply at that moment). `remove_liquidity(lp)` pays
`floor(lp_claim_remaining * lp / lp_supply_remaining)` and decrements both counters, so the last provider receives the exact
remainder. Why these numbers are right: after an ABOVE settlement every outstanding ABOVE share is worth 1 USDC and the pool's
virtual `ra` tokens are the ones nobody holds, so the vault holds `N` USDC of which `N - ra` is owed to ABOVE holders; the rest
(`ra`) plus the fee pool belongs to liquidity providers. In a void every share is worth 0.5 USDC, so users are owed
`ceil((realA + realB) / 2)` and the providers get the rest.

`void_market` (anyone) is possible once `now >= settle_ts + 3600` while the market is still Open, which is the escape hatch for
a missing or invalid oracle update. Voided markets pay both sides at 0.5 USDC per share.

## 7. Bit-exact parity with the SDK

* `cargo test -p groundgraph --lib parity` writes `packages/sdk/test/vectors.json` (2000+ cases covering buy, sell, seeding, fee components, EMA, LP math and price comparison) and `packages/sdk/test/account-samples.json` (Market, Config and Feed account bytes with their decoded fields).
* `pnpm --filter @groundgraph/sdk test` consumes both files and asserts exact equality of every field, so a quote computed in the browser equals the fill on chain.
* The LiteSVM end to end test and `scripts/smoke-devnet.ts` re-check this against the real program: the SDK simulation must equal the Trade event, the token balance deltas and the resulting Market account.

## 8. Compute units

Measured with LiteSVM 0.18 running the SBPF v3 build of the program (`cargo +1.99.0 test -p groundgraph-tests --test cu -- --nocapture`).
Targets: `create_market` below 400k, trades below 200k.

| Instruction | Calls | Min CU | Max CU |
|---|---|---|---|
| initialize_config | 1 | 16,752 | 16,752 |
| allow_feed | 1 | 14,429 | 14,429 |
| create_market | 2 | 120,350 | 136,854 |
| buy | 14 | 17,931 | 18,432 |
| sell | 2 | 19,200 | 19,696 |
| merge | 2 | 15,830 | 15,832 |
| settle_close | 1 | 12,819 | 12,819 |
| void_market | 1 | 7,928 | 7,928 |
| redeem | 2 | 13,599 | 13,604 |
| remove_liquidity | 2 | 13,630 | 13,632 |

Transactions built by the SDK also contain idempotent associated token account creations (about 4k CU each) and compute budget
instructions, so on-cluster totals are a few thousand units higher (the devnet smoke test records them in
`programs/groundgraph/deployments/devnet-smoke.json`). The only variable cost in a trade is the integer square root, which is bounded by
the 2^62 reserve limit.

## 9. Limits

| Limit | Value |
|---|---|
| minimum buy | 1 USDC |
| minimum sell proceeds (before fee) | 0.01 USDC |
| opening price | 2% to 98% |
| minimum liquidity | `config.min_liquidity` (100 USDC default) |
| reserves and trade sizes | strictly below 2^62 base units |
| base fee | 50, 100 or 200 bps |
| maximum total fee | `config.max_fee_bps` (300 default) |
| duration | `config.min_duration_secs` (24h default, 30 min on devnet) to 180 days |
| trading stops (buys) | `settle_ts - config.trading_close_secs` (1h default, stored per market as `trading_end_ts`) |
