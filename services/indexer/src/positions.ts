/**
 * Pure position accounting. A wallet's position in a market is rebuilt by folding its events in chain order, so the
 * result never depends on the order in which the indexer happened to ingest them (live polling, backfill, replays).
 *
 * Conventions (all amounts are base units, 6 dp):
 * - buy:    shares += s, cost += gross USDC paid (fee included)
 * - sell / redeem: cost is released in proportion to the shares given up; realized += proceeds - released cost
 * - merge:  burns m of each side for m USDC. The proceeds are split between the sides in proportion to the cost each
 *           side released (50/50 when both released nothing). realized per side = its proceeds - its released cost
 * - seed:   the market creator receives outcome shares at creation. They are carried at the initial pool price.
 * The API reports pnl = value + realized - cost, so a position that was fully sold shows exactly its realized result.
 */
export type Side = 'above' | 'below';

export type PosEvent =
  | { kind: 'buy'; side: Side; usdc: bigint; shares: bigint }
  | { kind: 'sell'; side: Side; usdc: bigint; shares: bigint }
  | { kind: 'redeem'; side: Side; usdc: bigint; shares: bigint }
  | { kind: 'merge'; amount: bigint }
  | { kind: 'seed'; seedAbove: bigint; seedBelow: bigint; p0Bps: number };

export interface SidePosition {
  shares: bigint;
  cost: bigint;
  realized: bigint;
  /** at least one event touched this side */
  touched: boolean;
}

export interface WalletPosition {
  above: SidePosition;
  below: SidePosition;
}

const empty = (): SidePosition => ({ shares: 0n, cost: 0n, realized: 0n, touched: false });

const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** Release the cost attributable to `n` of the held shares (all of it when everything is released). */
function releaseCost(p: SidePosition, n: bigint): bigint {
  if (p.shares <= 0n || n <= 0n) return 0n;
  if (n >= p.shares) return p.cost;
  return (p.cost * n) / p.shares;
}

function reduce(p: SidePosition, n: bigint, proceeds: bigint): void {
  p.touched = true;
  const taken = min(n, p.shares);
  const released = releaseCost(p, taken);
  p.shares -= taken;
  p.cost -= released;
  p.realized += proceeds - released;
}

export function foldPositions(events: readonly PosEvent[]): WalletPosition {
  const pos: WalletPosition = { above: empty(), below: empty() };
  for (const ev of events) {
    switch (ev.kind) {
      case 'buy': {
        const p = pos[ev.side];
        p.touched = true;
        p.shares += ev.shares;
        p.cost += ev.usdc;
        break;
      }
      case 'sell':
      case 'redeem':
        reduce(pos[ev.side], ev.shares, ev.usdc);
        break;
      case 'merge': {
        const a = pos.above;
        const b = pos.below;
        a.touched = b.touched = true;
        const na = min(ev.amount, a.shares);
        const nb = min(ev.amount, b.shares);
        const ca = releaseCost(a, na);
        const cb = releaseCost(b, nb);
        const total = ca + cb;
        const proceedsA = total > 0n ? (ev.amount * ca) / total : ev.amount / 2n;
        const proceedsB = ev.amount - proceedsA;
        a.shares -= na;
        a.cost -= ca;
        a.realized += proceedsA - ca;
        b.shares -= nb;
        b.cost -= cb;
        b.realized += proceedsB - cb;
        break;
      }
      case 'seed': {
        const bps = BigInt(ev.p0Bps);
        if (ev.seedAbove > 0n) {
          pos.above.touched = true;
          pos.above.shares += ev.seedAbove;
          pos.above.cost += (ev.seedAbove * bps) / 10_000n;
        }
        if (ev.seedBelow > 0n) {
          pos.below.touched = true;
          pos.below.shares += ev.seedBelow;
          pos.below.cost += (ev.seedBelow * (10_000n - bps)) / 10_000n;
        }
        break;
      }
    }
  }
  return pos;
}

/** USDC-weighted average of ABOVE prices (0..1 as bps-precision numbers); null when nothing was bought. */
export function weightedEntryPrice(buys: readonly { usdc: bigint; priceAfter: number }[]): number | null {
  let weight = 0;
  let sum = 0;
  for (const b of buys) {
    const w = Number(b.usdc);
    weight += w;
    sum += w * b.priceAfter;
  }
  if (weight <= 0) return null;
  return Math.round((sum / weight) * 1e6) / 1e6;
}
