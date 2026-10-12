//! Pure integer math for the Groundgraph AMM.
//!
//! Nothing in this module touches Solana types. Every function is deterministic and is mirrored bit for bit by
//! `packages/sdk/src/math.ts`; parity is enforced by `packages/sdk/test/vectors.json`, which is generated from this
//! file by `cargo test -p groundgraph --lib parity`.
//!
//! Conventions
//! - USDC and outcome shares both use 6 decimals. 1 complete set (1 ABOVE + 1 BELOW) is worth exactly 1 USDC.
//! - `ra` / `rb` are the pool's VIRTUAL holdings of ABOVE / BELOW outcome tokens (never minted).
//! - Price of ABOVE in bps is `rb * 10_000 / (ra + rb)`.
//! - Every rounding decision favors the pool: fees round up, shares out round down, reserves round up.

use core::cmp::Ordering;

pub const BPS_DENOM: u128 = 10_000;
/// Minimum gross USDC for a buy (1 USDC).
pub const MIN_TRADE_USDC: u64 = 1_000_000;
/// Minimum gross USDC (before fee) a sell must produce (0.01 USDC).
pub const MIN_SELL_GROSS_USDC: u64 = 10_000;
/// Reserves (and trade sizes) must stay strictly below 2^62 so that `b^2` in the sell quadratic fits in u128.
pub const MAX_RESERVE: u64 = 1u64 << 62;
pub const P0_MIN_BPS: u16 = 200;
pub const P0_MAX_BPS: u16 = 9_800;

pub const NEAR_WINDOW_SECS: i64 = 72 * 3_600;
pub const NEAR_MAX_BPS: i64 = 80;
pub const FLOW_MAX_BPS: u32 = 50;
pub const EMA_HALF_LIFE_SECS: u64 = 1_800;
pub const EMA_MAX_SHIFT: u64 = 16;
pub const EMA_ONE: u64 = 65_536;

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum MathError {
    Overflow,
    ZeroAmount,
    ReserveEmpty,
    ReserveTooLarge,
    InvalidP0,
    SellRootFailed,
    ExponentOutOfRange,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Side {
    Above,
    Below,
}

impl Side {
    pub fn other(self) -> Side {
        match self {
            Side::Above => Side::Below,
            Side::Below => Side::Above,
        }
    }
}

/// `x * fee_bps / 10_000`, rounded UP (fees round in favor of the pool).
pub fn fee_ceil(amount: u64, fee_bps: u16) -> Result<u64, MathError> {
    let num = (amount as u128) * (fee_bps as u128);
    let f = num.checked_add(BPS_DENOM - 1).ok_or(MathError::Overflow)? / BPS_DENOM;
    u64::try_from(f).map_err(|_| MathError::Overflow)
}

/// Price of ABOVE in basis points: `rb * 10_000 / (ra + rb)` (floor). Zero when the pool is empty.
pub fn price_bps(ra: u64, rb: u64) -> u32 {
    let sum = (ra as u128) + (rb as u128);
    if sum == 0 {
        return 0;
    }
    (((rb as u128) * BPS_DENOM) / sum) as u32
}

/// Floor of the square root of `n`.
pub fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    let bits = 128 - n.leading_zeros();
    // 2^ceil(bits/2) >= sqrt(n); Newton from above converges monotonically down to floor(sqrt(n)).
    let mut x = 1u128 << ((bits + 1) / 2);
    loop {
        let y = (x + n / x) / 2;
        if y >= x {
            return x;
        }
        x = y;
    }
}

/// Ceiling of the square root of `n`.
pub fn ceil_sqrt(n: u128) -> u128 {
    let r = isqrt(n);
    if r * r == n {
        r
    } else {
        r + 1
    }
}

