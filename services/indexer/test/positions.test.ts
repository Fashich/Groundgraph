import { describe, expect, it } from 'vitest';
import { foldPositions, weightedEntryPrice, type PosEvent } from '../src/positions';

const buy = (side: 'above' | 'below', usdc: bigint, shares: bigint): PosEvent => ({ kind: 'buy', side, usdc, shares });
const sell = (side: 'above' | 'below', usdc: bigint, shares: bigint): PosEvent => ({ kind: 'sell', side, usdc, shares });

describe('foldPositions', () => {
  it('accumulates shares and cost on buys', () => {
    const p = foldPositions([buy('above', 10_000_000n, 40_000_000n), buy('above', 5_000_000n, 10_000_000n)]);
    expect(p.above).toMatchObject({ shares: 50_000_000n, cost: 15_000_000n, realized: 0n, touched: true });
    expect(p.below.touched).toBe(false);
  });

  it('releases cost proportionally on a partial sell and books the realized result', () => {
    // cost 10 for 40 shares, sell 10 shares for 4: released cost 2.5 -> realized +1.5
    const p = foldPositions([buy('above', 10_000_000n, 40_000_000n), sell('above', 4_000_000n, 10_000_000n)]);
    expect(p.above).toMatchObject({ shares: 30_000_000n, cost: 7_500_000n, realized: 1_500_000n });
  });

  it('a full exit leaves zero shares, zero cost and the whole result as realized pnl', () => {
    const p = foldPositions([buy('below', 10_000_000n, 20_000_000n), sell('below', 7_000_000n, 20_000_000n)]);
    expect(p.below).toMatchObject({ shares: 0n, cost: 0n, realized: -3_000_000n });
  });

  it('redeeming winners at 1 USDC and losers at 0 realizes the outcome', () => {
    const p = foldPositions([buy('above', 6_000_000n, 10_000_000n), buy('below', 3_000_000n, 10_000_000n), { kind: 'redeem', side: 'above', usdc: 10_000_000n, shares: 10_000_000n }, { kind: 'redeem', side: 'below', usdc: 0n, shares: 10_000_000n }]);
    expect(p.above.realized).toBe(4_000_000n);
    expect(p.below.realized).toBe(-3_000_000n);
    expect(p.above.shares + p.below.shares).toBe(0n);
  });

  it('a merge splits the proceeds by released cost', () => {
    // 10 ABOVE for 3, 10 BELOW for 6.4: merging 10 pays 10; split 3:6.4 of the proceeds
    const p = foldPositions([buy('above', 3_000_000n, 10_000_000n), buy('below', 6_400_000n, 10_000_000n), { kind: 'merge', amount: 10_000_000n }]);
    expect(p.above.shares + p.below.shares).toBe(0n);
    expect(p.above.realized + p.below.realized).toBe(10_000_000n - 9_400_000n);
    expect(p.above.cost + p.below.cost).toBe(0n);
  });

  it('a merge against zero cost splits the proceeds in half', () => {
    const p = foldPositions([{ kind: 'seed', seedAbove: 0n, seedBelow: 0n, p0Bps: 5000 }, { kind: 'merge', amount: 5n }]);
    expect(p.above.realized + p.below.realized).toBe(5n);
  });

  it('never goes negative when more is sold than is known (tokens received from another wallet)', () => {
    const p = foldPositions([buy('above', 1_000_000n, 2_000_000n), sell('above', 5_000_000n, 4_000_000n)]);
    expect(p.above.shares).toBe(0n);
    expect(p.above.cost).toBe(0n);
    expect(p.above.realized).toBe(4_000_000n);
  });

  it('carries the creator seed at the initial pool price', () => {
    // p0 = 21%: the creator holds only BELOW shares, valued at 79%
    const p = foldPositions([{ kind: 'seed', seedAbove: 0n, seedBelow: 500_000_000n, p0Bps: 2100 }]);
    expect(p.below.shares).toBe(500_000_000n);
    expect(p.below.cost).toBe(395_000_000n);
    expect(p.above.touched).toBe(false);
  });

  it('is deterministic for the same ordered events', () => {
    const evs = [buy('above', 5n, 9n), sell('above', 4n, 3n), buy('above', 2n, 2n), { kind: 'redeem', side: 'above', usdc: 8n, shares: 4n } as PosEvent];
    expect(foldPositions(evs)).toEqual(foldPositions(evs));
  });
});

describe('weightedEntryPrice', () => {
  it('weights by usdc', () => {
    expect(weightedEntryPrice([{ usdc: 1_000_000n, priceAfter: 0.2 }, { usdc: 3_000_000n, priceAfter: 0.4 }])).toBe(0.35);
  });
  it('is null without buys', () => {
    expect(weightedEntryPrice([])).toBeNull();
  });
});
