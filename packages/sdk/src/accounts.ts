import type { PublicKey } from '@solana/web3.js';
import { bytesEqual, concatBytes, decodeDefined, encodeDefined } from './codec';
import { accountDiscriminator } from './idl';
import type { Pool, FeeState } from './math';

export type MarketKindName = 'close' | 'touch';
export type DirectionName = 'none' | 'up' | 'down';
export type MarketStatusName = 'open' | 'settled' | 'voided';
export type OutcomeName = 'none' | 'above' | 'below';

/** On-chain `Market` account. u64/i64 fields (amounts, timestamps, prices) are `bigint`. */
export interface MarketAccount {
  creator: PublicKey;
  nonce: bigint;
  collateralMint: PublicKey;
  vault: PublicKey;
  aboveMint: PublicKey;
  belowMint: PublicKey;
  lpMint: PublicKey;
  kind: MarketKindName;
  direction: DirectionName;
  feedId: Uint8Array;
  targetPrice: bigint;
  targetExpo: number;
  openTs: bigint;
  tradingEndTs: bigint;
  settleTs: bigint;
  baseFeeBps: number;
  dynamicFee: boolean;
  completeSets: bigint;
  reserveAbove: bigint;
  reserveBelow: bigint;
  feePool: bigint;
  emaImpactBps: number;
  emaTs: bigint;
  status: MarketStatusName;
  outcome: OutcomeName;
  settlePrice: bigint;
  settleExpo: number;
  settlePublishTs: bigint;
  lpClaimRemaining: bigint;
  lpSupplyRemaining: bigint;
  bump: number;
}

/** On-chain `Config` account. */
export interface ConfigAccount {
  admin: PublicKey;
  treasury: PublicKey;
  usdcMint: PublicKey;
  protocolFeeShareBps: number;
  maxFeeBps: number;
  minLiquidity: bigint;
  minDurationSecs: bigint;
  maxDurationSecs: bigint;
  maxStalenessSecs: number;
  maxConfBps: number;
  tradingCloseSecs: number;
  paused: boolean;
  bump: number;
}

/** On-chain `FeedAllowlist` account. */
export interface FeedAccount {
  feedId: Uint8Array;
  symbol: string;
  expo: number;
  enabled: boolean;
  bump: number;
}

function decodeAccount<T>(name: string, data: Uint8Array): T {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const disc = accountDiscriminator(name);
  if (bytes.length < 8 || !bytesEqual(bytes.subarray(0, 8), disc)) throw new Error(`not a ${name} account (discriminator mismatch)`);
  return decodeDefined<T>(name, bytes.subarray(8));
}

function encodeAccount(name: string, value: unknown): Uint8Array {
  return concatBytes(accountDiscriminator(name), encodeDefined(name, value));
}

export const decodeMarket = (data: Buffer | Uint8Array): MarketAccount => decodeAccount<MarketAccount>('Market', data);
export const decodeConfig = (data: Buffer | Uint8Array): ConfigAccount => decodeAccount<ConfigAccount>('Config', data);
export const decodeFeed = (data: Buffer | Uint8Array): FeedAccount => decodeAccount<FeedAccount>('FeedAllowlist', data);

/** Serialize accounts in the on-chain layout (test fixtures, local simulation). */
export const encodeMarket = (m: MarketAccount): Buffer => Buffer.from(encodeAccount('Market', m));
export const encodeConfig = (c: ConfigAccount): Buffer => Buffer.from(encodeAccount('Config', c));
export const encodeFeed = (f: FeedAccount): Buffer => Buffer.from(encodeAccount('FeedAllowlist', f));

/**
 * Market lifecycle as shown to users. `TradingClosed` is derived from the clock (`now >= tradingEndTs` while the
 * on-chain status is still `open`); there is no such stored status.
 */
export function effectiveStatus(
  m: Pick<MarketAccount, 'status' | 'tradingEndTs'>,
  nowTs: number,
): 'open' | 'trading_closed' | 'settled' | 'voided' {
  if (m.status === 'settled') return 'settled';
  if (m.status === 'voided') return 'voided';
  return BigInt(nowTs) >= m.tradingEndTs ? 'trading_closed' : 'open';
}

/** Pool view of a market. */
export function marketPool(m: Pick<MarketAccount, 'reserveAbove' | 'reserveBelow'>): Pool {
  return { reserveAbove: m.reserveAbove, reserveBelow: m.reserveBelow };
}

/** Fee inputs of a market plus the config cap. */
export function marketFeeState(m: MarketAccount, maxFeeBps: number): FeeState {
  return {
    baseFeeBps: m.baseFeeBps,
    dynamicFee: m.dynamicFee,
    emaImpactBps: m.emaImpactBps,
    emaTs: Number(m.emaTs),
    settleTs: Number(m.settleTs),
    maxFeeBps,
  };
}
