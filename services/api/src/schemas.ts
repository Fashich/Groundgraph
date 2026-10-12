/**
 * Zod schemas for every request/response of the route table in packages/sdk/src/api-types.ts.
 * Each response schema is annotated with the contract type, so a drift between this file and api-types.ts fails typecheck.
 */
import type * as T from '@groundgraph/sdk/api-types';
import { z } from 'zod';

export const U64 = z.string().regex(/^\d{1,20}$/, 'decimal string of base units');
/** signed base-unit amount (profit and loss can be negative) */
export const I64 = z.string().regex(/^-?\d{1,20}$/);
export const Iso = z.string();
export const Side = z.enum(['above', 'below']);
export const MarketStatus = z.enum(['open', 'trading_closed', 'settled', 'voided']);
const base58 = z.string().min(32).max(44);

export const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });

/* ------------------------------ markets ------------------------------ */

export const RadarSummarySchema: z.ZodType<T.RadarSummary> = z.object({
  state: z.enum(['ready', 'building']),
  p: z.number().nullable(),
  ci: z.number().nullable(),
  n: z.number(),
  edge: z.number().nullable(),
  modelVersion: z.string().nullable(),
  ts: Iso.nullable(),
});

export const OracleInfoSchema: z.ZodType<T.OracleInfo> = z.object({
  feedId: z.string(),
  symbol: z.string(),
  price: z.number().nullable(),
  conf: z.number().nullable(),
  publishTs: Iso.nullable(),
  ageSec: z.number().nullable(),
  stale: z.boolean(),
});

const marketSummaryShape = {
  id: z.string(),
  question: z.string(),
  kind: z.enum(['close', 'touch']),
  direction: z.enum(['up', 'down']).nullable(),
  assetSymbol: z.string(),
  category: z.string(),
  targetPrice: z.number(),
  status: MarketStatus,
  outcome: Side.nullable(),
  priceAbove: z.number(),
  implied: z.number(),
  ch24: z.number(),
  spark: z.array(z.number()),
  radar: RadarSummarySchema,
  feeBpsNow: z.number(),
  baseFeeBps: z.number(),
  dynamicFee: z.boolean(),
  endsAt: Iso,
  tradingEndsAt: Iso,
  volume: U64,
  liquidity: U64,
  traders: z.number(),
  creator: z.string(),
  isFeatured: z.boolean().optional(),
};
export const MarketSummarySchema: z.ZodType<T.MarketSummary> = z.object(marketSummaryShape);

export const FlaggedEntrySchema: z.ZodType<T.FlaggedEntry> = z.object({
  ts: Iso,
  wallet: z.string(),
  side: Side,
  priceAtEntry: z.number(),
  usdc: U64,
  score: z.number(),
});

export const PoolInfoSchema: z.ZodType<T.PoolInfo> = z.object({
  reserveAbove: U64,
  reserveBelow: U64,
  completeSets: U64,
  feePool: U64,
  vault: z.string(),
  aboveMint: z.string(),
  belowMint: z.string(),
  lpMint: z.string(),
});

export const FairValueInfoSchema: z.ZodType<T.FairValueInfo> = z.object({
  spot: z.number(),
  vol: z.number(),
  pAbove: z.number(),
  ts: Iso,
});

export const MarketDetailSchema: z.ZodType<T.MarketDetail> = z.object({
  ...marketSummaryShape,
    history: z.object({
      tf: z.enum(['1D', '3D', '1W', 'ALL']),
      points: z.array(z.object({ ts: Iso, priceAbove: z.number() })),
    }),
    flaggedEntries: z.array(FlaggedEntrySchema),
    fairValue: FairValueInfoSchema.nullable(),
    oracle: OracleInfoSchema,
    rules: z.object({ text: z.string(), settleRule: z.string(), oracleFeedId: z.string() }),
    pool: PoolInfoSchema,
    feeBreakdown: z.object({ baseBps: z.number(), nearBps: z.number(), flowBps: z.number(), totalBps: z.number(), capBps: z.number() }),
    settlePrice: z.number().nullable(),
    settlePublishTs: Iso.nullable(),
});

export const WalletFeaturesSchema: z.ZodType<T.WalletFeatures> = z.object({
  whaleOverlap: z.number(),
  entryTiming: z.number(),
  hitRate: z.number(),
  centrality: z.number(),
  leadTimeMin: z.number(),
  nMarkets: z.number(),
});

