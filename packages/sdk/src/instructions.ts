/**
 * Instruction builders. Account lists are generated from the IDL (order, signer and writable flags, fixed program
 * addresses), so they cannot drift from the program. High-level builders add idempotent associated token account
 * creation for the accounts an instruction writes into.
 */
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import type { Side } from './api-types';
import type { MarketAccount } from './accounts';
import { camel, concatBytes, encodeArgs } from './codec';
import { ASSOCIATED_TOKEN_PROGRAM_ID, PROGRAM_ID, TOKEN_PROGRAM_ID } from './constants';
import { IDL, idlInstruction } from './idl';
import { pda } from './pda';

export const ata = (mint: PublicKey, owner: PublicKey): PublicKey => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

const createAtaIx = (payer: PublicKey, mint: PublicKey, owner: PublicKey): TransactionInstruction =>
  createAssociatedTokenAccountIdempotentInstruction(payer, ata(mint, owner), owner, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

/** Account addresses keyed by the camelCase IDL account name (`userUsdc`, `outcomeMint`, ...). */
export type AccountMap = Record<string, PublicKey | undefined>;

/**
 * Low-level builder: data = IDL discriminator + borsh args; accounts ordered and flagged exactly as in the IDL.
 * Accounts with a fixed `address` in the IDL (token/system/associated token programs) are filled in automatically.
 */
export function buildInstruction(
  name: string,
  args: Record<string, unknown>,
  accounts: AccountMap,
  programId: PublicKey = PROGRAM_ID,
): TransactionInstruction {
  const def = idlInstruction(name);
  const keys = def.accounts.map((a) => {
    const key = camel(a.name);
    const pubkey = accounts[key] ?? (a.address ? new PublicKey(a.address) : undefined);
    if (!pubkey) throw new Error(`${name}: missing account ${key}`);
    if (a.address && !pubkey.equals(new PublicKey(a.address))) throw new Error(`${name}: account ${key} must be ${a.address}`);
    return { pubkey, isSigner: !!a.signer, isWritable: !!a.writable };
  });
  const data = concatBytes(Uint8Array.from(def.discriminator), encodeArgs(def.args, args));
  return new TransactionInstruction({ programId, keys, data: Buffer.from(data) });
}

const sideName = (s: Side): 'above' | 'below' => {
  if (s !== 'above' && s !== 'below') throw new TypeError("side must be 'above' or 'below'");
  return s;
};
const outcomeMintOf = (m: MarketAccount, s: Side): PublicKey => (sideName(s) === 'above' ? m.aboveMint : m.belowMint);

/** The accounts of `buy`, `sell`, `merge`, `redeem`, `remove_liquidity` that depend only on (market, user). */
export function userAccounts(m: MarketAccount, user: PublicKey) {
  return {
    userUsdc: ata(m.collateralMint, user),
    userAbove: ata(m.aboveMint, user),
    userBelow: ata(m.belowMint, user),
    userLp: ata(m.lpMint, user),
  };
}

export interface TradeArgs {
  market: MarketAccount;
  marketPk: PublicKey;
  user: PublicKey;
}

export function buildBuyIx(a: TradeArgs & { side: Side; usdcIn: bigint; minSharesOut: bigint }): TransactionInstruction[] {
  const outcomeMint = outcomeMintOf(a.market, a.side);
  const userOutcome = ata(outcomeMint, a.user);
  return [
    createAtaIx(a.user, outcomeMint, a.user),
    buildInstruction(
      'buy',
      { side: sideName(a.side), usdcIn: a.usdcIn, minSharesOut: a.minSharesOut },
      {
        user: a.user,
        config: pda.config(),
        market: a.marketPk,
        vault: a.market.vault,
        outcomeMint,
        userUsdc: ata(a.market.collateralMint, a.user),
        userOutcome,
      },
    ),
  ];
}

export function buildSellIx(a: TradeArgs & { side: Side; sharesIn: bigint; minUsdcOut: bigint }): TransactionInstruction[] {
  const outcomeMint = outcomeMintOf(a.market, a.side);
  return [
    createAtaIx(a.user, a.market.collateralMint, a.user),
    buildInstruction(
      'sell',
      { side: sideName(a.side), sharesIn: a.sharesIn, minUsdcOut: a.minUsdcOut },
      {
        user: a.user,
        config: pda.config(),
        market: a.marketPk,
        vault: a.market.vault,
        outcomeMint,
        userOutcome: ata(outcomeMint, a.user),
        userUsdc: ata(a.market.collateralMint, a.user),
      },
    ),
  ];
}

export function buildMergeIx(a: TradeArgs & { amount: bigint }): TransactionInstruction[] {
  const u = userAccounts(a.market, a.user);
  return [
    createAtaIx(a.user, a.market.collateralMint, a.user),
    buildInstruction(
      'merge',
      { amount: a.amount },
      {
        user: a.user,
        market: a.marketPk,
        vault: a.market.vault,
        aboveMint: a.market.aboveMint,
        belowMint: a.market.belowMint,
        userAbove: u.userAbove,
        userBelow: u.userBelow,
        userUsdc: u.userUsdc,
      },
    ),
  ];
}

export function buildRedeemIx(a: TradeArgs & { side: Side; amount: bigint }): TransactionInstruction[] {
  const outcomeMint = outcomeMintOf(a.market, a.side);
  return [
    createAtaIx(a.user, a.market.collateralMint, a.user),
    buildInstruction(
      'redeem',
      { side: sideName(a.side), amount: a.amount },
      {
        user: a.user,
        market: a.marketPk,
        vault: a.market.vault,
        outcomeMint,
        userOutcome: ata(outcomeMint, a.user),
        userUsdc: ata(a.market.collateralMint, a.user),
      },
    ),
  ];
}

export function buildRemoveLiquidityIx(a: TradeArgs & { lpAmount: bigint }): TransactionInstruction[] {
  return [
    createAtaIx(a.user, a.market.collateralMint, a.user),
    buildInstruction(
      'remove_liquidity',
      { lpAmount: a.lpAmount },
      {
        user: a.user,
        market: a.marketPk,
        vault: a.market.vault,
        lpMint: a.market.lpMint,
        userLp: ata(a.market.lpMint, a.user),
        userUsdc: ata(a.market.collateralMint, a.user),
      },
    ),
  ];
}

export interface CreateMarketArgs {
  creator: PublicKey;
  nonce: bigint;
  feedId: Uint8Array;
  kind: 'close';
  targetPrice: bigint;
  targetExpo: number;
  settleTs: number;
  baseFeeBps: 50 | 100 | 200;
  dynamicFee: boolean;
  liquidity: bigint;
  /** Opening ABOVE price in basis points (200..9800). */
  p0Bps: number;
  usdcMint: PublicKey;
}

/** `create_market` (Close markets only in this version). The program creates the creator's token accounts itself. */
export function buildCreateMarketIx(a: CreateMarketArgs): { instructions: TransactionInstruction[]; market: PublicKey; accounts: { vault: PublicKey; aboveMint: PublicKey; belowMint: PublicKey; lpMint: PublicKey } } {
  const market = pda.market(a.creator, a.nonce);
  const vault = pda.vault(market);
  const aboveMint = pda.aboveMint(market);
  const belowMint = pda.belowMint(market);
  const lpMint = pda.lpMint(market);
  const ix = buildInstruction(
    'create_market',
    {
      params: {
        nonce: a.nonce,
        feedId: a.feedId,
        kind: a.kind,
        direction: 'none',
        targetPrice: a.targetPrice,
        targetExpo: a.targetExpo,
        settleTs: BigInt(a.settleTs),
        baseFeeBps: a.baseFeeBps,
        dynamicFee: a.dynamicFee,
        liquidity: a.liquidity,
        p0Bps: a.p0Bps,
      },
    },
    {
      creator: a.creator,
      config: pda.config(),
      feed: pda.feed(a.feedId),
      collateralMint: a.usdcMint,
      market,
      vault,
      aboveMint,
      belowMint,
      lpMint,
      creatorUsdc: ata(a.usdcMint, a.creator),
      creatorAbove: ata(aboveMint, a.creator),
      creatorBelow: ata(belowMint, a.creator),
      creatorLp: ata(lpMint, a.creator),
    },
  );
  return { instructions: [ix], market, accounts: { vault, aboveMint, belowMint, lpMint } };
}

export function buildSettleCloseIx(a: { marketPk: PublicKey; market: Pick<MarketAccount, 'lpMint'>; priceUpdate: PublicKey; payer: PublicKey }): TransactionInstruction {
  return buildInstruction('settle_close', {}, { payer: a.payer, config: pda.config(), market: a.marketPk, lpMint: a.market.lpMint, priceUpdate: a.priceUpdate });
}

export function buildVoidMarketIx(a: { marketPk: PublicKey; market: Pick<MarketAccount, 'lpMint'>; payer: PublicKey }): TransactionInstruction {
  return buildInstruction('void_market', {}, { caller: a.payer, market: a.marketPk, lpMint: a.market.lpMint });
}

/** Defaults mirror programs/groundgraph/src/constants.rs. */
export const DEFAULT_CONFIG_PARAMS = {
  protocolFeeShareBps: 0,
  maxFeeBps: 300,
  minLiquidity: 100_000_000n,
  minDurationSecs: 24n * 3_600n,
  maxDurationSecs: 180n * 24n * 3_600n,
  maxStalenessSecs: 60,
  maxConfBps: 50,
  tradingCloseSecs: 3_600,
} as const;

export interface InitializeConfigArgs {
  /** Must be the program's upgrade authority. */
  authority: PublicKey;
  usdcMint: PublicKey;
  admin?: PublicKey;
  treasury?: PublicKey;
  protocolFeeShareBps?: number;
  maxFeeBps?: number;
  minLiquidity?: bigint;
  minDurationSecs?: bigint;
  maxDurationSecs?: bigint;
  maxStalenessSecs?: number;
  maxConfBps?: number;
  tradingCloseSecs?: number;
}

export function buildInitializeConfigIx(a: InitializeConfigArgs): TransactionInstruction {
  const params = {
    admin: a.admin ?? a.authority,
    treasury: a.treasury ?? a.authority,
    protocolFeeShareBps: a.protocolFeeShareBps ?? DEFAULT_CONFIG_PARAMS.protocolFeeShareBps,
    maxFeeBps: a.maxFeeBps ?? DEFAULT_CONFIG_PARAMS.maxFeeBps,
    minLiquidity: a.minLiquidity ?? DEFAULT_CONFIG_PARAMS.minLiquidity,
    minDurationSecs: a.minDurationSecs ?? DEFAULT_CONFIG_PARAMS.minDurationSecs,
    maxDurationSecs: a.maxDurationSecs ?? DEFAULT_CONFIG_PARAMS.maxDurationSecs,
    maxStalenessSecs: a.maxStalenessSecs ?? DEFAULT_CONFIG_PARAMS.maxStalenessSecs,
    maxConfBps: a.maxConfBps ?? DEFAULT_CONFIG_PARAMS.maxConfBps,
    tradingCloseSecs: a.tradingCloseSecs ?? DEFAULT_CONFIG_PARAMS.tradingCloseSecs,
  };
  return buildInstruction('initialize_config', { params }, { authority: a.authority, config: pda.config(), usdcMint: a.usdcMint, programData: pda.programData() });
}

export type UpdateConfigParams = Partial<{
  newAdmin: PublicKey;
  treasury: PublicKey;
  protocolFeeShareBps: number;
  maxFeeBps: number;
  minLiquidity: bigint;
  minDurationSecs: bigint;
  maxDurationSecs: bigint;
  maxStalenessSecs: number;
  maxConfBps: number;
  tradingCloseSecs: number;
  paused: boolean;
}>;

export function buildUpdateConfigIx(a: { admin: PublicKey; params: UpdateConfigParams }): TransactionInstruction {
  const p = a.params;
  const params = {
    newAdmin: p.newAdmin ?? null,
    treasury: p.treasury ?? null,
    protocolFeeShareBps: p.protocolFeeShareBps ?? null,
    maxFeeBps: p.maxFeeBps ?? null,
    minLiquidity: p.minLiquidity ?? null,
    minDurationSecs: p.minDurationSecs ?? null,
    maxDurationSecs: p.maxDurationSecs ?? null,
    maxStalenessSecs: p.maxStalenessSecs ?? null,
    maxConfBps: p.maxConfBps ?? null,
    tradingCloseSecs: p.tradingCloseSecs ?? null,
    paused: p.paused ?? null,
  };
  return buildInstruction('update_config', { params }, { admin: a.admin, config: pda.config() });
}

export function buildAllowFeedIx(a: { admin: PublicKey; feedId: Uint8Array; symbol: string; expo: number }): TransactionInstruction {
  return buildInstruction('allow_feed', { feedId: a.feedId, symbol: a.symbol, expo: a.expo }, { admin: a.admin, config: pda.config(), feed: pda.feed(a.feedId) });
}

export function buildDisallowFeedIx(a: { admin: PublicKey; feedId: Uint8Array }): TransactionInstruction {
  return buildInstruction('disallow_feed', { feedId: a.feedId }, { admin: a.admin, config: pda.config(), feed: pda.feed(a.feedId) });
}

export const INSTRUCTION_NAMES: readonly string[] = IDL.instructions.map((i) => i.name);
