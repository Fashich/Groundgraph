use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::GgError;
use crate::events::{ConfigUpdated, FeedUpdated};
use crate::spl;
use crate::state::{Config, FeedAllowlist};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitializeConfigParams {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub protocol_fee_share_bps: u16,
    pub max_fee_bps: u16,
    pub min_liquidity: u64,
    pub min_duration_secs: i64,
    pub max_duration_secs: i64,
    pub max_staleness_secs: u32,
    pub max_conf_bps: u16,
    pub trading_close_secs: u32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default)]
pub struct UpdateConfigParams {
    pub new_admin: Option<Pubkey>,
    pub treasury: Option<Pubkey>,
    pub protocol_fee_share_bps: Option<u16>,
    pub max_fee_bps: Option<u16>,
    pub min_liquidity: Option<u64>,
    pub min_duration_secs: Option<i64>,
    pub max_duration_secs: Option<i64>,
    pub max_staleness_secs: Option<u32>,
    pub max_conf_bps: Option<u16>,
    pub trading_close_secs: Option<u32>,
    pub paused: Option<bool>,
}

/// Sanity bounds for every tunable. Keeps a compromised or mistaken admin transaction from bricking markets.
fn validate_config(c: &Config) -> Result<()> {
    require!(c.protocol_fee_share_bps <= 10_000, GgError::InvalidConfig);
    require!((200..=1_000).contains(&c.max_fee_bps), GgError::InvalidConfig);
    require!(c.min_liquidity >= USDC_ONE, GgError::InvalidConfig);
    require!(c.min_duration_secs >= 60, GgError::InvalidConfig);
    require!(c.max_duration_secs >= c.min_duration_secs, GgError::InvalidConfig);
    require!(c.max_duration_secs <= 400 * 24 * 3_600, GgError::InvalidConfig);
    require!((1..=3_600).contains(&c.max_staleness_secs), GgError::InvalidConfig);
    require!((1..=1_000).contains(&c.max_conf_bps), GgError::InvalidConfig);
    require!(c.trading_close_secs <= 24 * 3_600, GgError::InvalidConfig);
    // A market must leave a trading window: min duration has to exceed the trading close buffer.
    require!(c.min_duration_secs > c.trading_close_secs as i64, GgError::InvalidConfig);
    Ok(())
}

fn emit_config(c: &Config) {
    emit!(ConfigUpdated {
        admin: c.admin,
        treasury: c.treasury,
        usdc_mint: c.usdc_mint,
        protocol_fee_share_bps: c.protocol_fee_share_bps,
        max_fee_bps: c.max_fee_bps,
        min_liquidity: c.min_liquidity,
        min_duration_secs: c.min_duration_secs,
        max_duration_secs: c.max_duration_secs,
        max_staleness_secs: c.max_staleness_secs,
        max_conf_bps: c.max_conf_bps,
        trading_close_secs: c.trading_close_secs,
        paused: c.paused,
    });
}

/// Initialization is gated on the program's upgrade authority so nobody can front-run the deployer and become admin.
#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    /// CHECK: validated in the handler as an initialized 6-decimal SPL mint.
    pub usdc_mint: UncheckedAccount<'info>,
    /// CHECK: the BPF Upgradeable Loader ProgramData PDA of this program; the upgrade authority is parsed and
    /// compared to `authority` in the handler (a hand parse avoids pulling bincode/serde into the binary).
    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = anchor_lang::solana_program::bpf_loader_upgradeable::ID
    )]
    pub program_data: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Returns the upgrade authority recorded in a BPF Upgradeable Loader `ProgramData` account, if any.
/// Layout (bincode): u32 variant tag (3 = ProgramData), u64 slot, Option<Pubkey> (1 byte tag + 32 bytes).
fn upgrade_authority(program_data: &AccountInfo) -> Result<Option<Pubkey>> {
    require!(
        program_data.owner == &anchor_lang::solana_program::bpf_loader_upgradeable::ID,
        GgError::NotUpgradeAuthority
    );
    let data = program_data.try_borrow_data()?;
    require!(data.len() >= 45 && data[0..4] == [3, 0, 0, 0], GgError::NotUpgradeAuthority);
    match data[12] {
        0 => Ok(None),
        1 => {
            let bytes: [u8; 32] = data[13..45].try_into().map_err(|_| GgError::NotUpgradeAuthority)?;
            Ok(Some(Pubkey::new_from_array(bytes)))
        }
        _ => err!(GgError::NotUpgradeAuthority),
    }
}

