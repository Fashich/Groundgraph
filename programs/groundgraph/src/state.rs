use anchor_lang::prelude::*;

use crate::math;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Side {
    Above,
    Below,
}

impl From<Side> for math::Side {
    fn from(s: Side) -> Self {
        match s {
            Side::Above => math::Side::Above,
            Side::Below => math::Side::Below,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum MarketKind {
    Close,
    /// Reserved for Phase 2. create_market rejects it with `NotEnabledInThisVersion`.
    Touch,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Direction {
    /// Close markets.
    None,
    /// Touch markets (Phase 2).
    Up,
    Down,
}

/// Stored status. `TradingClosed` is derived off-chain from `trading_end_ts` and the clock.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum MarketStatus {
    Open,
    Settled,
    Voided,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Outcome {
    /// Not resolved, or voided.
    None,
    Above,
    Below,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub usdc_mint: Pubkey,
    /// Share of trade fees routed to the treasury. Reserved, unused in Phase 1.
    pub protocol_fee_share_bps: u16,
    pub max_fee_bps: u16,
    pub min_liquidity: u64,
    pub min_duration_secs: i64,
    pub max_duration_secs: i64,
    /// Width of the accepted settlement window: publish_time in [settle_ts, settle_ts + max_staleness_secs].
    pub max_staleness_secs: u32,
    pub max_conf_bps: u16,
    /// Buys stop this many seconds before settle_ts (mainnet default 3600).
    pub trading_close_secs: u32,
    pub paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct FeedAllowlist {
    pub feed_id: [u8; 32],
    #[max_len(16)]
    pub symbol: String,
    pub expo: i32,
    pub enabled: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub creator: Pubkey,
    pub nonce: u64,
    pub collateral_mint: Pubkey,
    pub vault: Pubkey,
    pub above_mint: Pubkey,
    pub below_mint: Pubkey,
    pub lp_mint: Pubkey,
    pub kind: MarketKind,
    pub direction: Direction,
    pub feed_id: [u8; 32],
    pub target_price: i64,
    pub target_expo: i32,
    pub open_ts: i64,
    pub trading_end_ts: i64,
    pub settle_ts: i64,
    pub base_fee_bps: u16,
    pub dynamic_fee: bool,
    /// Complete sets outstanding (N). While Open: vault.amount >= complete_sets + fee_pool (equality unless donated to).
    pub complete_sets: u64,
    pub reserve_above: u64,
    pub reserve_below: u64,
    pub fee_pool: u64,
    pub ema_impact_bps: u32,
    pub ema_ts: i64,
    pub status: MarketStatus,
    pub outcome: Outcome,
    pub settle_price: i64,
    pub settle_expo: i32,
    pub settle_publish_ts: i64,
    pub lp_claim_remaining: u64,
    pub lp_supply_remaining: u64,
    pub bump: u8,
}

impl Market {
    pub fn outcome_mint(&self, side: Side) -> Pubkey {
        match side {
            Side::Above => self.above_mint,
            Side::Below => self.below_mint,
        }
    }

    pub fn is_open(&self) -> bool {
        self.status == MarketStatus::Open
    }

    pub fn price_bps(&self) -> u32 {
        math::price_bps(self.reserve_above, self.reserve_below)
    }
}
