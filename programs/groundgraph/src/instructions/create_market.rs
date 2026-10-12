use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::constants::*;
use crate::errors::{GgError, MathResultExt};
use crate::events::MarketCreated;
use crate::math;
use crate::spl::{self, AssociatedToken, Token};
use crate::state::{Config, Direction, FeedAllowlist, Market, MarketKind, MarketStatus, Outcome};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CreateMarketParams {
    pub nonce: u64,
    pub feed_id: [u8; 32],
    pub kind: MarketKind,
    pub direction: Direction,
    pub target_price: i64,
    pub target_expo: i32,
    pub settle_ts: i64,
    pub base_fee_bps: u16,
    pub dynamic_fee: bool,
    pub liquidity: u64,
    pub p0_bps: u16,
}

#[derive(Accounts)]
#[instruction(params: CreateMarketParams)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [FEED_SEED, params.feed_id.as_ref()], bump = feed.bump)]
    pub feed: Box<Account<'info, FeedAllowlist>>,
    /// CHECK: must equal `config.usdc_mint`.
    #[account(address = config.usdc_mint @ GgError::WrongCollateralMint)]
    pub collateral_mint: UncheckedAccount<'info>,
    #[account(
        init,
        payer = creator,
        space = 8 + Market::INIT_SPACE,
        seeds = [MARKET_SEED, creator.key().as_ref(), &params.nonce.to_le_bytes()],
        bump
    )]
    pub market: Box<Account<'info, Market>>,
    /// CHECK: PDA ["vault", market]; created and initialized as a token account in the handler.
    #[account(mut, seeds = [VAULT_SEED, market.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: PDA ["above", market]; created and initialized as a mint in the handler.
    #[account(mut, seeds = [ABOVE_SEED, market.key().as_ref()], bump)]
    pub above_mint: UncheckedAccount<'info>,
    /// CHECK: PDA ["below", market]; created and initialized as a mint in the handler.
    #[account(mut, seeds = [BELOW_SEED, market.key().as_ref()], bump)]
    pub below_mint: UncheckedAccount<'info>,
    /// CHECK: PDA ["lp", market]; created and initialized as a mint in the handler.
    #[account(mut, seeds = [LP_SEED, market.key().as_ref()], bump)]
    pub lp_mint: UncheckedAccount<'info>,
    /// CHECK: the creator's collateral token account; validated in the handler.
    #[account(mut)]
    pub creator_usdc: UncheckedAccount<'info>,
    /// CHECK: creator's ATA for ABOVE. Created idempotently; the ATA program verifies the address derivation.
    #[account(mut)]
    pub creator_above: UncheckedAccount<'info>,
    /// CHECK: creator's ATA for BELOW (same checks as above).
    #[account(mut)]
    pub creator_below: UncheckedAccount<'info>,
    /// CHECK: creator's ATA for the LP mint (same checks as above).
    #[account(mut)]
    pub creator_lp: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Create a PDA-owned account of `space` bytes, tolerating a pre-funded address (same approach as Anchor's `init`).
fn create_pda_account<'info>(
    payer: &AccountInfo<'info>,
    target: &AccountInfo<'info>,
    system_program_id: Pubkey,
    space: usize,
    owner: &Pubkey,
    signer: &[&[&[u8]]],
    rent: &Rent,
) -> Result<()> {
    let required = rent.minimum_balance(space);
    if target.lamports() == 0 {
        system_program::create_account(
            CpiContext::new_with_signer(
                system_program_id,
                system_program::CreateAccount { from: payer.clone(), to: target.clone() },
                signer,
            ),
            required,
            space as u64,
            owner,
        )
    } else {
        let shortfall = required.saturating_sub(target.lamports());
        if shortfall > 0 {
            system_program::transfer(
                CpiContext::new(
                    system_program_id,
                    system_program::Transfer { from: payer.clone(), to: target.clone() },
                ),
                shortfall,
            )?;
        }
        system_program::allocate(
            CpiContext::new_with_signer(
                system_program_id,
                system_program::Allocate { account_to_allocate: target.clone() },
                signer,
            ),
            space as u64,
        )?;
        system_program::assign(
            CpiContext::new_with_signer(
                system_program_id,
                system_program::Assign { account_to_assign: target.clone() },
                signer,
            ),
            owner,
        )
    }
}