fn ceil_div(a: u128, b: u128) -> u128 {
    // b > 0 guaranteed by callers; a + b - 1 cannot overflow for the operand ranges used here (< 2^125).
    (a + b - 1) / b
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct BuyQuote {
    pub shares_out: u64,
    pub fee: u64,
    /// USDC that becomes complete sets inside the pool (`usdc_in - fee`).
    pub usdc_into_sets: u64,
    pub ra_after: u64,
    pub rb_after: u64,
}

/// Buy `side` with `usdc_in` USDC. Fixed product over the two virtual reserves, fee taken on the way in.
///
/// Buying ABOVE: `rb' = rb + x'`, `ra' = ceil(ra * rb / rb')`, `shares_out = ra + x' - ra'`.
pub fn quote_buy(ra: u64, rb: u64, side: Side, usdc_in: u64, fee_bps: u16) -> Result<BuyQuote, MathError> {
    if usdc_in == 0 {
        return Err(MathError::ZeroAmount);
    }
    if ra == 0 || rb == 0 {
        return Err(MathError::ReserveEmpty);
    }
    let fee = fee_ceil(usdc_in, fee_bps)?;
    let x = usdc_in.checked_sub(fee).ok_or(MathError::Overflow)?;
    let (r_buy, r_other) = match side {
        Side::Above => (ra, rb),
        Side::Below => (rb, ra),
    };
    let r_other_after = (r_other as u128) + (x as u128);
    if r_other_after >= MAX_RESERVE as u128 {
        return Err(MathError::ReserveTooLarge);
    }
    let k = (r_buy as u128) * (r_other as u128);
    let r_buy_after = ceil_div(k, r_other_after);
    let shares_out = (r_buy as u128) + (x as u128) - r_buy_after;
    let shares_out = u64::try_from(shares_out).map_err(|_| MathError::Overflow)?;
    let r_buy_after = r_buy_after as u64;
    let r_other_after = r_other_after as u64;
    let (ra_after, rb_after) = match side {
        Side::Above => (r_buy_after, r_other_after),
        Side::Below => (r_other_after, r_buy_after),
    };
    Ok(BuyQuote { shares_out, fee, usdc_into_sets: x, ra_after, rb_after })
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct SellQuote {
    /// Gross USDC released from complete sets (`y`), before the fee.
    pub usdc_gross: u64,
    pub fee: u64,
    /// `usdc_gross - fee`: what the seller receives.
    pub usdc_out: u64,
    pub ra_after: u64,
    pub rb_after: u64,
}

/// Sell `shares_in` of `side` back to the pool.
///
/// The pool receives `s` of the sold side, then burns `y` complete sets while keeping the product `k = ra * rb`:
/// `(r_sold + s - y) * (r_other - y) >= r_sold * r_other`, i.e. `y^2 - (r_sold + s + r_other) y + s * r_other >= 0`.
/// The valid solution is the smaller root: `y = floor((b - ceil_sqrt(b^2 - 4c)) / 2)` with `b = r_sold + s + r_other`
/// and `c = s * r_other`. Rounding the square root up and the division down keeps `y` at or below the true root,
/// so the product never decreases. A defensive loop re-checks the inequality exactly.
pub fn quote_sell(ra: u64, rb: u64, side: Side, shares_in: u64, fee_bps: u16) -> Result<SellQuote, MathError> {
    if shares_in == 0 {
        return Err(MathError::ZeroAmount);
    }
    if ra == 0 || rb == 0 {
        return Err(MathError::ReserveEmpty);
    }
    if shares_in >= MAX_RESERVE || ra >= MAX_RESERVE || rb >= MAX_RESERVE {
        return Err(MathError::ReserveTooLarge);
    }
    let (r_sold, r_other) = match side {
        Side::Above => (ra as u128, rb as u128),
        Side::Below => (rb as u128, ra as u128),
    };
    let s = shares_in as u128;
    let k = r_sold * r_other;
    let b = r_sold + s + r_other; // < 3 * 2^62
    let c = s * r_other; // < 2^124
    let disc = b * b - 4 * c; // b^2 >= 4c by AM-GM on (s + r_other)
    let root = ceil_sqrt(disc);
    let mut y = (b - root) / 2;
    let mut guard = 0u8;
    while (r_sold + s - y) * (r_other - y) < k {
        if y == 0 || guard >= 4 {
            return Err(MathError::SellRootFailed);
        }
        y -= 1;
        guard += 1;
    }
    let usdc_gross = u64::try_from(y).map_err(|_| MathError::Overflow)?;
    let fee = fee_ceil(usdc_gross, fee_bps)?;
    let usdc_out = usdc_gross.checked_sub(fee).ok_or(MathError::Overflow)?;
    let r_sold_after = r_sold + s - y;
    let r_other_after = r_other - y;
    if r_sold_after >= MAX_RESERVE as u128 {
        return Err(MathError::ReserveTooLarge);
    }
    let (ra_after, rb_after) = match side {
        Side::Above => (r_sold_after as u64, r_other_after as u64),
        Side::Below => (r_other_after as u64, r_sold_after as u64),
    };
    Ok(SellQuote { usdc_gross, fee, usdc_out, ra_after, rb_after })
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct Seed {
    pub reserve_above: u64,
    pub reserve_below: u64,
    pub creator_above: u64,
    pub creator_below: u64,
}

/// Initial reserves for a market opened at fair ABOVE price `p0_bps` with liquidity `liquidity`.
///
/// p0 < 50%: `ra = L`, `rb = floor(L * p0 / (1 - p0))`, the creator keeps `L - rb` real BELOW.
/// p0 >= 50%: `rb = L`, `ra = floor(L * (1 - p0) / p0)`, the creator keeps `L - ra` real ABOVE.
pub fn seed_reserves(liquidity: u64, p0_bps: u16) -> Result<Seed, MathError> {
    if !(P0_MIN_BPS..=P0_MAX_BPS).contains(&p0_bps) {
        return Err(MathError::InvalidP0);
    }
    if liquidity >= MAX_RESERVE {
        return Err(MathError::ReserveTooLarge);
    }
    let l = liquidity as u128;
    let p = p0_bps as u128;
    if p0_bps < 5_000 {
        let rb = (l * p / (BPS_DENOM - p)) as u64;
        if rb == 0 || liquidity == 0 {
            return Err(MathError::ReserveEmpty);
        }
        Ok(Seed { reserve_above: liquidity, reserve_below: rb, creator_above: 0, creator_below: liquidity - rb })
    } else {
        let ra = (l * (BPS_DENOM - p) / p) as u64;
        if ra == 0 || liquidity == 0 {
            return Err(MathError::ReserveEmpty);
        }
        Ok(Seed { reserve_above: ra, reserve_below: liquidity, creator_above: liquidity - ra, creator_below: 0 })
    }
}

/// "Near expiry" fee component in bps: ramps from 0 (72h out) to 80 (at settle time), integer arithmetic.
pub fn near_fee_bps(settle_ts: i64, now: i64) -> u16 {
    let remaining = (settle_ts.saturating_sub(now)).clamp(0, NEAR_WINDOW_SECS);
    (NEAR_MAX_BPS * (NEAR_WINDOW_SECS - remaining) / NEAR_WINDOW_SECS) as u16
}

/// "Recent flow" fee component in bps from the (already decayed) impact EMA: `clamp(ema / 4, 0, 50)`.
pub fn flow_fee_bps(ema_impact_bps: u32) -> u16 {
    (ema_impact_bps / 4).min(FLOW_MAX_BPS) as u16
}

/// Exponential moving average of price impact with a 30 minute half-life, fixed point (16 fractional bits).
///
/// `decay = (65536 >> min(n, 16)) * (3600 - rem) / 3600` where `dt = now - ema_ts`, `n = dt / 1800`, `rem = dt % 1800`.
/// The `(3600 - rem) / 3600` factor linearly approximates `2^(-rem/1800)` on [0, 1800).
/// `ema' = (ema * decay + impact * (65536 - decay)) >> 16`.
pub fn update_ema(ema_impact_bps: u32, ema_ts: i64, impact_bps: u32, now: i64) -> u32 {
    let dt = if now > ema_ts { (now - ema_ts) as u64 } else { 0 };
    let n = dt / EMA_HALF_LIFE_SECS;
    let rem = dt % EMA_HALF_LIFE_SECS;
    let shift = n.min(EMA_MAX_SHIFT);
    let decay = (EMA_ONE >> shift) * (2 * EMA_HALF_LIFE_SECS - rem) / (2 * EMA_HALF_LIFE_SECS);
    (((ema_impact_bps as u64) * decay + (impact_bps as u64) * (EMA_ONE - decay)) >> 16) as u32
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct FeeParts {
    pub base: u16,
    pub near: u16,
    pub flow: u16,
    pub total: u16,
}

/// Fee in effect for a trade executed at `now`, computed from the EMA BEFORE the trade (decayed to `now`).
/// With `dynamic == false` the fee is exactly `base_fee_bps`.
pub fn fee_bps_now(
    base_fee_bps: u16,
    dynamic: bool,
    max_fee_bps: u16,
    ema_impact_bps: u32,
    ema_ts: i64,
    settle_ts: i64,
    now: i64,
) -> FeeParts {
    if !dynamic {
        return FeeParts { base: base_fee_bps, near: 0, flow: 0, total: base_fee_bps };
    }
    let near = near_fee_bps(settle_ts, now);
    let ema_now = update_ema(ema_impact_bps, ema_ts, 0, now);
    let flow = flow_fee_bps(ema_now);
    let total = (base_fee_bps as u32 + near as u32 + flow as u32).min(max_fee_bps as u32) as u16;
    FeeParts { base: base_fee_bps, near, flow, total }
}

/// Absolute price move in bps between two pool states (input to the EMA).
pub fn impact_bps(ra_before: u64, rb_before: u64, ra_after: u64, rb_after: u64) -> u32 {
    let a = price_bps(ra_before, rb_before);
    let b = price_bps(ra_after, rb_after);
    a.abs_diff(b)
}

/// LP claim at settlement: the pool's remaining virtual tokens of the WINNING side plus the fee pool.
pub fn settled_lp_claim(above_won: bool, ra: u64, rb: u64, fee_pool: u64) -> Result<u64, MathError> {
    let winning = if above_won { ra } else { rb };
    winning.checked_add(fee_pool).ok_or(MathError::Overflow)
}

/// LP claim for a voided market: `(N + fee_pool) - ceil((realA + realB) / 2)` with `realA = N - ra`, `realB = N - rb`.
pub fn void_lp_claim(complete_sets: u64, ra: u64, rb: u64, fee_pool: u64) -> Result<u64, MathError> {
    let real_a = complete_sets.checked_sub(ra).ok_or(MathError::Overflow)? as u128;
    let real_b = complete_sets.checked_sub(rb).ok_or(MathError::Overflow)? as u128;
    let owed = (real_a + real_b + 1) / 2;
    let vault_expected = (complete_sets as u128) + (fee_pool as u128);
    let claim = vault_expected.checked_sub(owed).ok_or(MathError::Overflow)?;
    u64::try_from(claim).map_err(|_| MathError::Overflow)
}

/// USDC paid for `amount` shares of either side in a voided market (0.5 USDC each, floor).
pub fn void_redeem_payout(amount: u64) -> u64 {
    amount / 2
}

/// `floor(claim_remaining * lp_amount / lp_supply_remaining)`.
pub fn lp_payout(claim_remaining: u64, lp_amount: u64, lp_supply_remaining: u64) -> Result<u64, MathError> {
    if lp_supply_remaining == 0 {
        return Err(MathError::ZeroAmount);
    }
    let p = (claim_remaining as u128) * (lp_amount as u128) / (lp_supply_remaining as u128);
    u64::try_from(p).map_err(|_| MathError::Overflow)
}

/// Compare `price * 10^expo` against `target * 10^target_expo` exactly, using i128 after exponent normalisation.
pub fn compare_price(price: i64, expo: i32, target: i64, target_expo: i32) -> Result<Ordering, MathError> {
    let (lhs, rhs) = if expo >= target_expo {
        let diff = (expo as i64) - (target_expo as i64);
        if diff > 18 {
            return Err(MathError::ExponentOutOfRange);
        }
        ((price as i128) * 10i128.pow(diff as u32), target as i128)
    } else {
        let diff = (target_expo as i64) - (expo as i64);
        if diff > 18 {
            return Err(MathError::ExponentOutOfRange);
        }
        (price as i128, (target as i128) * 10i128.pow(diff as u32))
    };
    Ok(lhs.cmp(&rhs))
}

/// `conf * 10_000 <= max_conf_bps * price` (price must be positive).
pub fn confidence_ok(conf: u64, price: i64, max_conf_bps: u16) -> bool {
    if price <= 0 {
        return false;
    }
    (conf as u128) * BPS_DENOM <= (max_conf_bps as u128) * (price as u128)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn isqrt_exact_and_floor() {
        for n in 0u128..2000 {
            let r = isqrt(n);
            assert!(r * r <= n && (r + 1) * (r + 1) > n, "n={n} r={r}");
            let c = ceil_sqrt(n);
            assert!(c * c >= n && (c == 0 || (c - 1) * (c - 1) < n), "n={n} c={c}");
        }
        let big = u128::MAX;
        let r = isqrt(big);
        assert_eq!(r, u64::MAX as u128);
        assert_eq!(ceil_sqrt(u128::MAX), 1u128 << 64);
    }

    #[test]
    fn fee_ceil_rounds_up() {
        assert_eq!(fee_ceil(1_000_000, 100).unwrap(), 10_000);
        assert_eq!(fee_ceil(1, 100).unwrap(), 1);
        assert_eq!(fee_ceil(10_001, 100).unwrap(), 101);
        assert_eq!(fee_ceil(0, 100).unwrap(), 0);
    }

    #[test]
    fn price_bps_basic() {
        assert_eq!(price_bps(1_000, 1_000), 5_000);
        assert_eq!(price_bps(3_000, 1_000), 2_500);
        assert_eq!(price_bps(0, 0), 0);
    }

    #[test]
    fn seed_reserves_examples() {
        let s = seed_reserves(500_000_000, 2_500).unwrap();
        assert_eq!(s.reserve_above, 500_000_000);
        assert_eq!(s.reserve_below, 166_666_666);
        assert_eq!(s.creator_below, 500_000_000 - 166_666_666);
        assert_eq!(s.creator_above, 0);
        let s = seed_reserves(500_000_000, 7_500).unwrap();
        assert_eq!(s.reserve_below, 500_000_000);
        assert_eq!(s.reserve_above, 166_666_666);
        assert_eq!(s.creator_above, 500_000_000 - 166_666_666);
        let s = seed_reserves(100_000_000, 5_000).unwrap();
        assert_eq!((s.reserve_above, s.reserve_below, s.creator_above, s.creator_below), (100_000_000, 100_000_000, 0, 0));
        assert_eq!(seed_reserves(100_000_000, 199), Err(MathError::InvalidP0));
        assert_eq!(seed_reserves(100_000_000, 9_801), Err(MathError::InvalidP0));
        // price after seeding is within 1 bp of p0
        for p0 in [200u16, 1_000, 2_500, 4_999, 5_000, 5_001, 9_000, 9_800] {
            let s = seed_reserves(1_000_000_000, p0).unwrap();
            let pb = price_bps(s.reserve_above, s.reserve_below) as i64;
            assert!((pb - p0 as i64).abs() <= 1, "p0={p0} pb={pb}");
        }
    }

    #[test]
    fn buy_above_known_value() {
        // ra = rb = 100e6, buy 10e6 with 100 bps: fee 100_000, x = 9_900_000
        let q = quote_buy(100_000_000, 100_000_000, Side::Above, 10_000_000, 100).unwrap();
        assert_eq!(q.fee, 100_000);
        assert_eq!(q.usdc_into_sets, 9_900_000);
        assert_eq!(q.rb_after, 109_900_000);
        // ra' = ceil(1e16 / 109_900_000)
        assert_eq!(q.ra_after as u128, ceil_div(100_000_000u128 * 100_000_000u128, 109_900_000));
        assert_eq!(q.shares_out, 100_000_000 + 9_900_000 - q.ra_after);
        assert!(q.shares_out > 9_900_000);
    }

    #[test]
    fn buy_below_is_mirror_of_buy_above() {
        let a = quote_buy(123_456_789, 987_654_321, Side::Above, 5_000_000, 50).unwrap();
        let b = quote_buy(987_654_321, 123_456_789, Side::Below, 5_000_000, 50).unwrap();
        assert_eq!(a.shares_out, b.shares_out);
        assert_eq!(a.ra_after, b.rb_after);
        assert_eq!(a.rb_after, b.ra_after);
    }

    #[test]
    fn sell_roundtrip_never_profits() {
        let (ra, rb) = (400_000_000u64, 600_000_000u64);
        for fee in [0u16, 50, 100, 200, 300] {
            for usdc in [1_000_000u64, 7_654_321, 100_000_000, 250_000_000] {
                let buy = quote_buy(ra, rb, Side::Above, usdc, fee).unwrap();
                let sell = quote_sell(buy.ra_after, buy.rb_after, Side::Above, buy.shares_out, fee).unwrap();
                assert!(sell.usdc_out <= usdc, "round trip profit fee={fee} usdc={usdc}: {} > {}", sell.usdc_out, usdc);
            }
        }
    }

    #[test]
    fn sell_zero_and_empty_rejected() {
        assert_eq!(quote_sell(10, 10, Side::Above, 0, 100), Err(MathError::ZeroAmount));
        assert_eq!(quote_sell(0, 10, Side::Above, 5, 100), Err(MathError::ReserveEmpty));
        assert_eq!(quote_buy(10, 10, Side::Above, 0, 100), Err(MathError::ZeroAmount));
        assert_eq!(quote_buy(10, 0, Side::Above, 5, 100), Err(MathError::ReserveEmpty));
    }

    #[test]
    fn reserve_limit_enforced() {
        let big = MAX_RESERVE - 10;
        assert_eq!(quote_buy(big, big, Side::Above, 1_000_000, 0), Err(MathError::ReserveTooLarge));
        assert_eq!(quote_sell(big, 1_000, Side::Above, 1_000_000, 0), Err(MathError::ReserveTooLarge));
        assert_eq!(quote_sell(1_000, 1_000, Side::Above, MAX_RESERVE, 0), Err(MathError::ReserveTooLarge));
    }

    #[test]
    fn near_fee_ramp() {
        let s = 1_000_000_000i64;
        assert_eq!(near_fee_bps(s, s - 80 * 3600), 0);
        assert_eq!(near_fee_bps(s, s - 72 * 3600), 0);
        assert_eq!(near_fee_bps(s, s - 36 * 3600), 40);
        assert_eq!(near_fee_bps(s, s), 80);
        assert_eq!(near_fee_bps(s, s + 100), 80);
    }

    #[test]
    fn ema_decay_halves_each_half_life() {
        let e = update_ema(1000, 0, 0, 1800);
        assert_eq!(e, 500);
        let e = update_ema(1000, 0, 0, 3600);
        assert_eq!(e, 250);
        // halfway through a half-life uses the linear approximation (3600 - 900) / 3600 = 0.75
        let e = update_ema(1000, 0, 0, 900);
        assert_eq!(e, 750);
        // instant update: weight 1 on the old value
        assert_eq!(update_ema(1000, 50, 200, 50), 1000);
        // long gap forgets
        assert!(update_ema(10_000, 0, 0, 1_000_000) <= 1);
        // impact from a cold start
        assert_eq!(update_ema(0, 0, 400, 10_000_000), 400);
    }

    #[test]
    fn dynamic_fee_components() {
        let settle = 2_000_000_000i64;
        let p = fee_bps_now(100, true, 300, 0, 0, settle, settle - 100 * 3600);
        assert_eq!((p.base, p.near, p.flow, p.total), (100, 0, 0, 100));
        let p = fee_bps_now(100, true, 300, 0, 0, settle, settle);
        assert_eq!((p.near, p.total), (80, 180));
        let p = fee_bps_now(100, true, 300, 400, 1_000, settle, 1_000);
        assert_eq!((p.flow, p.total), (50, 100 + 0 + 50));
        let p = fee_bps_now(200, true, 300, 4_000, settle, settle, settle);
        assert_eq!((p.near, p.flow, p.total), (80, 50, 300));
        // an old EMA has decayed away by settle time
        let p = fee_bps_now(200, true, 300, 4_000, 1_000, settle, settle);
        assert_eq!((p.flow, p.total), (0, 280));
        let p = fee_bps_now(100, false, 300, 4_000, 1_000, settle, settle);
        assert_eq!((p.near, p.flow, p.total), (0, 0, 100));
    }

    #[test]
    fn void_claim_and_payouts() {
        // N = 100, ra = 40, rb = 60 -> realA = 60, realB = 40 -> owed 50 -> claim = 100 + fee - 50
        assert_eq!(void_lp_claim(100, 40, 60, 7).unwrap(), 57);
        // odd total rounds owed up
        assert_eq!(void_lp_claim(101, 40, 60, 0).unwrap(), 101 - ((61 + 41 + 1) / 2));
        assert_eq!(void_redeem_payout(5), 2);
        assert_eq!(lp_payout(1_000, 250, 1_000).unwrap(), 250);
        assert_eq!(lp_payout(999, 1, 1_000).unwrap(), 0);
        assert_eq!(settled_lp_claim(true, 5, 9, 3).unwrap(), 8);
        assert_eq!(settled_lp_claim(false, 5, 9, 3).unwrap(), 12);
    }

    #[test]
    fn compare_price_normalises() {
        // 250.00 at expo -8 vs target 250 at expo 0
        assert_eq!(compare_price(25_000_000_000, -8, 250, 0).unwrap(), Ordering::Equal);
        assert_eq!(compare_price(25_000_000_001, -8, 250, 0).unwrap(), Ordering::Greater);
        assert_eq!(compare_price(24_999_999_999, -8, 250, 0).unwrap(), Ordering::Less);
        // different exponents on both sides
        assert_eq!(compare_price(2_500_000, -4, 25_000_000_000, -8).unwrap(), Ordering::Equal);
        assert_eq!(compare_price(1, 10, 1, -10).unwrap_err(), MathError::ExponentOutOfRange);
    }

    #[test]
    fn confidence_check() {
        assert!(confidence_ok(50, 10_000, 50)); // 0.5% exactly
        assert!(!confidence_ok(51, 10_000, 50));
        assert!(!confidence_ok(0, 0, 50));
    }

    fn pool_strategy() -> impl Strategy<Value = (u64, u64)> {
        // wide range including values near the 2^62 limit
        let r = prop_oneof![
            1_000u64..1_000_000_000,
            1_000_000_000u64..1_000_000_000_000_000,
            (MAX_RESERVE / 4)..(MAX_RESERVE / 2),
            (MAX_RESERVE - (1u64 << 40))..MAX_RESERVE
        ];
        (r.clone(), r)
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(4000))]

        #[test]
        fn prop_isqrt(n in any::<u128>()) {
            let r = isqrt(n);
            prop_assert!(r.checked_mul(r).map_or(false, |sq| sq <= n));
            let r1 = r + 1;
            prop_assert!(r1.checked_mul(r1).map_or(true, |sq| sq > n));
        }

        #[test]
        fn prop_buy_k_never_decreases((ra, rb) in pool_strategy(), usdc in 1_000_000u64..5_000_000_000_000, fee in prop_oneof![Just(0u16), Just(50u16), Just(100u16), Just(200u16), Just(300u16)], above in any::<bool>()) {
            let side = if above { Side::Above } else { Side::Below };
            if let Ok(q) = quote_buy(ra, rb, side, usdc, fee) {
                let k0 = (ra as u128) * (rb as u128);
                let k1 = (q.ra_after as u128) * (q.rb_after as u128);
                prop_assert!(k1 >= k0);
                // pool never gives out more than it takes in tokens
                prop_assert!(q.shares_out as u128 >= q.usdc_into_sets as u128);
                prop_assert_eq!(q.fee + q.usdc_into_sets, usdc);
                // fee is the ceiling
                prop_assert!((q.fee as u128) * BPS_DENOM >= (usdc as u128) * (fee as u128));
                prop_assert!(((q.fee as u128).saturating_sub(1)) * BPS_DENOM < (usdc as u128) * (fee as u128) || q.fee == 0);
            }
        }

        #[test]
        fn prop_sell_k_never_decreases((ra, rb) in pool_strategy(), s_frac in 1u64..1_000_000, fee in prop_oneof![Just(0u16), Just(100u16), Just(300u16)], above in any::<bool>()) {
            let side = if above { Side::Above } else { Side::Below };
            let r_sold_now = if above { ra } else { rb };
            let shares = ((r_sold_now as u128 * s_frac as u128) / 1_000_000).max(1) as u64;
            if let Ok(q) = quote_sell(ra, rb, side, shares, fee) {
                let k0 = (ra as u128) * (rb as u128);
                let k1 = (q.ra_after as u128) * (q.rb_after as u128);
                prop_assert!(k1 >= k0, "k decreased");
                prop_assert!(q.ra_after > 0 && q.rb_after > 0);
                prop_assert!(q.usdc_gross as u128 <= shares as u128, "cannot get more USDC than shares sold");
                prop_assert!(q.usdc_out + q.fee == q.usdc_gross);
                // y is maximal: y + 1 would break the product
                let (r_sold, r_other) = if above { (ra as u128, rb as u128) } else { (rb as u128, ra as u128) };
                let y = q.usdc_gross as u128;
                // y is the largest integer root: one more would break the product (when that is representable)
                if y + 1 <= r_other && y + 1 <= r_sold + shares as u128 {
                    let k = r_sold * r_other;
                    prop_assert!((r_sold + shares as u128 - (y + 1)) * (r_other - (y + 1)) < k);
                }
            }
        }

        #[test]
        fn prop_round_trip_no_profit((ra, rb) in pool_strategy(), usdc in 1_000_000u64..1_000_000_000_000, fee in prop_oneof![Just(0u16), Just(50u16), Just(100u16), Just(200u16)], above in any::<bool>()) {
            let side = if above { Side::Above } else { Side::Below };
            if let Ok(b) = quote_buy(ra, rb, side, usdc, fee) {
                if let Ok(s) = quote_sell(b.ra_after, b.rb_after, side, b.shares_out, fee) {
                    prop_assert!(s.usdc_out <= usdc, "profit from round trip");
                    // pool conservation: after the round trip the pool is no worse off
                    let k0 = (ra as u128) * (rb as u128);
                    let k1 = (s.ra_after as u128) * (s.rb_after as u128);
                    prop_assert!(k1 >= k0);
                }
            }
        }

        /// Vault accounting: after any sequence of buys and sells vault == complete_sets + fee_pool,
        /// real supplies are non-negative, and the pool never mints more than it holds.
        #[test]
        fn prop_vault_equals_sets_plus_fees(
            liquidity in 100_000_000u64..1_000_000_000_000,
            p0 in 200u16..=9800,
            ops in proptest::collection::vec((any::<bool>(), any::<bool>(), 1u64..1_000_000_000), 1..40),
            fee in prop_oneof![Just(50u16), Just(100u16), Just(200u16)],
        ) {
            let seed = seed_reserves(liquidity, p0).unwrap();
            let (mut ra, mut rb) = (seed.reserve_above, seed.reserve_below);
            let mut n: u128 = liquidity as u128;
            let mut fee_pool: u128 = 0;
            let mut vault: u128 = liquidity as u128;
            let mut real_a: u128 = seed.creator_above as u128;
            let mut real_b: u128 = seed.creator_below as u128;
            prop_assert_eq!(real_a + ra as u128, n);
            prop_assert_eq!(real_b + rb as u128, n);
            for (is_buy, above, amt) in ops {
                let side = if above { Side::Above } else { Side::Below };
                if is_buy {
                    let usdc = amt.max(MIN_TRADE_USDC);
                    if let Ok(q) = quote_buy(ra, rb, side, usdc, fee) {
                        vault += usdc as u128;
                        n += q.usdc_into_sets as u128;
                        fee_pool += q.fee as u128;
                        ra = q.ra_after; rb = q.rb_after;
                        if above { real_a += q.shares_out as u128 } else { real_b += q.shares_out as u128 }
                    }
                } else {
                    let held = if above { real_a } else { real_b };
                    let shares = (amt as u128).min(held) as u64;
                    if shares == 0 { continue; }
                    if let Ok(q) = quote_sell(ra, rb, side, shares, fee) {
                        if q.usdc_gross < MIN_SELL_GROSS_USDC { continue; }
                        vault -= q.usdc_out as u128;
                        n -= q.usdc_gross as u128;
                        fee_pool += q.fee as u128;
                        ra = q.ra_after; rb = q.rb_after;
                        if above { real_a -= shares as u128 } else { real_b -= shares as u128 }
                    }
                }
                prop_assert_eq!(vault, n + fee_pool);
                // real supply identity: realA = N - ra, realB = N - rb
                prop_assert_eq!(real_a + ra as u128, n);
                prop_assert_eq!(real_b + rb as u128, n);
            }
            // Settlement solvency, both outcomes: payout to all holders + LP claim <= vault, and it is exact.
            for above_won in [true, false] {
                let lp = settled_lp_claim(above_won, ra, rb, fee_pool as u64).unwrap() as u128;
                let users = if above_won { real_a } else { real_b };
                prop_assert_eq!(users + lp, vault);
            }
            // Void solvency
            let lp = void_lp_claim(n as u64, ra, rb, fee_pool as u64).unwrap() as u128;
            let owed_a = real_a / 2;
            let owed_b = real_b / 2;
            prop_assert!(owed_a + owed_b + lp <= vault);
        }

        #[test]
        fn prop_merge_conservation(
            liquidity in 100_000_000u64..1_000_000_000_000,
            p0 in 200u16..=9800,
            usdc in 1_000_000u64..50_000_000_000u64,
        ) {
            // A user who buys ABOVE and BELOW and merges the minimum of both gets back at most what they paid.
            let seed = seed_reserves(liquidity, p0).unwrap();
            let a = quote_buy(seed.reserve_above, seed.reserve_below, Side::Above, usdc, 100).unwrap();
            let b = quote_buy(a.ra_after, a.rb_after, Side::Below, usdc, 100).unwrap();
            let m = a.shares_out.min(b.shares_out);
            prop_assert!(m <= 2 * usdc);
        }

        #[test]
        fn prop_ema_bounded(ema in 0u32..10_000, ts in 0i64..1_000_000, dt in 0i64..10_000_000, impact in 0u32..=10_000) {
            let e = update_ema(ema, ts, impact, ts + dt);
            prop_assert!(e <= ema.max(impact));
            prop_assert!(e >= ema.min(impact));
        }

        #[test]
        fn prop_dynamic_fee_capped(base in prop_oneof![Just(50u16), Just(100u16), Just(200u16)], ema in 0u32..10_000, now in 0i64..4_000_000, settle in 0i64..4_000_000) {
            let p = fee_bps_now(base, true, 300, ema, now / 2, settle, now);
            prop_assert!(p.total <= 300);
            prop_assert!(p.total >= base);
            prop_assert!(p.near <= 80 && p.flow <= 50);
        }

        #[test]
        fn prop_lp_payouts_sum_to_claim(claim in 0u64..u64::MAX / 2, parts in proptest::collection::vec(1u64..1_000_000, 1..8)) {
            let supply: u64 = parts.iter().sum();
            let mut claim_rem = claim;
            let mut supply_rem = supply;
            let mut paid: u128 = 0;
            for p in &parts {
                let pay = lp_payout(claim_rem, *p, supply_rem).unwrap();
                paid += pay as u128;
                claim_rem -= pay;
                supply_rem -= *p;
            }
            prop_assert!(paid <= claim as u128);
            // the last LP exits with everything that is left, so nothing is stranded
            prop_assert_eq!(paid, claim as u128);
        }
    }
}
