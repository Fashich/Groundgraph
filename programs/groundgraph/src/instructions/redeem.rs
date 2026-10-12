use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::{GgError, MathResultExt};
use crate::events::{LiquidityChanged, Redeemed};
use crate::math;
use crate::spl::{self, Token};
use crate::state::{Market, MarketStatus, Outcome, Side};

#[derive(Accounts)]
#[instruction(side: Side)]
pub struct Redeem<'info> {
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

/// Settled: only the winning side redeems, 1 USDC per share. Voided: either side, 0.5 USDC per share (floor).
pub fn handle_redeem(ctx: Context<Redeem>, side: Side, amount: u64) -> Result<()> {
    let user_key = ctx.accounts.user.key();
    let m = &mut ctx.accounts.market;
    require!(amount > 0, GgError::ZeroAmount);
    let payout = match m.status {
        MarketStatus::Open => return err!(GgError::NotResolved),
        MarketStatus::Settled => {
            let winning = match m.outcome {
                Outcome::Above => Side::Above,
                Outcome::Below => Side::Below,
                Outcome::None => return err!(GgError::NotResolved),
            };
            require!(side == winning, GgError::NotWinningSide);
            amount
        }
        MarketStatus::Voided => {
            let p = math::void_redeem_payout(amount);
            require!(p > 0, GgError::AmountTooSmall);
            p
        }
    };
    spl::load_owned_token_account(&ctx.accounts.user_outcome, &ctx.accounts.outcome_mint.key(), &user_key)?;
    spl::load_owned_token_account(&ctx.accounts.user_usdc, &m.collateral_mint, &user_key)?;
    // Never pay more than the vault holds, and keep the books consistent.
    require!(spl::load_token_account(&ctx.accounts.vault)?.amount >= payout, GgError::InvariantViolated);
    m.complete_sets = m.complete_sets.checked_sub(payout).ok_or(GgError::MathOverflow)?;

    let creator = m.creator;
    let nonce_bytes = m.nonce.to_le_bytes();
    let bump_arr = [m.bump];
    let market_key = m.key();

    spl::burn(
        &ctx.accounts.user_outcome.to_account_info(),
        &ctx.accounts.outcome_mint.to_account_info(),
        &ctx.accounts.user.to_account_info(),
        amount,
        &[],
    )?;
    let seeds: &[&[u8]] = &[MARKET_SEED, creator.as_ref(), &nonce_bytes, &bump_arr];
    spl::transfer(
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.user_usdc.to_account_info(),
        &ctx.accounts.market.to_account_info(),
        payout,
        &[seeds],
    )?;

    emit!(Redeemed { market: market_key, wallet: user_key, side, shares: amount, usdc: payout });
    Ok(())
}

#[derive(Accounts)]
pub struct RemoveLiquidity<'info> {
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
    /// CHECK: must equal `market.lp_mint`.
    #[account(mut, address = market.lp_mint @ GgError::WrongMint)]
    pub lp_mint: UncheckedAccount<'info>,
    /// CHECK: LP token account of `user`; validated in the handler.
    #[account(mut)]
    pub user_lp: UncheckedAccount<'info>,
    /// CHECK: collateral token account of `user`; validated in the handler.
    #[account(mut)]
    pub user_usdc: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Post-settlement LP exit. Payout is a pro-rata share of the claim snapshot taken at settle / void time, so LP
/// tokens burned in any order always sum to at most the claim.
pub fn handle_remove_liquidity(ctx: Context<RemoveLiquidity>, lp_amount: u64) -> Result<()> {
    let user_key = ctx.accounts.user.key();
    let m = &mut ctx.accounts.market;
    require!(m.status != MarketStatus::Open, GgError::NotResolved);
    require!(lp_amount > 0 && lp_amount <= m.lp_supply_remaining, GgError::InvalidLpAmount);
    spl::load_owned_token_account(&ctx.accounts.user_lp, &m.lp_mint, &user_key)?;
    spl::load_owned_token_account(&ctx.accounts.user_usdc, &m.collateral_mint, &user_key)?;

    let payout = math::lp_payout(m.lp_claim_remaining, lp_amount, m.lp_supply_remaining).gg()?;
    require!(spl::load_token_account(&ctx.accounts.vault)?.amount >= payout, GgError::InvariantViolated);
    m.lp_claim_remaining = m.lp_claim_remaining.checked_sub(payout).ok_or(GgError::MathOverflow)?;
    m.lp_supply_remaining = m.lp_supply_remaining.checked_sub(lp_amount).ok_or(GgError::MathOverflow)?;

    let creator = m.creator;
    let nonce_bytes = m.nonce.to_le_bytes();
    let bump_arr = [m.bump];
    let market_key = m.key();

    spl::burn(
        &ctx.accounts.user_lp.to_account_info(),
        &ctx.accounts.lp_mint.to_account_info(),
        &ctx.accounts.user.to_account_info(),
        lp_amount,
        &[],
    )?;
    if payout > 0 {
        let seeds: &[&[u8]] = &[MARKET_SEED, creator.as_ref(), &nonce_bytes, &bump_arr];
        spl::transfer(
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.user_usdc.to_account_info(),
            &ctx.accounts.market.to_account_info(),
            payout,
            &[seeds],
        )?;
    }

    emit!(LiquidityChanged { market: market_key, wallet: user_key, lp_amount, usdc: payout, is_add: false });
    Ok(())
}
