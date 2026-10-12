//! PDA seeds and protocol constants.

pub const CONFIG_SEED: &[u8] = b"config";
pub const FEED_SEED: &[u8] = b"feed";
pub const MARKET_SEED: &[u8] = b"market";
pub const VAULT_SEED: &[u8] = b"vault";
pub const ABOVE_SEED: &[u8] = b"above";
pub const BELOW_SEED: &[u8] = b"below";
pub const LP_SEED: &[u8] = b"lp";

/// Outcome shares, LP tokens and the collateral all use 6 decimals.
pub const TOKEN_DECIMALS: u8 = 6;
pub const USDC_ONE: u64 = 1_000_000;

pub const DEFAULT_MAX_FEE_BPS: u16 = 300;
pub const DEFAULT_MIN_LIQUIDITY: u64 = 100 * USDC_ONE;
pub const DEFAULT_MIN_DURATION_SECS: i64 = 24 * 3_600;
pub const DEFAULT_MAX_DURATION_SECS: i64 = 180 * 24 * 3_600;
pub const DEFAULT_MAX_STALENESS_SECS: u32 = 60;
pub const DEFAULT_MAX_CONF_BPS: u16 = 50;
pub const DEFAULT_TRADING_CLOSE_SECS: u32 = 3_600;

/// A market can be voided once this long has passed after `settle_ts` without a valid settlement.
pub const VOID_GRACE_SECS: i64 = 3_600;

pub const ALLOWED_BASE_FEES_BPS: [u16; 3] = [50, 100, 200];
pub const MAX_SYMBOL_LEN: usize = 16;
