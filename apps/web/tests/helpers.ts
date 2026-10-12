import type { MarketDetail, MarketSummary, MarketWalletRow, PositionRow, RadarSummary } from '@groundgraph/sdk/api-types';

export const USDC = 1_000_000;
export const u = (usdc: number) => String(Math.round(usdc * USDC));

export const READY_RADAR: RadarSummary = { state: 'ready', p: 0.6, ci: 8, n: 5, edge: 6, modelVersion: 'test', ts: '2026-10-12T12:00:00.000Z' };
export const BUILDING_RADAR: RadarSummary = { state: 'building', p: null, ci: null, n: 1, edge: null, modelVersion: null, ts: null };

export function summary(over: Partial<MarketSummary> = {}): MarketSummary {
  return {
    id: 'MKT1111111111111111111111111111111111111111',
    question: 'SOL above or below $200 at the Oct 20 close?',
    kind: 'close',
    direction: null,
    assetSymbol: 'SOL',
    category: 'crypto',
    targetPrice: 200,
    status: 'open',
    outcome: null,
    priceAbove: 0.54,
    implied: 0.54,
    ch24: 1.2,
    spark: [0.5, 0.52, 0.54],
    radar: READY_RADAR,
    feeBpsNow: 100,
    baseFeeBps: 100,
    dynamicFee: true,
    endsAt: '2026-10-20T23:59:00.000Z',
    tradingEndsAt: '2026-10-20T23:00:00.000Z',
    volume: u(1200),
    liquidity: u(800),
    traders: 14,
    creator: 'CRE1111111111111111111111111111111111111111',
    ...over,
  };
}

export function detail(over: Partial<MarketDetail> = {}): MarketDetail {
  return {
    ...summary(),
    history: { tf: '1D', points: [{ ts: '2026-10-12T10:00:00.000Z', priceAbove: 0.5 }, { ts: '2026-10-12T11:00:00.000Z', priceAbove: 0.54 }] },
    flaggedEntries: [],
    fairValue: { spot: 205, vol: 0.8, pAbove: 0.58, ts: '2026-10-12T12:00:00.000Z' },
    oracle: { feedId: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d', symbol: 'SOL/USD', price: 205, conf: 0.08, publishTs: '2026-10-12T12:00:00.000Z', ageSec: 3, stale: false },
    rules: { text: 'rule text', settleRule: 'settle rule', oracleFeedId: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d' },
    pool: { reserveAbove: u(500), reserveBelow: u(600), completeSets: u(400), feePool: u(2), vault: 'v', aboveMint: 'a', belowMint: 'b', lpMint: 'l' },
    feeBreakdown: { baseBps: 100, nearBps: 0, flowBps: 0, totalBps: 100, capBps: 300 },
    settlePrice: null,
    settlePublishTs: null,
    ...over,
  };
}

export function walletRow(over: Partial<MarketWalletRow> = {}): MarketWalletRow {
  return {
    address: 'WAL1111111111111111111111111111111111111111',
    score: 80,
    smart: true,
    top: false,
    side: 'above',
    entryPrice: 0.5,
    usdc: u(100),
    features: { whaleOverlap: 0.5, entryTiming: 0.5, hitRate: 0.5, centrality: 0.5, leadTimeMin: 30, nMarkets: 12 },
    sybil: false,
    ...over,
  };
}

export function position(over: Partial<PositionRow> = {}): PositionRow {
  return {
    marketId: 'MKT1111111111111111111111111111111111111111',
    question: 'SOL above or below $200 at the Oct 20 close?',
    side: 'above',
    shares: u(100),
    avgPrice: 0.5,
    costBasis: u(50),
    markPrice: 0.6,
    value: u(60),
    pnl: u(10),
    status: 'open',
    outcome: null,
    redeemable: '0',
    radar: READY_RADAR,
    endsAt: '2026-10-20T23:59:00.000Z',
    ...over,
  };
}
