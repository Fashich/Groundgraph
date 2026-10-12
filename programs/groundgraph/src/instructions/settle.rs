use anchor_lang::prelude::*;
use core::cmp::Ordering;
use pyth_solana_receiver_sdk::price_update::{PriceUpdateV2, VerificationLevel};

use crate::constants::*;
use crate::errors::{GgError, MathResultExt};
use crate::events::{Settled, Voided};
use crate::math;
use crate::spl;
use crate::state::{Config, Market, MarketKind, MarketStatus, Outcome};

#[derive(Accounts)]
pub struct SettleClose<'info> {
    /// Anyone can settle; the signer only pays the transaction fee.
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        dup,
        seeds = [MARKET_SEED, market.creator.as_ref(), &market.nonce.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,
    /// CHECK: must equal `market.lp_mint`; supply is read in the handler.
    #[account(address = market.lp_mint @ GgError::WrongMint)]
    pub lp_mint: UncheckedAccount<'info>,
    /// Must be owned by the Pyth Receiver program (enforced by `Account<PriceUpdateV2>`).
    pub price_update: Account<'info, PriceUpdateV2>,
}

pub fn handle_settle_close(ctx: Context<SettleClose>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let cfg = &ctx.accounts.config;
    let m = &mut ctx.accounts.market;
    require!(m.status == MarketStatus::Open, GgError::MarketNotOpen);
    require!(m.kind == MarketKind::Close, GgError::NotEnabledInThisVersion);
    require!(now >= m.settle_ts, GgError::TooEarlyToSettle);

    let pu = &ctx.accounts.price_update;
    require!(pu.verification_level.gte(VerificationLevel::Full), GgError::InsufficientVerification);
    let msg = &pu.price_message;
    require!(msg.feed_id == m.feed_id, GgError::WrongFeedId);
    require!(msg.publish_time >= m.settle_ts, GgError::PriceStale);
    let window_end = m.settle_ts.checked_add(cfg.max_staleness_secs as i64).ok_or(GgError::MathOverflow)?;
    require!(msg.publish_time <= window_end, GgError::PriceOutsideWindow);
    require!(msg.price > 0, GgError::NonPositivePrice);
    require!(math::confidence_ok(msg.conf, msg.price, cfg.max_conf_bps), GgError::ConfidenceTooWide);

    // Strictly above the target settles ABOVE; equal or below settles BELOW.
    let above_won = math::compare_price(msg.price, msg.exponent, m.target_price, m.target_expo).gg()? == Ordering::Greater;
    let lp_claim = math::settled_lp_claim(above_won, m.reserve_above, m.reserve_below, m.fee_pool).gg()?;

    m.status = MarketStatus::Settled;
    m.outcome = if above_won { Outcome::Above } else { Outcome::Below };
    m.settle_price = msg.price;
    m.settle_expo = msg.exponent;
    m.settle_publish_ts = msg.publish_time;
    m.lp_claim_remaining = lp_claim;
    m.lp_supply_remaining = spl::load_mint(&ctx.accounts.lp_mint)?.supply;

    emit!(Settled {
        market: m.key(),
        outcome: m.outcome,
        price: msg.price,
        expo: msg.exponent,
        publish_ts: msg.publish_time,
        lp_claim,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct VoidMarket<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        dup,
        seeds = [MARKET_SEED, market.creator.as_ref(), &market.nonce.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,
    /// CHECK: must equal `market.lp_mint`; supply is read in the handler.
    #[account(address = market.lp_mint @ GgError::WrongMint)]
    pub lp_mint: UncheckedAccount<'info>,
}

/// Liveness fallback: if no valid price settled the market within the grace period, users can exit at 0.5 USDC per share.
pub fn handle_void_market(ctx: Context<VoidMarket>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let m = &mut ctx.accounts.market;
    require!(m.status == MarketStatus::Open, GgError::MarketNotOpen);
    let void_at = m.settle_ts.checked_add(VOID_GRACE_SECS).ok_or(GgError::MathOverflow)?;
    require!(now >= void_at, GgError::TooEarlyToVoid);

    let lp_claim = math::void_lp_claim(m.complete_sets, m.reserve_above, m.reserve_below, m.fee_pool).gg()?;
    m.status = MarketStatus::Voided;
    m.outcome = Outcome::None;
    m.lp_claim_remaining = lp_claim;
    m.lp_supply_remaining = spl::load_mint(&ctx.accounts.lp_mint)?.supply;

    emit!(Voided { market: m.key(), lp_claim });
    Ok(())
}
