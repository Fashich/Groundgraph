use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::{GgError, MathResultExt};
use crate::events::{Merged, Trade};
use crate::math;
use crate::spl::{self, Token};
use crate::state::{Config, Market, MarketStatus, Side};

/// Price-impact EMA bookkeeping shared by buy and sell, then the reserve update.
fn apply_pool_update(m: &mut Market, ra_after: u64, rb_after: u64, now: i64) {
    if m.dynamic_fee {
        let impact = math::impact_bps(m.reserve_above, m.reserve_below, ra_after, rb_after);
        m.ema_impact_bps = math::update_ema(m.ema_impact_bps, m.ema_ts, impact, now);
        m.ema_ts = now;
    }
    m.reserve_above = ra_after;
    m.reserve_below = rb_after;
}

#[derive(Accounts)]
#[instruction(side: Side)]
pub struct Buy<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        dup,
        seeds = [MARKET_SEED, market.creator.as_ref(), &market.nonce.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,
    /// CHECK: must equal `market.vault`.
    #[account(mut, address = market.vault @ GgError::WrongVault)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: must equal the market's mint for `side`.
    #[account(mut, address = market.outcome_mint(side) @ GgError::WrongMint)]
    pub outcome_mint: UncheckedAccount<'info>,
    /// CHECK: collateral token account of `user`; validated in the handler.
    #[account(mut)]
    pub user_usdc: UncheckedAccount<'info>,
    /// CHECK: outcome token account of `user` for `side`; validated in the handler.
    #[account(mut)]
    pub user_outcome: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_buy(ctx: Context<Buy>, side: Side, usdc_in: u64, min_shares_out: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, GgError::Paused);
    let max_fee_bps = cfg.max_fee_bps;
    let user_key = ctx.accounts.user.key();

    let m = &mut ctx.accounts.market;
    require!(m.status == MarketStatus::Open, GgError::MarketNotOpen);
    require!(now < m.trading_end_ts, GgError::TradingEnded);
    require!(usdc_in > 0, GgError::ZeroAmount);
    require!(usdc_in >= math::MIN_TRADE_USDC, GgError::BelowMinTrade);

    spl::load_owned_token_account(&ctx.accounts.user_usdc, &m.collateral_mint, &user_key)?;
    spl::load_owned_token_account(&ctx.accounts.user_outcome, &ctx.accounts.outcome_mint.key(), &user_key)?;
    let vault_before = spl::load_token_account(&ctx.accounts.vault)?.amount;

    let fee = math::fee_bps_now(m.base_fee_bps, m.dynamic_fee, max_fee_bps, m.ema_impact_bps, m.ema_ts, m.settle_ts, now);
    let q = math::quote_buy(m.reserve_above, m.reserve_below, side.into(), usdc_in, fee.total).gg()?;
    require!(q.shares_out > 0 && q.shares_out >= min_shares_out, GgError::SlippageExceeded);

    m.complete_sets = m.complete_sets.checked_add(q.usdc_into_sets).ok_or(GgError::MathOverflow)?;
    m.fee_pool = m.fee_pool.checked_add(q.fee).ok_or(GgError::MathOverflow)?;
    apply_pool_update(m, q.ra_after, q.rb_after, now);
    // vault >= N + fee_pool (equality unless someone donated USDC straight to the vault)
    let expected = (m.complete_sets as u128) + (m.fee_pool as u128);
    require!((vault_before as u128) + (usdc_in as u128) >= expected, GgError::InvariantViolated);

    let creator = m.creator;
    let nonce_bytes = m.nonce.to_le_bytes();
    let bump_arr = [m.bump];
    let price_after = m.price_bps();
    let (ra, rb) = (m.reserve_above, m.reserve_below);
    let market_key = m.key();

    spl::transfer(
        &ctx.accounts.user_usdc.to_account_info(),
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.user.to_account_info(),
        usdc_in,
        &[],
    )?;
    let seeds: &[&[u8]] = &[MARKET_SEED, creator.as_ref(), &nonce_bytes, &bump_arr];
    spl::mint_to(
        &ctx.accounts.outcome_mint.to_account_info(),
        &ctx.accounts.user_outcome.to_account_info(),
        &ctx.accounts.market.to_account_info(),
        q.shares_out,
        &[seeds],
    )?;

    emit!(Trade {
        market: market_key,
        wallet: user_key,
        side,
        is_buy: true,
        usdc: usdc_in,
        shares: q.shares_out,
        fee_usdc: q.fee,
        fee_bps: fee.total,
        price_after_bps: price_after,
        reserve_above: ra,
        reserve_below: rb,
        ts: now,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(side: Side)]
pub struct Sell<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        dup,
        seeds = [MARKET_SEED, market.creator.as_ref(), &market.nonce.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,
    /// CHECK: must equal `market.vault`.
    #[account(mut, address = market.vault @ GgError::WrongVault)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: must equal the market's mint for `side`.
    #[account(mut, address = market.outcome_mint(side) @ GgError::WrongMint)]
    pub outcome_mint: UncheckedAccount<'info>,
    /// CHECK: outcome token account of `user` for `side`; validated in the handler.
    #[account(mut)]
    pub user_outcome: UncheckedAccount<'info>,
    /// CHECK: collateral token account of `user`; validated in the handler.
    #[account(mut)]
    pub user_usdc: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Sells are never blocked by the pause switch; only a resolved market stops them.
pub fn handle_sell(ctx: Context<Sell>, side: Side, shares_in: u64, min_usdc_out: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let max_fee_bps = ctx.accounts.config.max_fee_bps;
    let user_key = ctx.accounts.user.key();

    let m = &mut ctx.accounts.market;
    require!(m.status == MarketStatus::Open, GgError::MarketNotOpen);
    require!(shares_in > 0, GgError::ZeroAmount);

    spl::load_owned_token_account(&ctx.accounts.user_usdc, &m.collateral_mint, &user_key)?;
    spl::load_owned_token_account(&ctx.accounts.user_outcome, &ctx.accounts.outcome_mint.key(), &user_key)?;
    let vault_before = spl::load_token_account(&ctx.accounts.vault)?.amount;

    let fee = math::fee_bps_now(m.base_fee_bps, m.dynamic_fee, max_fee_bps, m.ema_impact_bps, m.ema_ts, m.settle_ts, now);
    let q = math::quote_sell(m.reserve_above, m.reserve_below, side.into(), shares_in, fee.total).gg()?;
    require!(q.usdc_gross >= math::MIN_SELL_GROSS_USDC, GgError::SellTooSmall);
    require!(q.usdc_out >= min_usdc_out, GgError::SlippageExceeded);

    m.complete_sets = m.complete_sets.checked_sub(q.usdc_gross).ok_or(GgError::MathOverflow)?;
    m.fee_pool = m.fee_pool.checked_add(q.fee).ok_or(GgError::MathOverflow)?;
    apply_pool_update(m, q.ra_after, q.rb_after, now);
    let expected = (m.complete_sets as u128) + (m.fee_pool as u128);
    require!(
        (vault_before as u128) >= (q.usdc_out as u128) && (vault_before as u128) - (q.usdc_out as u128) >= expected,
        GgError::InvariantViolated
    );

    let creator = m.creator;
    let nonce_bytes = m.nonce.to_le_bytes();
    let bump_arr = [m.bump];
    let price_after = m.price_bps();
    let (ra, rb) = (m.reserve_above, m.reserve_below);
    let market_key = m.key();

    spl::burn(
        &ctx.accounts.user_outcome.to_account_info(),
        &ctx.accounts.outcome_mint.to_account_info(),
        &ctx.accounts.user.to_account_info(),
        shares_in,
        &[],
    )?;
    let seeds: &[&[u8]] = &[MARKET_SEED, creator.as_ref(), &nonce_bytes, &bump_arr];
    spl::transfer(
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.user_usdc.to_account_info(),
        &ctx.accounts.market.to_account_info(),
        q.usdc_out,
        &[seeds],
    )?;

    emit!(Trade {
        market: market_key,
        wallet: user_key,
        side,
        is_buy: false,
        usdc: q.usdc_out,
        shares: shares_in,
        fee_usdc: q.fee,
        fee_bps: fee.total,
        price_after_bps: price_after,
        reserve_above: ra,
        reserve_below: rb,
        ts: now,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Merge<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        dup,
        seeds = [MARKET_SEED, market.creator.as_ref(), &market.nonce.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,
    /// CHECK: must equal `market.vault`.
    #[account(mut, address = market.vault @ GgError::WrongVault)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: must equal `market.above_mint`.
    #[account(mut, address = market.above_mint @ GgError::WrongMint)]
    pub above_mint: UncheckedAccount<'info>,
    /// CHECK: must equal `market.below_mint`.
    #[account(mut, address = market.below_mint @ GgError::WrongMint)]
    pub below_mint: UncheckedAccount<'info>,
    /// CHECK: ABOVE token account of `user`; validated in the handler.
    #[account(mut)]
    pub user_above: UncheckedAccount<'info>,
    /// CHECK: BELOW token account of `user`; validated in the handler.
    #[account(mut)]
    pub user_below: UncheckedAccount<'info>,
    /// CHECK: collateral token account of `user`; validated in the handler.
    #[account(mut)]
    pub user_usdc: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Burn `amount` ABOVE and `amount` BELOW and release `amount` USDC. No fee. Allowed while Open, even after trading ends.
pub fn handle_merge(ctx: Context<Merge>, amount: u64) -> Result<()> {
    let user_key = ctx.accounts.user.key();
    let m = &mut ctx.accounts.market;
    require!(m.status == MarketStatus::Open, GgError::MarketNotOpen);
    require!(amount > 0, GgError::ZeroAmount);
    spl::load_owned_token_account(&ctx.accounts.user_above, &m.above_mint, &user_key)?;
    spl::load_owned_token_account(&ctx.accounts.user_below, &m.below_mint, &user_key)?;
    spl::load_owned_token_account(&ctx.accounts.user_usdc, &m.collateral_mint, &user_key)?;
    m.complete_sets = m.complete_sets.checked_sub(amount).ok_or(GgError::MathOverflow)?;

    let creator = m.creator;
    let nonce_bytes = m.nonce.to_le_bytes();
    let bump_arr = [m.bump];
    let market_key = m.key();

    let user_ai = ctx.accounts.user.to_account_info();
    spl::burn(&ctx.accounts.user_above.to_account_info(), &ctx.accounts.above_mint.to_account_info(), &user_ai, amount, &[])?;
    spl::burn(&ctx.accounts.user_below.to_account_info(), &ctx.accounts.below_mint.to_account_info(), &user_ai, amount, &[])?;
    let seeds: &[&[u8]] = &[MARKET_SEED, creator.as_ref(), &nonce_bytes, &bump_arr];
    spl::transfer(
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.user_usdc.to_account_info(),
        &ctx.accounts.market.to_account_info(),
        amount,
        &[seeds],
    )?;

    emit!(Merged { market: market_key, wallet: user_key, amount });
    Ok(())
}
