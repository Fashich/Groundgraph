/**
 * Adapter between the services and `@groundgraph/sdk`.
 *
 * Services import SDK functionality ONLY from here. The normalizers (`normalizeMarket`, `normalizeConfig`,
 * `normalizeEvent`) accept both camelCase and snake_case field names and PublicKey/BN/bigint/number representations,
 * so small naming differences in the SDK decoders never leak into service code.
 */
import { PublicKey } from '@solana/web3.js';
import type { MarketAccount } from '@groundgraph/sdk';

// Services import SDK functionality ONLY from here, so a single place decides which SDK build they run against.
export {
  USDC_DECIMALS,
  MIN_TRADE_USDC,
  PROGRAM_ID,
  PYTH_RECEIVER_PROGRAM_ID,
  PYTH_FEEDS,
  parseAssetFeed,
  buildQuestion,
  priceBps,
  priceAbove,
  feeBpsNow,
  updateEma,
  quoteBuy,
  quoteSell,
  seedReserves,
  applySlippage,
  fairValueClose,
  fairValueTouch,
  expectedArbLossUsdc,
  radarProbability,
  impliedProbability,
  pda,
  decodeMarket,
  decodeConfig,
  decodeFeed,
  effectiveStatus,
  parseEventsFromLogs,
  buildBuyIx,
  buildSellIx,
  buildMergeIx,
  buildRedeemIx,
  buildCreateMarketIx,
  buildSettleCloseIx,
  buildVoidMarketIx,
  toUnsignedV0Tx,
} from '@groundgraph/sdk';
export type { Side, Pool, FeeState, MarketAccount, ConfigAccount, FeedAccount, GgEvent } from '@groundgraph/sdk';
import { PYTH_FEEDS } from '@groundgraph/sdk';

/** Kept for API compatibility: the services no longer ship an SDK test double. */
export const doubleExports = new Set<string>();
export function assertRealSdk(_env = process.env.NODE_ENV): void {
  /* the real SDK is always used */
}

/* ------------------------------ tolerant value readers ------------------------------ */

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Read the first defined key among the given names, trying camelCase and snake_case spellings. */
export function field(o: unknown, ...names: string[]): unknown {
  if (o === null || typeof o !== 'object') return undefined;
  const rec = o as Record<string, unknown>;
  for (const n of names) {
    for (const k of [n, camel(n), n.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)]) {
      if (rec[k] !== undefined) return rec[k];
    }
  }
  return undefined;
}

export function toBig(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  if (typeof v === 'string') return v === '' ? 0n : BigInt(v);
  if (v && typeof (v as { toString?: unknown }).toString === 'function') return BigInt((v as { toString(b?: number): string }).toString(10));
  return 0n;
}
export const toNum = (v: unknown): number => Number(toBig(v));
export const toBool = (v: unknown): boolean => v === true || v === 1 || v === 'true';

export function toPk(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof (v as { toBase58?: unknown }).toBase58 === 'function') return (v as PublicKey).toBase58();
  throw new TypeError('expected a public key');
}

export function toHex(v: unknown): string {
  if (typeof v === 'string') return v.replace(/^0x/, '').toLowerCase();
  const bytes = v instanceof Uint8Array ? v : Array.isArray(v) ? Uint8Array.from(v as number[]) : new Uint8Array();
  return Buffer.from(bytes).toString('hex');
}

/** Enum value in any common representation ('Close', 'close', {close:{}}, 0) to a lowercase name. */
export function enumName(v: unknown, order: readonly string[]): string {
  if (typeof v === 'number') return order[v] ?? 'unknown';
  if (typeof v === 'string') return v.toLowerCase();
  if (v && typeof v === 'object') return (Object.keys(v as object)[0] ?? 'unknown').toLowerCase();
  return 'unknown';
}

/* ------------------------------ normalized chain types ------------------------------ */

export interface ChainMarket {
  id: string;
  creator: string;
  nonce: bigint;
  collateralMint: string;
  vault: string;
  aboveMint: string;
  belowMint: string;
  lpMint: string;
  kind: 'close' | 'touch';
  direction: 'up' | 'down' | null;
  feedIdHex: string;
  targetPrice: bigint;
  targetExpo: number;
  openTs: number;
  tradingEndTs: number;
  settleTs: number;
  baseFeeBps: number;
  dynamicFee: boolean;
  completeSets: bigint;
  reserveAbove: bigint;
  reserveBelow: bigint;
  feePool: bigint;
  emaImpactBps: number;
  emaTs: number;
  status: 'open' | 'settled' | 'voided';
  outcome: 'above' | 'below' | null;
  settlePrice: bigint;
  settleExpo: number;
  settlePublishTs: number;
  lpClaimRemaining: bigint;
  lpSupplyRemaining: bigint;
  /** the SDK's own decoded account, passed back to instruction builders untouched */
  raw: MarketAccount;
}