pub fn handle_initialize_config(ctx: Context<InitializeConfig>, p: InitializeConfigParams) -> Result<()> {
    require!(
        upgrade_authority(&ctx.accounts.program_data)? == Some(ctx.accounts.authority.key()),
        GgError::NotUpgradeAuthority
    );
    let mint = spl::load_mint(&ctx.accounts.usdc_mint).map_err(|_| error!(GgError::InvalidCollateralMint))?;
    require!(mint.decimals == TOKEN_DECIMALS, GgError::InvalidCollateralMint);
    let c = &mut ctx.accounts.config;
    c.admin = p.admin;
    c.treasury = p.treasury;
    c.usdc_mint = ctx.accounts.usdc_mint.key();
    c.protocol_fee_share_bps = p.protocol_fee_share_bps;
    c.max_fee_bps = p.max_fee_bps;
    c.min_liquidity = p.min_liquidity;
    c.min_duration_secs = p.min_duration_secs;
    c.max_duration_secs = p.max_duration_secs;
    c.max_staleness_secs = p.max_staleness_secs;
    c.max_conf_bps = p.max_conf_bps;
    c.trading_close_secs = p.trading_close_secs;
    c.paused = false;
    c.bump = ctx.bumps.config;
    validate_config(c)?;
    emit_config(c);
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ GgError::NotAdmin
    )]
    pub config: Account<'info, Config>,
}

pub fn handle_update_config(ctx: Context<UpdateConfig>, p: UpdateConfigParams) -> Result<()> {
    let c = &mut ctx.accounts.config;
    if let Some(v) = p.new_admin {
        c.admin = v;
    }
    if let Some(v) = p.treasury {
        c.treasury = v;
    }
    if let Some(v) = p.protocol_fee_share_bps {
        c.protocol_fee_share_bps = v;
    }
    if let Some(v) = p.max_fee_bps {
        c.max_fee_bps = v;
    }
    if let Some(v) = p.min_liquidity {
        c.min_liquidity = v;
    }
    if let Some(v) = p.min_duration_secs {
        c.min_duration_secs = v;
    }
    if let Some(v) = p.max_duration_secs {
        c.max_duration_secs = v;
    }
    if let Some(v) = p.max_staleness_secs {
        c.max_staleness_secs = v;
    }
    if let Some(v) = p.max_conf_bps {
        c.max_conf_bps = v;
    }
    if let Some(v) = p.trading_close_secs {
        c.trading_close_secs = v;
    }
    if let Some(v) = p.paused {
        c.paused = v;
    }
    validate_config(c)?;
    emit_config(c);
    Ok(())
}

#[derive(Accounts)]
#[instruction(feed_id: [u8; 32])]
pub struct AllowFeed<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ GgError::NotAdmin
    )]
    pub config: Account<'info, Config>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + FeedAllowlist::INIT_SPACE,
        seeds = [FEED_SEED, feed_id.as_ref()],
        bump
    )]
    pub feed: Account<'info, FeedAllowlist>,
    pub system_program: Program<'info, System>,
}

pub fn handle_allow_feed(ctx: Context<AllowFeed>, feed_id: [u8; 32], symbol: String, expo: i32) -> Result<()> {
    require!(!symbol.is_empty() && symbol.len() <= MAX_SYMBOL_LEN, GgError::InvalidSymbol);
    require!((-18..=0).contains(&expo), GgError::InvalidTarget);
    let f = &mut ctx.accounts.feed;
    f.feed_id = feed_id;
    f.symbol = symbol;
    f.expo = expo;
    f.enabled = true;
    f.bump = ctx.bumps.feed;
    emit!(FeedUpdated { feed_id, expo, enabled: true });
    Ok(())
}

#[derive(Accounts)]
#[instruction(feed_id: [u8; 32])]
pub struct DisallowFeed<'info> {
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ GgError::NotAdmin
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [FEED_SEED, feed_id.as_ref()],
        bump = feed.bump
    )]
    pub feed: Account<'info, FeedAllowlist>,
}

pub fn handle_disallow_feed(ctx: Context<DisallowFeed>, feed_id: [u8; 32]) -> Result<()> {
    let f = &mut ctx.accounts.feed;
    f.enabled = false;
    emit!(FeedUpdated { feed_id, expo: f.expo, enabled: false });
    Ok(())
}
