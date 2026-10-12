import type { PositionRow, Side } from '@groundgraph/sdk/api-types';
import { fromBase } from './format';
import { radarFavors } from './market';

export type PositionTab = 'open' | 'redeem' | 'resolved';
export type SideFilter = 'all' | Side;
export type LeanFilter = 'all' | 'with' | 'against';
/** How a position sits relative to the radar's current lean. `building` when the radar has no signal yet. */
export type Alignment = 'with' | 'against' | 'neutral' | 'building';

export const POSITION_TABS: { id: PositionTab; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'redeem', label: 'To redeem' },
  { id: 'resolved', label: 'Resolved' },
];

/** The market is still tradable or waiting for its result. Sells and merges stay available until it settles. */
export const isLive = (p: Pick<PositionRow, 'status'>) => p.status === 'open' || p.status === 'trading_closed';

export function alignment(p: Pick<PositionRow, 'side' | 'radar'>): Alignment {
  if (p.radar.state !== 'ready' || p.radar.edge == null) return 'building';
  const fav = radarFavors(p.radar.edge);
  if (!fav) return 'neutral';
  return fav === p.side ? 'with' : 'against';
}

export function filterPositions(rows: PositionRow[], side: SideFilter, lean: LeanFilter): PositionRow[] {
  return rows.filter((p) => {
    if (side !== 'all' && p.side !== side) return false;
    if (lean !== 'all' && alignment(p) !== lean) return false;
    return true;
  });
}

/** The same market's opposite side, when both are held on a live market. Those can be merged back into USDC. */
export function mergePair(p: PositionRow, rows: PositionRow[]): { amount: string; usdc: number } | null {
  if (!isLive(p) || BigInt(p.shares) <= 0n) return null;
  const other = rows.find((r) => r.marketId === p.marketId && r.side !== p.side && isLive(r));
  if (!other) return null;
  const a = BigInt(p.shares);
  const b = BigInt(other.shares);
  const amt = a < b ? a : b;
  if (amt <= 0n) return null;
  return { amount: amt.toString(), usdc: fromBase(amt.toString()) };
}

/** P&L as a fraction of the cost basis, or null when there is no cost basis to compare to. */
export function pnlFraction(p: Pick<PositionRow, 'pnl' | 'costBasis'>): number | null {
  const cost = fromBase(p.costBasis);
  if (!(cost > 0)) return null;
  return fromBase(p.pnl) / cost;
}

export interface PortfolioTotals {
  openCount: number;
  openValue: number;
  openCost: number;
  unrealized: number;
  redeemCount: number;
  toRedeem: number;
  resolvedCount: number;
  resolvedPnl: number;
  /** current value split by side, for the exposure bar */
  exposure: { above: number; below: number };
}

const sum = (rows: PositionRow[], f: (p: PositionRow) => number) => rows.reduce((a, p) => a + f(p), 0);

/**
 * Totals shown above the position list. Realized P&L comes from the resolved tab only: that tab is a superset of
 * the redeem tab (it also lists redeemed positions), so adding both would count settled positions twice.
 */
export function portfolioTotals(open: PositionRow[], redeem: PositionRow[], resolved: PositionRow[]): PortfolioTotals {
  return {
    openCount: open.length,
    openValue: sum(open, (p) => fromBase(p.value)),
    openCost: sum(open, (p) => fromBase(p.costBasis)),
    unrealized: sum(open, (p) => fromBase(p.pnl)),
    redeemCount: redeem.length,
    toRedeem: sum(redeem, (p) => fromBase(p.redeemable)),
    resolvedCount: resolved.length,
    resolvedPnl: sum(resolved, (p) => fromBase(p.pnl)),
    exposure: {
      above: sum(
        open.filter((p) => p.side === 'above'),
        (p) => fromBase(p.value),
      ),
      below: sum(
        open.filter((p) => p.side === 'below'),
        (p) => fromBase(p.value),
      ),
    },
  };
}

/** Current alignment counts across open positions (the radar's lean today, not at entry). */
export function alignmentCounts(open: PositionRow[]): { with: number; against: number; neutral: number; building: number } {
  const c = { with: 0, against: 0, neutral: 0, building: 0 };
  for (const p of open) c[alignment(p)] += 1;
  return c;
}

/** The USDC a settled position pays per share: $1 on the winning side, $0 on the other, null while unresolved or voided. */
export function settledPerShare(p: Pick<PositionRow, 'status' | 'side' | 'outcome'>): 1 | 0 | null {
  if (p.status !== 'settled' || !p.outcome) return null;
  return p.outcome === p.side ? 1 : 0;
}