pub fn handle_create_market(ctx: Context<CreateMarket>, p: CreateMarketParams) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, GgError::Paused);
    require!(p.kind == MarketKind::Close && p.direction == Direction::None, GgError::NotEnabledInThisVersion);
    require!(ctx.accounts.feed.enabled, GgError::FeedNotAllowed);
    require!(p.target_price > 0 && (-18..=0).contains(&p.target_expo), GgError::InvalidTarget);
    require!(ALLOWED_BASE_FEES_BPS.contains(&p.base_fee_bps), GgError::InvalidBaseFee);
    require!(p.liquidity >= cfg.min_liquidity, GgError::LiquidityTooLow);

    let duration = p.settle_ts.checked_sub(now).ok_or(GgError::MathOverflow)?;
    require!(duration >= cfg.min_duration_secs, GgError::DurationTooShort);
    require!(duration <= cfg.max_duration_secs, GgError::DurationTooLong);
    let trading_end_ts = p.settle_ts.checked_sub(cfg.trading_close_secs as i64).ok_or(GgError::MathOverflow)?;
    require!(trading_end_ts > now, GgError::DurationTooShort);

    let seed = math::seed_reserves(p.liquidity, p.p0_bps).gg()?;

    // The creator's collateral account must hold the liquidity; the token program re-checks on transfer.
    let collateral_key = ctx.accounts.collateral_mint.key();
    let creator_key = ctx.accounts.creator.key();
    let usdc = spl::load_owned_token_account(&ctx.accounts.creator_usdc, &collateral_key, &creator_key)?;
    require!(usdc.amount >= p.liquidity, GgError::LiquidityTooLow);

    let market_key = ctx.accounts.market.key();
    let bump = ctx.bumps.market;

    {
        let m = &mut ctx.accounts.market;
        m.creator = creator_key;
        m.nonce = p.nonce;
        m.collateral_mint = collateral_key;
        m.vault = ctx.accounts.vault.key();
        m.above_mint = ctx.accounts.above_mint.key();
        m.below_mint = ctx.accounts.below_mint.key();
        m.lp_mint = ctx.accounts.lp_mint.key();
        m.kind = p.kind;
        m.direction = p.direction;
        m.feed_id = p.feed_id;
        m.target_price = p.target_price;
        m.target_expo = p.target_expo;
        m.open_ts = now;
        m.trading_end_ts = trading_end_ts;
        m.settle_ts = p.settle_ts;
        m.base_fee_bps = p.base_fee_bps;
        m.dynamic_fee = p.dynamic_fee;
        m.complete_sets = p.liquidity;
        m.reserve_above = seed.reserve_above;
        m.reserve_below = seed.reserve_below;
        m.fee_pool = 0;
        m.ema_impact_bps = 0;
        m.ema_ts = now;
        m.status = MarketStatus::Open;
        m.outcome = Outcome::None;
        m.settle_price = 0;
        m.settle_expo = 0;
        m.settle_publish_ts = 0;
        m.lp_claim_remaining = 0;
        m.lp_supply_remaining = 0;
        m.bump = bump;
    }

    // Create the PDA vault and the three mints, all controlled by the market PDA.
    let rent = Rent::get()?;
    let system_id = ctx.accounts.system_program.key();
    let creator_ai = ctx.accounts.creator.to_account_info();
    let market_ai = ctx.accounts.market.to_account_info();
    let token_ai = ctx.accounts.token_program.to_account_info();
    {
        let vault_bump = [ctx.bumps.vault];
        let s: &[&[u8]] = &[VAULT_SEED, market_key.as_ref(), &vault_bump];
        let vault_ai = ctx.accounts.vault.to_account_info();
        create_pda_account(&creator_ai, &vault_ai, system_id, spl::TOKEN_ACCOUNT_LEN, &spl::TOKEN_PROGRAM_ID, &[s], &rent)?;
        spl::initialize_account3(&vault_ai, &ctx.accounts.collateral_mint.to_account_info(), &market_key)?;
    }
    for (seed, bump, ai) in [
        (ABOVE_SEED, ctx.bumps.above_mint, ctx.accounts.above_mint.to_account_info()),
        (BELOW_SEED, ctx.bumps.below_mint, ctx.accounts.below_mint.to_account_info()),
        (LP_SEED, ctx.bumps.lp_mint, ctx.accounts.lp_mint.to_account_info()),
    ] {
        let bump_arr = [bump];
        let s: &[&[u8]] = &[seed, market_key.as_ref(), &bump_arr];
        create_pda_account(&creator_ai, &ai, system_id, spl::MINT_LEN, &spl::TOKEN_PROGRAM_ID, &[s], &rent)?;
        spl::initialize_mint2(&ai, TOKEN_DECIMALS, &market_key)?;
    }

    // Idempotently create the creator's associated token accounts.
    let system_ai = ctx.accounts.system_program.to_account_info();
    for (ata, mint) in [
        (ctx.accounts.creator_above.to_account_info(), ctx.accounts.above_mint.to_account_info()),
        (ctx.accounts.creator_below.to_account_info(), ctx.accounts.below_mint.to_account_info()),
        (ctx.accounts.creator_lp.to_account_info(), ctx.accounts.lp_mint.to_account_info()),
    ] {
        spl::create_ata_idempotent(&creator_ai, &ata, &creator_ai, &mint, &system_ai, &token_ai)?;
    }

    // Collateral in: creator -> vault.
    spl::transfer(
        &ctx.accounts.creator_usdc.to_account_info(),
        &ctx.accounts.vault.to_account_info(),
        &creator_ai,
        p.liquidity,
        &[],
    )?;

    // Mint LP tokens and the creator's share of the seeded outcome tokens, signed by the market PDA.
    let nonce_bytes = p.nonce.to_le_bytes();
    let bump_arr = [bump];
    let seeds: &[&[u8]] = &[MARKET_SEED, creator_key.as_ref(), &nonce_bytes, &bump_arr];
    spl::mint_to(
        &ctx.accounts.lp_mint.to_account_info(),
        &ctx.accounts.creator_lp.to_account_info(),
        &market_ai,
        p.liquidity,
        &[seeds],
    )?;
    if seed.creator_above > 0 {
        spl::mint_to(
            &ctx.accounts.above_mint.to_account_info(),
            &ctx.accounts.creator_above.to_account_info(),
            &market_ai,
            seed.creator_above,
            &[seeds],
        )?;
    }
    if seed.creator_below > 0 {
        spl::mint_to(
            &ctx.accounts.below_mint.to_account_info(),
            &ctx.accounts.creator_below.to_account_info(),
            &market_ai,
            seed.creator_below,
            &[seeds],
        )?;
    }

    emit!(MarketCreated {
        market: market_key,
        creator: creator_key,
        feed_id: p.feed_id,
        target_price: p.target_price,
        target_expo: p.target_expo,
        kind: p.kind,
        settle_ts: p.settle_ts,
        trading_end_ts,
        base_fee_bps: p.base_fee_bps,
        dynamic_fee: p.dynamic_fee,
        liquidity: p.liquidity,
        p0_bps: p.p0_bps,
        above_mint: ctx.accounts.above_mint.key(),
        below_mint: ctx.accounts.below_mint.key(),
        lp_mint: ctx.accounts.lp_mint.key(),
        vault: ctx.accounts.vault.key(),
    });
    Ok(())
}
