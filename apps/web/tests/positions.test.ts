import { describe, expect, it } from 'vitest';
import { alignment, alignmentCounts, filterPositions, isLive, mergePair, pnlFraction, portfolioTotals, settledPerShare } from '@/lib/positions';
import { BUILDING_RADAR, READY_RADAR, position, u } from './helpers';

describe('alignment with the radar lean', () => {
  it('compares the held side with the side the radar favors', () => {
    expect(alignment(position({ side: 'above', radar: { ...READY_RADAR, edge: 6 } }))).toBe('with');
    expect(alignment(position({ side: 'below', radar: { ...READY_RADAR, edge: 6 } }))).toBe('against');
    expect(alignment(position({ side: 'below', radar: { ...READY_RADAR, edge: -6 } }))).toBe('with');
    expect(alignment(position({ radar: { ...READY_RADAR, edge: 0 } }))).toBe('neutral');
  });
  it('says building when the radar has no signal, never guesses', () => {
    expect(alignment(position({ radar: BUILDING_RADAR }))).toBe('building');
    expect(alignment(position({ radar: { ...READY_RADAR, edge: null } }))).toBe('building');
  });
  it('counts open positions by alignment', () => {
    const rows = [position(), position({ side: 'below' }), position({ radar: BUILDING_RADAR })];
    expect(alignmentCounts(rows)).toEqual({ with: 1, against: 1, neutral: 0, building: 1 });
  });
});

describe('filters', () => {
  const rows = [position({ marketId: 'a', side: 'above' }), position({ marketId: 'b', side: 'below' }), position({ marketId: 'c', side: 'above', radar: BUILDING_RADAR })];
  it('filters by side and lean', () => {
    expect(filterPositions(rows, 'all', 'all')).toHaveLength(3);
    expect(filterPositions(rows, 'above', 'all').map((p) => p.marketId)).toEqual(['a', 'c']);
    expect(filterPositions(rows, 'all', 'with').map((p) => p.marketId)).toEqual(['a']);
    expect(filterPositions(rows, 'all', 'against').map((p) => p.marketId)).toEqual(['b']);
    expect(filterPositions(rows, 'below', 'with')).toEqual([]);
  });
});

describe('merge', () => {
  it('offers the smaller side as the number of complete sets, only on live markets', () => {
    const a = position({ side: 'above', shares: u(100) });
    const b = position({ side: 'below', shares: u(40) });
    expect(mergePair(a, [a, b])).toEqual({ amount: u(40), usdc: 40 });
    expect(mergePair(b, [a, b])).toEqual({ amount: u(40), usdc: 40 });
  });
  it('is not offered with one side, another market, or after settlement', () => {
    const a = position({ side: 'above' });
    expect(mergePair(a, [a])).toBeNull();
    expect(mergePair(a, [a, position({ marketId: 'other', side: 'below' })])).toBeNull();
    const sa = position({ side: 'above', status: 'settled', outcome: 'above' });
    const sb = position({ side: 'below', status: 'settled', outcome: 'above' });
    expect(mergePair(sa, [sa, sb])).toBeNull();
  });
  it('trading_closed still counts as live: merge is allowed until settlement', () => {
    expect(isLive(position({ status: 'trading_closed' }))).toBe(true);
    expect(isLive(position({ status: 'settled' }))).toBe(false);
    expect(isLive(position({ status: 'voided' }))).toBe(false);
  });
});

describe('P&L', () => {
  it('uses the signed string from the API', () => {
    expect(pnlFraction(position({ pnl: u(10), costBasis: u(50) }))).toBeCloseTo(0.2, 6);
    expect(pnlFraction(position({ pnl: '-12500000', costBasis: u(50) }))).toBeCloseTo(-0.25, 6);
    expect(pnlFraction(position({ costBasis: '0' }))).toBeNull();
  });
  it('settled payout per share', () => {
    expect(settledPerShare({ status: 'settled', side: 'above', outcome: 'above' })).toBe(1);
    expect(settledPerShare({ status: 'settled', side: 'below', outcome: 'above' })).toBe(0);
    expect(settledPerShare({ status: 'voided', side: 'below', outcome: null })).toBeNull();
    expect(settledPerShare({ status: 'open', side: 'below', outcome: null })).toBeNull();
  });
});

describe('portfolio totals', () => {
  const open = [position({ value: u(60), costBasis: u(50), pnl: u(10) }), position({ side: 'below', value: u(20), costBasis: u(30), pnl: '-10000000' })];
  const redeem = [position({ status: 'settled', outcome: 'above', redeemable: u(75), value: u(75), costBasis: u(40), pnl: u(35) })];
  const resolved = [...redeem, position({ status: 'settled', outcome: 'above', side: 'below', shares: '0', value: '0', costBasis: u(10), pnl: '-10000000', redeemable: '0' })];
  it('sums values, signed P&L and exposure by side', () => {
    const t = portfolioTotals(open, redeem, resolved);
    expect(t.openValue).toBe(80);
    expect(t.openCost).toBe(80);
    expect(t.unrealized).toBe(0);
    expect(t.toRedeem).toBe(75);
    expect(t.exposure).toEqual({ above: 60, below: 20 });
    expect(t.openCount).toBe(2);
    expect(t.redeemCount).toBe(1);
  });
  it('takes realized P&L from the resolved tab only, so settled rows are not counted twice', () => {
    const t = portfolioTotals(open, redeem, resolved);
    expect(t.resolvedPnl).toBe(25);
    expect(t.resolvedCount).toBe(2);
  });
  it('is all zeros for an empty account', () => {
    const t = portfolioTotals([], [], []);
    expect(t).toMatchObject({ openValue: 0, unrealized: 0, toRedeem: 0, resolvedPnl: 0, exposure: { above: 0, below: 0 } });
  });
});