export function normalizeMarket(raw: unknown, id: string): ChainMarket {
  const dirRaw = enumName(field(raw, 'direction'), ['none', 'up', 'down']);
  const outRaw = enumName(field(raw, 'outcome'), ['none', 'above', 'below']);
  const kind = enumName(field(raw, 'kind'), ['close', 'touch']) === 'touch' ? 'touch' : 'close';
  const status = enumName(field(raw, 'status'), ['open', 'settled', 'voided']);
  return {
    id,
    creator: toPk(field(raw, 'creator')),
    nonce: toBig(field(raw, 'nonce')),
    collateralMint: toPk(field(raw, 'collateralMint')),
    vault: toPk(field(raw, 'vault')),
    aboveMint: toPk(field(raw, 'aboveMint')),
    belowMint: toPk(field(raw, 'belowMint')),
    lpMint: toPk(field(raw, 'lpMint')),
    kind,
    direction: dirRaw === 'up' || dirRaw === 'down' ? dirRaw : null,
    feedIdHex: toHex(field(raw, 'feedId')),
    targetPrice: toBig(field(raw, 'targetPrice')),
    targetExpo: toNum(field(raw, 'targetExpo')),
    openTs: toNum(field(raw, 'openTs')),
    tradingEndTs: toNum(field(raw, 'tradingEndTs')),
    settleTs: toNum(field(raw, 'settleTs')),
    baseFeeBps: toNum(field(raw, 'baseFeeBps')),
    dynamicFee: toBool(field(raw, 'dynamicFee')),
    completeSets: toBig(field(raw, 'completeSets')),
    reserveAbove: toBig(field(raw, 'reserveAbove')),
    reserveBelow: toBig(field(raw, 'reserveBelow')),
    feePool: toBig(field(raw, 'feePool')),
    emaImpactBps: toNum(field(raw, 'emaImpactBps')),
    emaTs: toNum(field(raw, 'emaTs')),
    status: status === 'settled' ? 'settled' : status === 'voided' ? 'voided' : 'open',
    outcome: outRaw === 'above' || outRaw === 'below' ? outRaw : null,
    settlePrice: toBig(field(raw, 'settlePrice')),
    settleExpo: toNum(field(raw, 'settleExpo')),
    settlePublishTs: toNum(field(raw, 'settlePublishTs')),
    lpClaimRemaining: toBig(field(raw, 'lpClaimRemaining')),
    lpSupplyRemaining: toBig(field(raw, 'lpSupplyRemaining')),
    raw: raw as MarketAccount,
  };
}

export interface ChainConfig {
  admin: string;
  usdcMint: string;
  maxFeeBps: number;
  minLiquidity: bigint;
  minDurationSecs: number;
  maxDurationSecs: number;
  maxStalenessSecs: number;
  maxConfBps: number;
  tradingCloseSecs: number;
  paused: boolean;
}

export function normalizeConfig(raw: unknown): ChainConfig {
  return {
    admin: toPk(field(raw, 'admin')),
    usdcMint: toPk(field(raw, 'usdcMint')),
    maxFeeBps: toNum(field(raw, 'maxFeeBps')) || 300,
    minLiquidity: toBig(field(raw, 'minLiquidity')),
    minDurationSecs: toNum(field(raw, 'minDurationSecs')),
    maxDurationSecs: toNum(field(raw, 'maxDurationSecs')),
    maxStalenessSecs: toNum(field(raw, 'maxStalenessSecs')) || 60,
    maxConfBps: toNum(field(raw, 'maxConfBps')) || 50,
    tradingCloseSecs: field(raw, 'tradingCloseSecs') === undefined ? 3600 : toNum(field(raw, 'tradingCloseSecs')),
    paused: toBool(field(raw, 'paused')),
  };
}

export type NormEvent =
  | {
      name: 'MarketCreated';
      market: string; creator: string; feedIdHex: string; targetPrice: bigint; targetExpo: number; kind: 'close' | 'touch';
      settleTs: number; tradingEndTs: number; baseFeeBps: number; dynamicFee: boolean; liquidity: bigint; p0Bps: number;
      aboveMint: string; belowMint: string; lpMint: string; vault: string;
    }
  | {
      name: 'Trade';
      market: string; wallet: string; side: 'above' | 'below'; isBuy: boolean; usdc: bigint; shares: bigint; feeUsdc: bigint; feeBps: number;
      priceAfterBps: number; reserveAbove: bigint; reserveBelow: bigint; ts: number;
    }
  | { name: 'Settled'; market: string; outcome: 'above' | 'below'; price: bigint; expo: number; publishTs: number; lpClaim: bigint }
  | { name: 'Voided'; market: string; lpClaim: bigint }
  | { name: 'Redeemed'; market: string; wallet: string; side: 'above' | 'below'; shares: bigint; usdc: bigint }
  | { name: 'Merged'; market: string; wallet: string; amount: bigint }
  | { name: 'LiquidityChanged'; market: string; wallet: string; lpAmount: bigint; usdc: bigint; isAdd: boolean };

