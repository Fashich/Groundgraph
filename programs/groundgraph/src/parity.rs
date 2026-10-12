//! Test-only generators for the TypeScript SDK.
//!
//! `cargo test -p groundgraph --lib parity` rewrites
//! - `packages/sdk/test/vectors.json`: bit-exact math vectors produced by `math.rs`
//! - `packages/sdk/test/account-samples.json`: raw account / event bytes produced by the real Anchor types
//! The vitest suite in `packages/sdk` consumes both. Generation is deterministic (fixed PRNG seed).

use std::path::PathBuf;

use anchor_lang::prelude::*;
use anchor_lang::{Discriminator, Event};
use serde_json::{json, Value};

use crate::events::*;
use crate::math::{self, MathError, Side};
use crate::state::{Config, Direction, FeedAllowlist, Market, MarketKind, MarketStatus, Outcome};

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }
    /// Uniform in [lo, hi].
    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        if hi <= lo {
            return lo;
        }
        lo + self.next() % (hi - lo + 1)
    }
    /// Log-uniform in [lo, hi] so small and huge magnitudes are both well covered.
    fn log_range(&mut self, lo: u64, hi: u64) -> u64 {
        let l = (lo.max(1) as f64).ln();
        let h = (hi.max(1) as f64).ln();
        let t = (self.next() >> 11) as f64 / (1u64 << 53) as f64;
        ((l + (h - l) * t).exp() as u64).clamp(lo, hi)
    }
    fn pick<T: Copy>(&mut self, xs: &[T]) -> T {
        xs[(self.next() % xs.len() as u64) as usize]
    }
}

fn s(x: u64) -> String {
    x.to_string()
}

fn side_str(side: Side) -> &'static str {
    match side {
        Side::Above => "above",
        Side::Below => "below",
    }
}

fn err_str(e: MathError) -> String {
    format!("{e:?}")
}

fn out_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/sdk/test")
}

fn pool(rng: &mut Rng) -> (u64, u64) {
    match rng.next() % 10 {
        // near the 2^62 limit
        0 => (rng.range(math::MAX_RESERVE - (1 << 40), math::MAX_RESERVE - 1), rng.range(1_000, math::MAX_RESERVE - 1)),
        1 => (rng.range(1_000, math::MAX_RESERVE - 1), rng.range(math::MAX_RESERVE - (1 << 40), math::MAX_RESERVE - 1)),
        // very lopsided
        2 => (rng.range(1_000, 100_000), rng.log_range(1_000_000_000, 1u64 << 50)),
        3 => (rng.log_range(1_000_000_000, 1u64 << 50), rng.range(1_000, 100_000)),
        // typical devnet sized
        4 | 5 | 6 => (rng.log_range(1_000_000, 50_000_000_000), rng.log_range(1_000_000, 50_000_000_000)),
        _ => (rng.log_range(1_000, 1u64 << 61), rng.log_range(1_000, 1u64 << 61)),
    }
}

fn buy_vectors(rng: &mut Rng, n: usize) -> Vec<Value> {
    let mut v = Vec::new();
    for i in 0..n {
        let (ra, rb) = pool(rng);
        let side = if rng.next() % 2 == 0 { Side::Above } else { Side::Below };
        let fee_bps = rng.pick(&[0u16, 25, 50, 100, 200, 300, 300, 100, 150, 180]);
        let usdc_in = match i % 6 {
            0 => math::MIN_TRADE_USDC,
            1 => 1,
            2 => rng.range(1, 999_999),
            3 => rng.log_range(1_000_000, 10_000_000_000_000),
            4 => rng.log_range(1, 1u64 << 63),
            _ => rng.log_range(1_000_000, 500_000_000_000),
        };
        let mut case = json!({
            "ra": s(ra), "rb": s(rb), "side": side_str(side), "usdcIn": s(usdc_in), "feeBps": fee_bps,
        });
        match math::quote_buy(ra, rb, side, usdc_in, fee_bps) {
            Ok(q) => {
                case["out"] = json!({
                    "sharesOut": s(q.shares_out), "feeUsdc": s(q.fee), "usdcIntoSets": s(q.usdc_into_sets),
                    "ra": s(q.ra_after), "rb": s(q.rb_after),
                    "priceBeforeBps": math::price_bps(ra, rb), "priceAfterBps": math::price_bps(q.ra_after, q.rb_after),
                    "impactBps": math::impact_bps(ra, rb, q.ra_after, q.rb_after),
                });
            }
            Err(e) => case["error"] = json!(err_str(e)),
        }
        v.push(case);
    }
    v
}