export const MarketWalletRowSchema: z.ZodType<T.MarketWalletRow> = z.object({
  address: z.string(),
  score: z.number(),
  smart: z.boolean(),
  top: z.boolean(),
  side: Side,
  entryPrice: z.number(),
  usdc: U64,
  features: WalletFeaturesSchema,
  sybil: z.boolean(),
});

export const TradeRowSchema: z.ZodType<T.TradeRow> = z.object({
  id: z.string(),
  ts: Iso,
  wallet: z.string(),
  side: Side,
  dir: z.enum(['buy', 'sell']),
  usdc: U64,
  shares: U64,
  feeUsdc: U64,
  priceAfter: z.number(),
  txSig: z.string(),
  flagged: z.boolean(),
});

export const paged = <S extends z.ZodTypeAny>(item: S) => z.object({ items: z.array(item), nextCursor: z.string().nullable() });

const quoteShape = {
  marketId: z.string(),
  side: Side,
  dir: z.enum(['buy', 'sell']),
  amountIn: U64,
  amountOut: U64,
  minOut: U64,
  slippageBps: z.number(),
  avgPrice: z.number(),
  priceBefore: z.number(),
  priceAfter: z.number(),
  priceImpactBps: z.number(),
  feeBps: z.number(),
  feeUsdc: U64,
  settleValue: U64.nullable(),
  warnings: z.array(z.string()),
};
export const QuoteSchema: z.ZodType<T.Quote> = z.object(quoteShape);

export const UnsignedTxSchema = z.object({
  transaction: z.string(),
  blockhash: z.string(),
  lastValidBlockHeight: z.number(),
  summary: z.string(),
  receipt: z.object(quoteShape).partial().optional(),
  /** /tx/create only: the market account the transaction will create (not part of api-types.ts yet) */
  marketId: z.string().optional(),
}) as unknown as z.ZodType<T.UnsignedTx & { marketId?: string }>;

export const AssetSchema = z.object({ symbol: z.string(), feedId: z.string(), price: z.number().nullable(), ageSec: z.number().nullable() });

/* ------------------------------ requests ------------------------------ */

export const BuildBase = {
  marketId: z.string().min(32).max(44),
  slippageBps: z.number().int().min(1).max(5000).optional(),
  priorityFeeMicroLamports: z.number().int().min(0).max(50_000_000).optional(),
};
export const BuildBuySellSchema = z.object({ ...BuildBase, side: Side, amount: U64 });
export const BuildMergeSchema = z.object({ ...BuildBase, amount: U64 });
export const BuildRedeemSchema = z.object({ ...BuildBase, side: Side, amount: U64 });
export const BuildCreateSchema = z.object({
  assetSymbol: z.string().min(2).max(16),
  kind: z.enum(['close', 'touch']),
  targetPrice: z.number().positive(),
  settleTs: z.string(),
  baseFeeBps: z.union([z.literal(50), z.literal(100), z.literal(200)]),
  dynamicFee: z.boolean(),
  liquidityUsdc: U64,
  p0Bps: z.number().int().min(200).max(9800).optional(),
  question: z.string().min(5).max(140).optional(),
});

/* ------------------------------ auth ------------------------------ */

export const NonceRespSchema: z.ZodType<T.NonceResp> = z.object({
  nonce: z.string(),
  issuedAt: Iso,
  expirationTime: Iso,
  domain: z.string(),
  uri: z.string(),
  statement: z.string(),
  tosVersion: z.string(),
  chainId: z.string(),
});
export const SessionRespSchema: z.ZodType<T.SessionResp> = z.object({
  wallet: z.string(),
  mode: z.enum(['sign', 'view']),
  walletName: z.string().nullable().optional(),
  tosVersion: z.string().nullable(),
  tosAccepted: z.boolean(),
  expiresAt: Iso,
});
export const VerifyReqSchema = z.object({
  wallet: base58,
  signedMessage: z.string().min(1).max(4096),
  signature: z.string().min(1).max(256),
  walletName: z.string().max(64).optional(),
  tosAccepted: z.boolean(),
});

/* ------------------------------ radar ------------------------------ */