const sideOf = (v: unknown): 'above' | 'below' => (enumName(v, ['above', 'below']) === 'below' ? 'below' : 'above');

/** Normalize an SDK `GgEvent`; returns null for events the services do not track (ConfigUpdated, FeedUpdated, ...). */
export function normalizeEvent(ev: { name: string; data: unknown }): NormEvent | null {
  const d = ev.data;
  const name = ev.name.charAt(0).toUpperCase() + ev.name.slice(1);
  switch (name) {
    case 'MarketCreated':
      return {
        name,
        market: toPk(field(d, 'market')), creator: toPk(field(d, 'creator')), feedIdHex: toHex(field(d, 'feedId')),
        targetPrice: toBig(field(d, 'targetPrice')), targetExpo: toNum(field(d, 'targetExpo')),
        kind: enumName(field(d, 'kind'), ['close', 'touch']) === 'touch' ? 'touch' : 'close',
        settleTs: toNum(field(d, 'settleTs')), tradingEndTs: toNum(field(d, 'tradingEndTs')),
        baseFeeBps: toNum(field(d, 'baseFeeBps')), dynamicFee: toBool(field(d, 'dynamicFee')),
        liquidity: toBig(field(d, 'liquidity')), p0Bps: toNum(field(d, 'p0Bps')),
        aboveMint: toPk(field(d, 'aboveMint')), belowMint: toPk(field(d, 'belowMint')), lpMint: toPk(field(d, 'lpMint')), vault: toPk(field(d, 'vault')),
      };
    case 'Trade':
      return {
        name,
        market: toPk(field(d, 'market')), wallet: toPk(field(d, 'wallet')), side: sideOf(field(d, 'side')), isBuy: toBool(field(d, 'isBuy')),
        usdc: toBig(field(d, 'usdc')), shares: toBig(field(d, 'shares')), feeUsdc: toBig(field(d, 'feeUsdc')), feeBps: toNum(field(d, 'feeBps')),
        priceAfterBps: toNum(field(d, 'priceAfterBps')), reserveAbove: toBig(field(d, 'reserveAbove')), reserveBelow: toBig(field(d, 'reserveBelow')),
        ts: toNum(field(d, 'ts')),
      };
    case 'Settled':
      return {
        name,
        market: toPk(field(d, 'market')), outcome: sideOf(field(d, 'outcome')), price: toBig(field(d, 'price')), expo: toNum(field(d, 'expo')),
        publishTs: toNum(field(d, 'publishTs')), lpClaim: toBig(field(d, 'lpClaim')),
      };
    case 'Voided':
      return { name, market: toPk(field(d, 'market')), lpClaim: toBig(field(d, 'lpClaim')) };
    case 'Redeemed':
      return {
        name,
        market: toPk(field(d, 'market')), wallet: toPk(field(d, 'wallet')), side: sideOf(field(d, 'side')), shares: toBig(field(d, 'shares')),
        usdc: toBig(field(d, 'usdc')),
      };
    case 'Merged':
      return { name, market: toPk(field(d, 'market')), wallet: toPk(field(d, 'wallet')), amount: toBig(field(d, 'amount')) };
    case 'LiquidityChanged':
      return {
        name,
        market: toPk(field(d, 'market')), wallet: toPk(field(d, 'wallet')), lpAmount: toBig(field(d, 'lpAmount')), usdc: toBig(field(d, 'usdc')),
        isAdd: toBool(field(d, 'isAdd')),
      };
    default:
      return null;
  }
}

/* ------------------------------ asset helpers ------------------------------ */

export interface AssetFeed {
  symbol: string; // "SOL"
  pair: string; // "SOL/USD"
  feedIdHex: string;
}

/** Allow-listed feeds known to the SDK (the on-chain allowlist is bootstrapped from the same list). */
export function listAssetFeeds(): AssetFeed[] {
  return Object.entries(PYTH_FEEDS).map(([symbol, f]) => ({ symbol, pair: f.symbol, feedIdHex: f.feedIdHex.replace(/^0x/, '').toLowerCase() }));
}

export function assetByFeedId(feedIdHex: string): AssetFeed | undefined {
  const id = feedIdHex.replace(/^0x/, '').toLowerCase();
  return listAssetFeeds().find((a) => a.feedIdHex === id);
}

export function assetBySymbol(symbol: string): AssetFeed | undefined {
  const s = symbol.toUpperCase().replace(/\/USD$/, '');
  return listAssetFeeds().find((a) => a.symbol === s);
}

/** Display category used by the market filters: majors vs the Solana ecosystem. */
export function categoryFor(assetSymbol: string): string {
  return ['BTC', 'ETH', 'SOL'].includes(assetSymbol.toUpperCase()) ? 'Majors' : 'Solana ecosystem';
}