fn sell_vectors(rng: &mut Rng, n: usize) -> Vec<Value> {
    let mut v = Vec::new();
    for i in 0..n {
        let (ra, rb) = pool(rng);
        let side = if rng.next() % 2 == 0 { Side::Above } else { Side::Below };
        let fee_bps = rng.pick(&[0u16, 25, 50, 100, 200, 300, 300, 100, 150, 180]);
        let r_sold = if side == Side::Above { ra } else { rb };
        let shares = match i % 7 {
            0 => 1,
            1 => rng.range(1, 10_000),
            2 => rng.range(1, r_sold.max(1)),
            3 => rng.log_range(1, r_sold.max(1) * 4),
            4 => rng.log_range(1_000_000, 100_000_000_000),
            5 => (r_sold / 2).max(1),
            _ => rng.log_range(1, r_sold.max(2)),
        };
        let mut case = json!({
            "ra": s(ra), "rb": s(rb), "side": side_str(side), "sharesIn": s(shares), "feeBps": fee_bps,
        });
        match math::quote_sell(ra, rb, side, shares, fee_bps) {
            Ok(q) => {
                case["out"] = json!({
                    "usdcGross": s(q.usdc_gross), "feeUsdc": s(q.fee), "usdcOut": s(q.usdc_out),
                    "ra": s(q.ra_after), "rb": s(q.rb_after),
                    "priceBeforeBps": math::price_bps(ra, rb), "priceAfterBps": math::price_bps(q.ra_after, q.rb_after),
                    "impactBps": math::impact_bps(ra, rb, q.ra_after, q.rb_after),
                });
            }
            Err(e) => case["error"] = json!(err_str(e)),
        }
        v.push(case);
    }
    v
}

fn seed_vectors(rng: &mut Rng, n: usize) -> Vec<Value> {
    let mut v = Vec::new();
    let fixed: [(u64, u16); 12] = [
        (100_000_000, 200),
        (100_000_000, 9_800),
        (100_000_000, 5_000),
        (100_000_000, 4_999),
        (100_000_000, 5_001),
        (500_000_000, 2_500),
        (500_000_000, 7_500),
        (1, 5_000),
        (49, 200),
        (100_000_000, 199),
        (100_000_000, 9_801),
        (math::MAX_RESERVE - 1, 3_333),
    ];
    for (l, p) in fixed {
        v.push(seed_case(l, p));
    }
    while v.len() < n {
        let l = rng.log_range(1, math::MAX_RESERVE + 10);
        let p = rng.range(150, 9_850) as u16;
        v.push(seed_case(l, p));
    }
    v
}

fn seed_case(l: u64, p: u16) -> Value {
    let mut case = json!({ "liquidity": s(l), "p0Bps": p });
    match math::seed_reserves(l, p) {
        Ok(x) => {
            case["out"] = json!({
                "ra": s(x.reserve_above), "rb": s(x.reserve_below),
                "creatorAbove": s(x.creator_above), "creatorBelow": s(x.creator_below),
            })
        }
        Err(e) => case["error"] = json!(err_str(e)),
    }
    case
}

fn fee_vectors(rng: &mut Rng, n: usize) -> Vec<Value> {
    let mut v = Vec::new();
    for _ in 0..n {
        let base = rng.pick(&[50u16, 100, 200]);
        let dynamic = rng.next() % 4 != 0;
        let max_fee = rng.pick(&[200u16, 300, 300, 500, 1000]);
        let ema = match rng.next() % 4 {
            0 => 0,
            1 => rng.range(0, 40) as u32,
            2 => rng.range(0, 400) as u32,
            _ => rng.range(0, 10_000) as u32,
        };
        let settle = 1_800_000_000i64 + rng.range(0, 200_000_000) as i64;
        let window = rng.pick(&[0i64, 60, 3_600, 36 * 3_600, 72 * 3_600, 100 * 3_600, 30 * 86_400]);
        let now = settle - window + rng.range(0, 7_200) as i64 - 3_600;
        let ema_ts = now - rng.log_range(1, 10_000_000) as i64 + if rng.next() % 17 == 0 { 100 } else { 0 };
        let p = math::fee_bps_now(base, dynamic, max_fee, ema, ema_ts, settle, now);
        v.push(json!({
            "baseFeeBps": base, "dynamicFee": dynamic, "maxFeeBps": max_fee, "emaImpactBps": ema,
            "emaTs": ema_ts, "settleTs": settle, "now": now,
            "out": { "baseBps": p.base, "nearBps": p.near, "flowBps": p.flow, "totalBps": p.total },
        }));
    }
    v
}

