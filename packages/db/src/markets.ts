import type { Sql } from './client';

export interface MarketRow {
  id: string;
  creator: string;
  kind: 'close' | 'touch';
  direction: 'up' | 'down' | null;
  assetSymbol: string;
  feedId: string;
  targetPrice: string;
  targetExpo: number;
  targetRaw: string;
  openTs: Date;
  tradingEndTs: Date;
  settleTs: Date;
  baseFeeBps: number;
  dynamicFee: boolean;
  question: string;
  category: string;
  status: 'open' | 'trading_closed' | 'settled' | 'voided';
  outcome: 'above' | 'below' | null;
  settlePrice: string | null;
  settlePublishTs: Date | null;
  aboveMint: string;
  belowMint: string;
  lpMint: string;
  vault: string;
  reserveAbove: string;
  reserveBelow: string;
  completeSets: string;
  feePool: string;
  hidden: boolean;
  createdTx: string | null;
  createdAt: Date;
  updatedAt: Date;
  emaImpactBps: number;
  emaTs: number;
  settleExpo: number | null;
  lpClaimRemaining: string | null;
  lpSupplyRemaining: string | null;
  lastSlot: number;
  reconciledAt: Date | null;
  createdSlot: number;
  createdFinalized: boolean;
}

export async function getMarket(sql: Sql, id: string): Promise<MarketRow | null> {
  const rows = await sql<MarketRow[]>`SELECT * FROM markets WHERE id = ${id}`;
  return rows[0] ?? null;
}

/** Markets that have not settled or voided yet (stored status 'open'). */
export async function listUnsettledMarkets(sql: Sql): Promise<MarketRow[]> {
  return sql<MarketRow[]>`SELECT * FROM markets WHERE status = 'open' ORDER BY settle_ts ASC`;
}

/** Stored-open markets whose settle_ts has passed: candidates for the keeper. */
export async function listDueMarkets(sql: Sql, now: Date): Promise<MarketRow[]> {
  return sql<MarketRow[]>`SELECT * FROM markets WHERE status = 'open' AND settle_ts <= ${now} ORDER BY settle_ts ASC`;
}

/** Price of ABOVE as a number in 0..1 from base-unit reserves (display only, never used for settlement math). */
export function priceAboveFromReserves(reserveAbove: string | bigint, reserveBelow: string | bigint): number {
  const ra = BigInt(reserveAbove);
  const rb = BigInt(reserveBelow);
  const total = ra + rb;
  if (total === 0n) return 0.5;
  // 1e9 fixed point keeps full precision for u64 reserves, then convert once
  return Number((rb * 1_000_000_000n) / total) / 1_000_000_000;
}
