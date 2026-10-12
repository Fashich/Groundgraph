use anchor_lang::prelude::*;

use crate::state::{MarketKind, Outcome, Side};

#[event]
pub struct MarketCreated {
    pub market: Pubkey,
    pub creator: Pubkey,
    pub feed_id: [u8; 32],
    pub target_price: i64,
    pub target_expo: i32,
    pub kind: MarketKind,
    pub settle_ts: i64,
    pub trading_end_ts: i64,
    pub base_fee_bps: u16,
    pub dynamic_fee: bool,
    pub liquidity: u64,
    pub p0_bps: u16,
    pub above_mint: Pubkey,
    pub below_mint: Pubkey,
    pub lp_mint: Pubkey,
    pub vault: Pubkey,
}

/// `usdc` is the USDC that moved between the wallet and the vault (buy: gross amount paid including the fee;
/// sell: net amount received after the fee). `shares` is the outcome shares minted (buy) or burned (sell).
#[event]
pub struct Trade {
    pub market: Pubkey,
    pub wallet: Pubkey,
    pub side: Side,
    pub is_buy: bool,
    pub usdc: u64,
    pub shares: u64,
    pub fee_usdc: u64,
    pub fee_bps: u16,
    pub price_after_bps: u32,
    pub reserve_above: u64,
    pub reserve_below: u64,
    pub ts: i64,
}

#[event]
pub struct Settled {
    pub market: Pubkey,
    pub outcome: Outcome,
    pub price: i64,
    pub expo: i32,
    pub publish_ts: i64,
    pub lp_claim: u64,
}

#[event]
pub struct Voided {
    pub market: Pubkey,
    pub lp_claim: u64,
}

#[event]
pub struct Redeemed {
    pub market: Pubkey,
    pub wallet: Pubkey,
    pub side: Side,
    pub shares: u64,
    pub usdc: u64,
}

#[event]
pub struct Merged {
    pub market: Pubkey,
    pub wallet: Pubkey,
    pub amount: u64,
}

#[event]
pub struct LiquidityChanged {
    pub market: Pubkey,
    pub wallet: Pubkey,
    pub lp_amount: u64,
    pub usdc: u64,
    pub is_add: bool,
}

#[event]
pub struct ConfigUpdated {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub usdc_mint: Pubkey,
    pub protocol_fee_share_bps: u16,
    pub max_fee_bps: u16,
    pub min_liquidity: u64,
    pub min_duration_secs: i64,
    pub max_duration_secs: i64,
    pub max_staleness_secs: u32,
    pub max_conf_bps: u16,
    pub trading_close_secs: u32,
    pub paused: bool,
}

#[event]
pub struct FeedUpdated {
    pub feed_id: [u8; 32],
    pub expo: i32,
    pub enabled: bool,
}
