//! Groundgraph: non-custodial ABOVE/BELOW price markets on Solana, settled by Pyth.
//!
//! Phase 1 scope: config, feed allowlist, Close markets, buy / sell / merge, settle_close, void_market, redeem,
//! remove_liquidity (post settlement), events and a pause switch. See `docs/AMM.md` for the math and
//! `docs/THREAT_MODEL.md` for the security notes.
#![allow(clippy::result_large_err)]

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod spl;
pub mod state;

#[cfg(test)]
mod parity;

pub use constants::*;
pub use errors::*;
pub use events::*;
pub use instructions::*;
pub use state::*;

/// Panics abort the transaction without formatting a message (saves binary size; the error path is `Result`).
#[cfg(all(target_os = "solana", feature = "custom-panic"))]
#[no_mangle]
fn custom_panic(_info: &core::panic::PanicInfo<'_>) {}

declare_id!("5W8BS9j9ZFH7Uscjq2Sh7tU5SVmvf7Ay3fJMDjTnRPCC");

#[program]
pub mod groundgraph {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>, params: InitializeConfigParams) -> Result<()> {
        instructions::admin::handle_initialize_config(ctx, params)
    }

    pub fn update_config(ctx: Context<UpdateConfig>, params: UpdateConfigParams) -> Result<()> {
        instructions::admin::handle_update_config(ctx, params)
    }

    pub fn allow_feed(ctx: Context<AllowFeed>, feed_id: [u8; 32], symbol: String, expo: i32) -> Result<()> {
        instructions::admin::handle_allow_feed(ctx, feed_id, symbol, expo)
    }

    pub fn disallow_feed(ctx: Context<DisallowFeed>, feed_id: [u8; 32]) -> Result<()> {
        instructions::admin::handle_disallow_feed(ctx, feed_id)
    }

    pub fn create_market(ctx: Context<CreateMarket>, params: CreateMarketParams) -> Result<()> {
        instructions::create_market::handle_create_market(ctx, params)
    }

    pub fn buy(ctx: Context<Buy>, side: Side, usdc_in: u64, min_shares_out: u64) -> Result<()> {
        instructions::trade::handle_buy(ctx, side, usdc_in, min_shares_out)
    }

    pub fn sell(ctx: Context<Sell>, side: Side, shares_in: u64, min_usdc_out: u64) -> Result<()> {
        instructions::trade::handle_sell(ctx, side, shares_in, min_usdc_out)
    }

    pub fn merge(ctx: Context<Merge>, amount: u64) -> Result<()> {
        instructions::trade::handle_merge(ctx, amount)
    }

    pub fn settle_close(ctx: Context<SettleClose>) -> Result<()> {
        instructions::settle::handle_settle_close(ctx)
    }

    pub fn void_market(ctx: Context<VoidMarket>) -> Result<()> {
        instructions::settle::handle_void_market(ctx)
    }

    pub fn redeem(ctx: Context<Redeem>, side: Side, amount: u64) -> Result<()> {
        instructions::redeem::handle_redeem(ctx, side, amount)
    }

    pub fn remove_liquidity(ctx: Context<RemoveLiquidity>, lp_amount: u64) -> Result<()> {
        instructions::redeem::handle_remove_liquidity(ctx, lp_amount)
    }
}
