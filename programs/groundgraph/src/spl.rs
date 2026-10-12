//! Minimal SPL Token / Associated Token Account client.
//!
//! The program only needs six token instructions and two account layouts, so they are encoded by hand instead of
//! pulling in `anchor-spl` (which drags the whole Token-2022 interface tree into the binary and the link step).
//! Every function here is exercised end to end against the real SPL Token program in the LiteSVM tests.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

use crate::errors::GgError;

pub const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const ATA_PROGRAM_ID: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

pub const TOKEN_ACCOUNT_LEN: usize = 165;
pub const MINT_LEN: usize = 82;

const IX_TRANSFER: u8 = 3;
const IX_MINT_TO: u8 = 7;
const IX_BURN: u8 = 8;
const IX_INITIALIZE_ACCOUNT3: u8 = 18;
const IX_INITIALIZE_MINT2: u8 = 20;

/// Marker type so `Program<'info, Token>` verifies the classic SPL Token program id.
#[derive(Clone)]
pub struct Token;

impl Id for Token {
    fn id() -> Pubkey {
        TOKEN_PROGRAM_ID
    }
}

/// Marker type for the Associated Token Account program.
#[derive(Clone)]
pub struct AssociatedToken;

impl Id for AssociatedToken {
    fn id() -> Pubkey {
        ATA_PROGRAM_ID
    }
}

/// The fields of an SPL token account that this program inspects.
#[derive(Clone, Copy, Debug)]
pub struct TokenAcct {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}

/// Read an initialized token account owned by the classic Token program.
pub fn load_token_account(ai: &AccountInfo) -> Result<TokenAcct> {
    require!(ai.owner == &TOKEN_PROGRAM_ID, GgError::WrongTokenAccount);
    let data = ai.try_borrow_data()?;
    require!(data.len() == TOKEN_ACCOUNT_LEN, GgError::WrongTokenAccount);
    // state byte: 0 = uninitialized, 1 = initialized, 2 = frozen
    require!(data[108] != 0, GgError::WrongTokenAccount);
    Ok(TokenAcct {
        mint: Pubkey::new_from_array(data[0..32].try_into().map_err(|_| GgError::WrongTokenAccount)?),
        owner: Pubkey::new_from_array(data[32..64].try_into().map_err(|_| GgError::WrongTokenAccount)?),
        amount: u64::from_le_bytes(data[64..72].try_into().map_err(|_| GgError::WrongTokenAccount)?),
    })
}

/// Token account that must belong to `owner` and hold `mint`.
pub fn load_owned_token_account(ai: &AccountInfo, mint: &Pubkey, owner: &Pubkey) -> Result<TokenAcct> {
    let t = load_token_account(ai)?;
    require!(&t.mint == mint && &t.owner == owner, GgError::WrongTokenAccount);
    Ok(t)
}

#[derive(Clone, Copy, Debug)]
pub struct MintAcct {
    pub supply: u64,
    pub decimals: u8,
}

/// Read an initialized mint owned by the classic Token program.
pub fn load_mint(ai: &AccountInfo) -> Result<MintAcct> {
    require!(ai.owner == &TOKEN_PROGRAM_ID, GgError::WrongMint);
    let data = ai.try_borrow_data()?;
    require!(data.len() == MINT_LEN && data[45] == 1, GgError::WrongMint);
    Ok(MintAcct {
        supply: u64::from_le_bytes(data[36..44].try_into().map_err(|_| GgError::WrongMint)?),
        decimals: data[44],
    })
}

fn amount_data(tag: u8, amount: u64) -> Vec<u8> {
    let mut d = Vec::with_capacity(9);
    d.push(tag);
    d.extend_from_slice(&amount.to_le_bytes());
    d
}

fn call<'info>(ix: Instruction, infos: &[AccountInfo<'info>], signer: &[&[&[u8]]]) -> Result<()> {
    invoke_signed(&ix, infos, signer).map_err(Into::into)
}

pub fn transfer<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    signer: &[&[&[u8]]],
) -> Result<()> {
    let ix = Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*from.key, false),
            AccountMeta::new(*to.key, false),
            AccountMeta::new_readonly(*authority.key, true),
        ],
        data: amount_data(IX_TRANSFER, amount),
    };
    call(ix, &[from.clone(), to.clone(), authority.clone()], signer)
}

pub fn mint_to<'info>(
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    signer: &[&[&[u8]]],
) -> Result<()> {
    let ix = Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*mint.key, false),
            AccountMeta::new(*to.key, false),
            AccountMeta::new_readonly(*authority.key, true),
        ],
        data: amount_data(IX_MINT_TO, amount),
    };
    call(ix, &[mint.clone(), to.clone(), authority.clone()], signer)
}

pub fn burn<'info>(
    account: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    signer: &[&[&[u8]]],
) -> Result<()> {
    let ix = Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*account.key, false),
            AccountMeta::new(*mint.key, false),
            AccountMeta::new_readonly(*authority.key, true),
        ],
        data: amount_data(IX_BURN, amount),
    };
    call(ix, &[account.clone(), mint.clone(), authority.clone()], signer)
}

/// InitializeMint2: no freeze authority, no rent sysvar account needed.
pub fn initialize_mint2<'info>(mint: &AccountInfo<'info>, decimals: u8, authority: &Pubkey) -> Result<()> {
    let mut data = Vec::with_capacity(35);
    data.push(IX_INITIALIZE_MINT2);
    data.push(decimals);
    data.extend_from_slice(authority.as_ref());
    data.push(0); // COption::None freeze authority
    let ix = Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![AccountMeta::new(*mint.key, false)],
        data,
    };
    call(ix, &[mint.clone()], &[])
}

/// InitializeAccount3: owner passed in data, no rent sysvar account needed.
pub fn initialize_account3<'info>(account: &AccountInfo<'info>, mint: &AccountInfo<'info>, owner: &Pubkey) -> Result<()> {
    let mut data = Vec::with_capacity(33);
    data.push(IX_INITIALIZE_ACCOUNT3);
    data.extend_from_slice(owner.as_ref());
    let ix = Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![AccountMeta::new(*account.key, false), AccountMeta::new_readonly(*mint.key, false)],
        data,
    };
    call(ix, &[account.clone(), mint.clone()], &[])
}

/// Associated Token Account `CreateIdempotent`. The ATA program verifies the address derivation and, if the account
/// already exists, that it is a token account for the right wallet and mint.
pub fn create_ata_idempotent<'info>(
    payer: &AccountInfo<'info>,
    ata: &AccountInfo<'info>,
    wallet: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
) -> Result<()> {
    let ix = Instruction {
        program_id: ATA_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*payer.key, true),
            AccountMeta::new(*ata.key, false),
            AccountMeta::new_readonly(*wallet.key, false),
            AccountMeta::new_readonly(*mint.key, false),
            AccountMeta::new_readonly(*system_program.key, false),
            AccountMeta::new_readonly(*token_program.key, false),
        ],
        data: vec![1],
    };
    call(
        ix,
        &[payer.clone(), ata.clone(), wallet.clone(), mint.clone(), system_program.clone(), token_program.clone()],
        &[],
    )
}