fn ema_vectors(rng: &mut Rng, n: usize) -> Vec<Value> {
    let mut v = Vec::new();
    for i in 0..n {
        let ema = if i % 5 == 0 { 0 } else { rng.range(0, 10_000) as u32 };
        let impact = if i % 7 == 0 { 0 } else { rng.range(0, 10_000) as u32 };
        let ts = 1_800_000_000i64 + rng.range(0, 1_000_000) as i64;
        let dt = match i % 6 {
            0 => 0,
            1 => 1_800,
            2 => 3_600,
            3 => rng.range(0, 1_799) as i64,
            4 => rng.log_range(1, 100_000_000) as i64,
            _ => rng.range(0, 40_000) as i64,
        };
        let now = if i % 31 == 0 { ts - 500 } else { ts + dt };
        v.push(json!({ "ema": ema, "emaTs": ts, "impact": impact, "now": now, "out": math::update_ema(ema, ts, impact, now) }));
    }
    v
}

fn misc_vectors(rng: &mut Rng) -> Value {
    let mut price = Vec::new();
    for _ in 0..200 {
        let (ra, rb) = pool(rng);
        price.push(json!({ "ra": s(ra), "rb": s(rb), "out": math::price_bps(ra, rb) }));
    }
    price.push(json!({ "ra": "0", "rb": "0", "out": 0 }));
    let mut fee_ceil = Vec::new();
    for i in 0..200 {
        let amount = if i % 3 == 0 { rng.range(0, 1_000) } else { rng.log_range(1, u64::MAX / 70_000) };
        let bps = rng.pick(&[0u16, 1, 50, 100, 200, 300, 1000, 9_999, 10_000]);
        fee_ceil.push(json!({ "amount": s(amount), "bps": bps, "out": s(math::fee_ceil(amount, bps).unwrap()) }));
    }
    let mut lp = Vec::new();
    for _ in 0..200 {
        let supply = rng.log_range(1, 1u64 << 60);
        let amt = rng.range(0, supply);
        let claim = rng.log_range(0, 1u64 << 62);
        lp.push(json!({ "claim": s(claim), "lpAmount": s(amt), "lpSupply": s(supply), "out": s(math::lp_payout(claim, amt, supply).unwrap()) }));
    }
    let mut void_claim = Vec::new();
    for _ in 0..100 {
        let (ra, rb) = pool(rng);
        let n = ra.max(rb) + rng.range(0, 1_000_000);
        let fee_pool = rng.log_range(0, 1_000_000_000);
        let mut c = json!({ "completeSets": s(n), "ra": s(ra), "rb": s(rb), "feePool": s(fee_pool) });
        match math::void_lp_claim(n, ra, rb, fee_pool) {
            Ok(x) => c["out"] = json!(s(x)),
            Err(e) => c["error"] = json!(err_str(e)),
        }
        void_claim.push(c);
    }
    let mut compare = Vec::new();
    let cases: [(i64, i32, i64, i32); 8] = [
        (25_000_000_000, -8, 250, 0),
        (25_000_000_001, -8, 250, 0),
        (24_999_999_999, -8, 250, 0),
        (2_500_000, -4, 25_000_000_000, -8),
        (1, 10, 1, -10),
        (9_223_372_036_854_775_807, -8, 9_223_372_036_854_775_807, -8),
        (1, -18, 1, 0),
        (1, 0, 1, -18),
    ];
    for (p, e, t, te) in cases {
        let out = math::compare_price(p, e, t, te);
        compare.push(match out {
            Ok(o) => json!({ "price": s(p as u64), "expo": e, "target": s(t as u64), "targetExpo": te, "out": o as i32 }),
            Err(er) => json!({ "price": s(p as u64), "expo": e, "target": s(t as u64), "targetExpo": te, "error": err_str(er) }),
        });
    }
    for _ in 0..150 {
        let p = rng.range(1, 1_000_000_000_000_000) as i64;
        let t = rng.range(1, 1_000_000_000_000_000) as i64;
        let e = -(rng.range(0, 12) as i32);
        let te = -(rng.range(0, 12) as i32);
        let o = math::compare_price(p, e, t, te).unwrap();
        compare.push(json!({ "price": s(p as u64), "expo": e, "target": s(t as u64), "targetExpo": te, "out": o as i32 }));
    }
    let mut isqrt = Vec::new();
    for i in 0..150 {
        let n: u128 = match i % 3 {
            0 => rng.next() as u128,
            1 => ((rng.next() as u128) << 64) | rng.next() as u128,
            _ => ((rng.next() as u128) << 40) | (rng.next() >> 20) as u128,
        };
        isqrt.push(json!({ "n": n.to_string(), "floor": math::isqrt(n).to_string(), "ceil": math::ceil_sqrt(n).to_string() }));
    }
    json!({
        "priceBps": price, "feeCeil": fee_ceil, "lpPayout": lp, "voidLpClaim": void_claim,
        "comparePrice": compare, "isqrt": isqrt,
    })
}