export const GraphPayloadSchema: z.ZodType<T.GraphPayload> = z.object({
  nodes: z.array(
    z.object({
      id: z.number(),
      addr: z.string(),
      score: z.number(),
      smart: z.boolean(),
      top: z.boolean(),
      cluster: z.number(),
      pos: z.tuple([z.number(), z.number(), z.number()]),
    }),
  ),
  edges: z.array(z.object({ a: z.number(), b: z.number(), flag: z.boolean() })),
  asOf: Iso.nullable(),
  modelVersion: z.string().nullable(),
  clusters: z.array(z.object({ id: z.number(), name: z.string(), size: z.number() })),
  dataSource: z.string(),
});

export const WalletDetailSchema: z.ZodType<T.WalletDetail> = z.object({
  address: z.string(),
  score: z.number(),
  smart: z.boolean(),
  top: z.boolean(),
  sybil: z.boolean(),
  cluster: z.object({ id: z.number(), name: z.string() }).nullable(),
  features: WalletFeaturesSchema,
  contributions: z.object({ whaleOverlap: z.number(), entryTiming: z.number(), hitRate: z.number(), centrality: z.number(), leadTime: z.number() }),
  reasons: z.array(z.string()),
  tags: z.array(z.string()),
  stats: z.object({ markets: z.number(), hitRate: z.number(), medianLeadMin: z.number(), volumeUsd: z.number() }),
  openPositions: z.array(z.object({ marketId: z.string(), question: z.string(), side: Side, shares: U64, entryPrice: z.number() })),
  asOf: Iso,
  modelVersion: z.string(),
  labelHidden: z.boolean(),
});

export const TrackRecordSchema: z.ZodType<T.TrackRecord> = z.object({
  window: z.object({ start: Iso, end: Iso }),
  runAt: Iso,
  dataSource: z.string(),
  nMarkets: z.number(),
  brier: z.object({ radar: z.number().nullable(), market: z.number().nullable() }),
  hitRate: z.object({ radar: z.number().nullable(), market: z.number().nullable() }),
  medianLeadMin: z.number().nullable(),
  edgeRealizedCents: z.number().nullable(),
  calibration: z.array(z.object({ bin: z.number(), predicted: z.number(), observed: z.number(), n: z.number() })),
  leadHistogram: z.array(z.object({ bucketMin: z.number(), count: z.number() })),
  rows: z.array(
    z.object({
      marketId: z.string(),
      question: z.string().nullable(),
      radarT24: z.number().nullable(),
      marketT24: z.number().nullable(),
      outcome: Side.nullable(),
      closer: z.enum(['radar', 'market', 'tie']).nullable(),
    }),
  ),
  modelVersion: z.string(),
  state: z.enum(['ready', 'building']),
});

/* ------------------------------ account ------------------------------ */

export const UserSettingsSchema: z.ZodType<T.UserSettings> = z.object({
  dailyLimitUsdc: U64.nullable(),
  breakUntil: Iso.nullable(),
  sessionReminder: z.boolean(),
  spentToday: U64,
});
export const MeRespSchema: z.ZodType<T.MeResp> = z.object({
  wallet: z.string(),
  mode: z.enum(['sign', 'view']),
  walletScore: z.object({ score: z.number(), smart: z.boolean(), reasons: z.array(z.string()) }).nullable(),
  settings: UserSettingsSchema,
});
export const PositionRowSchema: z.ZodType<T.PositionRow> = z.object({
  marketId: z.string(),
  question: z.string(),
  side: Side,
  shares: U64,
  avgPrice: z.number(),
  costBasis: U64,
  markPrice: z.number(),
  value: U64,
  pnl: I64,
  status: MarketStatus,
  outcome: Side.nullable(),
  redeemable: U64,
  radar: RadarSummarySchema,
  endsAt: Iso,
});
export const ActivityRowSchema: z.ZodType<T.ActivityRow> = z.object({
  ts: Iso,
  type: z.enum(['buy', 'sell', 'merge', 'redeem', 'create', 'break', 'limit']),
  marketId: z.string().optional(),
  summary: z.string(),
  txSig: z.string().optional(),
});

export const HealthSchema = z.object({
  ok: z.boolean(),
  db: z.boolean(),
  redis: z.boolean(),
  rpc: z.boolean(),
  indexerLagSlots: z.number().nullable(),
  keeper: z.object({ ok: z.boolean(), ageSec: z.number().nullable() }),
  /** true when DEMO_MODE serves clearly labelled synthetic wallet data; the web app shows a "Demo data" ribbon */
  demoMode: z.boolean(),
});