fn pk(tag: u8) -> Pubkey {
    let mut b = [tag; 32];
    b[0] = tag.wrapping_mul(7).wrapping_add(1);
    b[31] = tag ^ 0x5a;
    Pubkey::new_from_array(b)
}

fn account_bytes<T: AccountSerialize>(a: &T) -> String {
    let mut buf = Vec::new();
    a.try_serialize(&mut buf).unwrap();
    hex(&buf)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn account_samples() -> Value {
    let feed_id: [u8; 32] = core::array::from_fn(|i| (i as u8).wrapping_mul(9).wrapping_add(3));
    let market = Market {
        creator: pk(1),
        nonce: 42,
        collateral_mint: pk(2),
        vault: pk(3),
        above_mint: pk(4),
        below_mint: pk(5),
        lp_mint: pk(6),
        kind: MarketKind::Close,
        direction: Direction::None,
        feed_id,
        target_price: 25_000_000_000,
        target_expo: -8,
        open_ts: 1_800_000_000,
        trading_end_ts: 1_800_082_800,
        settle_ts: 1_800_086_400,
        base_fee_bps: 100,
        dynamic_fee: true,
        complete_sets: 1_234_567_890,
        reserve_above: 600_000_000,
        reserve_below: 400_000_000,
        fee_pool: 4_321_000,
        ema_impact_bps: 37,
        ema_ts: 1_800_000_500,
        status: MarketStatus::Settled,
        outcome: Outcome::Above,
        settle_price: 25_100_000_000,
        settle_expo: -8,
        settle_publish_ts: 1_800_086_412,
        lp_claim_remaining: 604_321_000,
        lp_supply_remaining: 500_000_000,
        bump: 254,
    };
    let open_market = Market {
        status: MarketStatus::Open,
        outcome: Outcome::None,
        dynamic_fee: false,
        settle_price: 0,
        settle_expo: 0,
        settle_publish_ts: 0,
        lp_claim_remaining: 0,
        lp_supply_remaining: 0,
        nonce: u64::MAX,
        target_price: i64::MAX,
        ..market.clone()
    };
    let config = Config {
        admin: pk(10),
        treasury: pk(11),
        usdc_mint: pk(12),
        protocol_fee_share_bps: 0,
        max_fee_bps: 300,
        min_liquidity: 100_000_000,
        min_duration_secs: 1_800,
        max_duration_secs: 15_552_000,
        max_staleness_secs: 60,
        max_conf_bps: 50,
        trading_close_secs: 300,
        paused: false,
        bump: 255,
    };
    let feed = FeedAllowlist { feed_id, symbol: "SOL/USD".to_string(), expo: -8, enabled: true, bump: 253 };

    let ev = |e: &dyn Fn() -> Vec<u8>| hex(&e());
    let trade = Trade {
        market: pk(20),
        wallet: pk(21),
        side: crate::state::Side::Below,
        is_buy: true,
        usdc: 10_000_000,
        shares: 18_500_000,
        fee_usdc: 100_000,
        fee_bps: 100,
        price_after_bps: 4_321,
        reserve_above: 123,
        reserve_below: 456,
        ts: 1_800_000_123,
    };
    let created = MarketCreated {
        market: pk(20),
        creator: pk(1),
        feed_id,
        target_price: 25_000_000_000,
        target_expo: -8,
        kind: MarketKind::Close,
        settle_ts: 1_800_086_400,
        trading_end_ts: 1_800_082_800,
        base_fee_bps: 100,
        dynamic_fee: true,
        liquidity: 500_000_000,
        p0_bps: 2_500,
        above_mint: pk(4),
        below_mint: pk(5),
        lp_mint: pk(6),
        vault: pk(3),
    };
    let settled = Settled { market: pk(20), outcome: Outcome::Below, price: 24_900_000_000, expo: -8, publish_ts: 1_800_086_401, lp_claim: 99 };
    let voided = Voided { market: pk(20), lp_claim: 77 };
    let redeemed = Redeemed { market: pk(20), wallet: pk(21), side: crate::state::Side::Above, shares: 5, usdc: 5 };
    let merged = Merged { market: pk(20), wallet: pk(21), amount: 9 };
    let liq = LiquidityChanged { market: pk(20), wallet: pk(21), lp_amount: 11, usdc: 12, is_add: false };

    let market_json = |m: &Market| {
        json!({
            "creator": m.creator.to_string(), "nonce": s(m.nonce), "collateralMint": m.collateral_mint.to_string(),
            "vault": m.vault.to_string(), "aboveMint": m.above_mint.to_string(), "belowMint": m.below_mint.to_string(),
            "lpMint": m.lp_mint.to_string(), "kind": "close", "direction": "none", "feedIdHex": hex(&m.feed_id),
            "targetPrice": m.target_price.to_string(), "targetExpo": m.target_expo, "openTs": m.open_ts,
            "tradingEndTs": m.trading_end_ts, "settleTs": m.settle_ts, "baseFeeBps": m.base_fee_bps, "dynamicFee": m.dynamic_fee,
            "completeSets": s(m.complete_sets), "reserveAbove": s(m.reserve_above), "reserveBelow": s(m.reserve_below),
            "feePool": s(m.fee_pool), "emaImpactBps": m.ema_impact_bps, "emaTs": m.ema_ts,
            "status": match m.status { MarketStatus::Open => "open", MarketStatus::Settled => "settled", MarketStatus::Voided => "voided" },
            "outcome": match m.outcome { Outcome::None => "none", Outcome::Above => "above", Outcome::Below => "below" },
            "settlePrice": m.settle_price.to_string(), "settleExpo": m.settle_expo, "settlePublishTs": m.settle_publish_ts,
            "lpClaimRemaining": s(m.lp_claim_remaining), "lpSupplyRemaining": s(m.lp_supply_remaining), "bump": m.bump,
        })
    };

    json!({
        "discriminators": {
            "Market": hex(Market::DISCRIMINATOR), "Config": hex(Config::DISCRIMINATOR), "FeedAllowlist": hex(FeedAllowlist::DISCRIMINATOR),
            "Trade": hex(Trade::DISCRIMINATOR), "MarketCreated": hex(MarketCreated::DISCRIMINATOR), "Settled": hex(Settled::DISCRIMINATOR),
            "Voided": hex(Voided::DISCRIMINATOR), "Redeemed": hex(Redeemed::DISCRIMINATOR), "Merged": hex(Merged::DISCRIMINATOR),
            "LiquidityChanged": hex(LiquidityChanged::DISCRIMINATOR), "ConfigUpdated": hex(ConfigUpdated::DISCRIMINATOR),
            "FeedUpdated": hex(FeedUpdated::DISCRIMINATOR),
        },
        "marketSettled": { "hex": account_bytes(&market), "decoded": market_json(&market), "size": 8 + Market::INIT_SPACE },
        "marketOpen": { "hex": account_bytes(&open_market), "decoded": market_json(&open_market) },
        "config": {
            "hex": account_bytes(&config),
            "decoded": {
                "admin": config.admin.to_string(), "treasury": config.treasury.to_string(), "usdcMint": config.usdc_mint.to_string(),
                "protocolFeeShareBps": 0, "maxFeeBps": 300, "minLiquidity": "100000000", "minDurationSecs": 1800,
                "maxDurationSecs": 15552000, "maxStalenessSecs": 60, "maxConfBps": 50, "tradingCloseSecs": 300, "paused": false, "bump": 255,
            },
        },
        "feed": {
            "hex": account_bytes(&feed),
            "decoded": { "feedIdHex": hex(&feed_id), "symbol": "SOL/USD", "expo": -8, "enabled": true, "bump": 253 },
        },
        "events": {
            "Trade": { "hex": ev(&|| trade.data()), "decoded": {
                "market": pk(20).to_string(), "wallet": pk(21).to_string(), "side": "below", "isBuy": true, "usdc": "10000000",
                "shares": "18500000", "feeUsdc": "100000", "feeBps": 100, "priceAfterBps": 4321, "reserveAbove": "123", "reserveBelow": "456", "ts": 1800000123 } },
            "MarketCreated": { "hex": ev(&|| created.data()), "decoded": {
                "market": pk(20).to_string(), "creator": pk(1).to_string(), "feedIdHex": hex(&feed_id), "targetPrice": "25000000000", "targetExpo": -8,
                "kind": "close", "settleTs": 1800086400, "tradingEndTs": 1800082800, "baseFeeBps": 100, "dynamicFee": true, "liquidity": "500000000",
                "p0Bps": 2500, "aboveMint": pk(4).to_string(), "belowMint": pk(5).to_string(), "lpMint": pk(6).to_string(), "vault": pk(3).to_string() } },
            "Settled": { "hex": ev(&|| settled.data()), "decoded": {
                "market": pk(20).to_string(), "outcome": "below", "price": "24900000000", "expo": -8, "publishTs": 1800086401, "lpClaim": "99" } },
            "Voided": { "hex": ev(&|| voided.data()), "decoded": { "market": pk(20).to_string(), "lpClaim": "77" } },
            "Redeemed": { "hex": ev(&|| redeemed.data()), "decoded": { "market": pk(20).to_string(), "wallet": pk(21).to_string(), "side": "above", "shares": "5", "usdc": "5" } },
            "Merged": { "hex": ev(&|| merged.data()), "decoded": { "market": pk(20).to_string(), "wallet": pk(21).to_string(), "amount": "9" } },
            "LiquidityChanged": { "hex": ev(&|| liq.data()), "decoded": { "market": pk(20).to_string(), "wallet": pk(21).to_string(), "lpAmount": "11", "usdc": "12", "isAdd": false } },
        },
    })
}

#[test]
fn generate_vectors_for_sdk() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let buys = buy_vectors(&mut rng, 1_100);
    let sells = sell_vectors(&mut rng, 1_100);
    let seeds = seed_vectors(&mut rng, 250);
    let fees = fee_vectors(&mut rng, 400);
    let emas = ema_vectors(&mut rng, 400);
    let misc = misc_vectors(&mut rng);
    let total = buys.len() + sells.len() + seeds.len() + fees.len() + emas.len();
    assert!(total >= 2_000, "need at least 2000 core cases, have {total}");

    // Sanity: the file must contain both successful and error cases for the SDK to check throw behaviour.
    assert!(buys.iter().any(|c| c.get("error").is_some()));
    assert!(buys.iter().any(|c| c.get("out").is_some()));
    assert!(sells.iter().any(|c| c.get("error").is_some()));
    assert!(sells.iter().any(|c| c.get("out").is_some()));

    let doc = json!({
        "version": 1,
        "note": "Generated by programs/groundgraph/src/parity.rs from math.rs. Do not edit. u64 values are decimal strings.",
        "constants": {
            "minTradeUsdc": s(math::MIN_TRADE_USDC), "minSellGrossUsdc": s(math::MIN_SELL_GROSS_USDC), "maxReserve": s(math::MAX_RESERVE),
            "p0MinBps": math::P0_MIN_BPS, "p0MaxBps": math::P0_MAX_BPS,
        },
        "quoteBuy": buys, "quoteSell": sells, "seedReserves": seeds, "feeBpsNow": fees, "updateEma": emas,
        "priceBps": misc["priceBps"], "feeCeil": misc["feeCeil"], "lpPayout": misc["lpPayout"], "voidLpClaim": misc["voidLpClaim"],
        "comparePrice": misc["comparePrice"], "isqrt": misc["isqrt"],
    });
    let dir = out_dir();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("vectors.json"), serde_json::to_string(&doc).unwrap()).unwrap();
    std::fs::write(dir.join("account-samples.json"), serde_json::to_string_pretty(&account_samples()).unwrap()).unwrap();
}

#[test]
fn account_sizes_are_stable() {
    // Guards the layout the SDK decoders rely on.
    assert_eq!(8 + Config::INIT_SPACE, 8 + 32 * 3 + 2 + 2 + 8 + 8 + 8 + 4 + 2 + 4 + 1 + 1);
    assert_eq!(8 + FeedAllowlist::INIT_SPACE, 8 + 32 + (4 + 16) + 4 + 1 + 1);
    assert_eq!(
        8 + Market::INIT_SPACE,
        8 + 32 + 8 + 32 * 5 + 1 + 1 + 32 + 8 + 4 + 8 + 8 + 8 + 2 + 1 + 8 * 4 + 4 + 8 + 1 + 1 + 8 + 4 + 8 + 8 + 8 + 1
    );
}
