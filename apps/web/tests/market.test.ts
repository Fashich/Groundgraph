import { describe, expect, it } from 'vitest';
import { LEAD_FULL_MIN, bpsPct, blinkUrl, chartGeometry, feeSegments, flaggedLean, largeVsBalance, leadFill, marketUrl, medianLead, oracleView, parseAmount, pointAtFraction, radarFavors, sortWallets } from '@/lib/market';
import { detail, u, walletRow } from './helpers';

describe('flagged wallets', () => {
  const rows = [
    walletRow({ address: 'a', side: 'above', usdc: u(300), score: 90 }),
    walletRow({ address: 'b', side: 'below', usdc: u(100), score: 75 }),
    walletRow({ address: 'c', smart: false, side: 'below', usdc: u(5000), score: 20 }),
    walletRow({ address: 'd', sybil: true, side: 'below', usdc: u(9000), score: 95 }),
  ];
  it('lean counts only flagged, non-sybil wallets', () => {
    const l = flaggedLean(rows)!;
    expect(l.n).toBe(2);
    expect(l.abovePct).toBe(75);
    expect(l.belowPct).toBe(25);
    expect(l.total).toBe(400);
  });
  it('is null rather than invented when there is nothing flagged', () => {
    expect(flaggedLean([walletRow({ smart: false })])).toBeNull();
    expect(flaggedLean(undefined)).toBeNull();
    expect(flaggedLean([])).toBeNull();
  });
  it('median lead time of flagged wallets', () => {
    const f = (m: number) => ({ ...walletRow().features, leadTimeMin: m });
    expect(medianLead([walletRow({ features: f(10) }), walletRow({ features: f(30) }), walletRow({ features: f(20) })])).toBe(20);
    expect(medianLead([walletRow({ features: f(10) }), walletRow({ features: f(30) })])).toBe(20);
    expect(medianLead([walletRow({ smart: false })])).toBeNull();
    expect(medianLead(undefined)).toBeNull();
  });
  it('sorts by score without mutating', () => {
    const s = sortWallets(rows);
    expect(s.map((r) => r.address)).toEqual(['d', 'a', 'b', 'c']);
    expect(rows[0]!.address).toBe('a');
  });
  it('lead bar fills at LEAD_FULL_MIN and never overflows', () => {
    expect(leadFill(LEAD_FULL_MIN)).toBe(1);
    expect(leadFill(LEAD_FULL_MIN * 3)).toBe(1);
    expect(leadFill(LEAD_FULL_MIN / 2)).toBe(0.5);
    expect(leadFill(-5)).toBe(0);
  });
});

describe('chart geometry', () => {
  const pts = Array.from({ length: 10 }, (_, i) => ({ ts: new Date(Date.UTC(2026, 9, 12, i)).toISOString(), priceAbove: 0.4 + i * 0.01 }));
  it('needs at least two points', () => {
    expect(chartGeometry([], null, [])).toBeNull();
    expect(chartGeometry([pts[0]!], null, [])).toBeNull();
  });
  it('builds a line and area inside the viewbox, with a padded y range', () => {
    const g = chartGeometry(pts, null, [])!;
    expect(g.line.startsWith('M0.0')).toBe(true);
    expect(g.area.endsWith('Z')).toBe(true);
    expect(g.lo).toBeLessThan(0.4);
    expect(g.hi).toBeGreaterThan(0.49);
    expect(g.grid).toHaveLength(4);
    expect(g.fairYPct).toBeNull();
  });
  it('includes the fair value in the range and places it', () => {
    const g = chartGeometry(pts, 0.9, [])!;
    expect(g.hi).toBeGreaterThanOrEqual(0.9);
    expect(g.fairYPct).not.toBeNull();
  });
  it('marks only flagged entries inside the window, strongest first, capped', () => {
    const inside = (h: number, score: number) => ({ ts: new Date(Date.UTC(2026, 9, 12, h, 30)).toISOString(), wallet: 'w', side: 'above' as const, priceAtEntry: 0.5, usdc: u(10), score });
    const outside = { ...inside(1, 99), ts: '2020-01-01T00:00:00.000Z' };
    const g = chartGeometry(pts, null, [inside(2, 70), inside(3, 90), outside], 1)!;
    expect(g.marks).toHaveLength(1);
    expect(g.marks[0]!.entry.score).toBe(90);
  });
  it('crosshair snaps to the nearest point', () => {
    const p = pointAtFraction(pts, 0.5)!;
    expect(p.xPct).toBeGreaterThan(40);
    expect(p.xPct).toBeLessThan(60);
  });
});

describe('oracle view', () => {
  const o = detail().oracle;
  it('ok, stale and unavailable are different tones', () => {
    expect(oracleView(o).tone).toBe('ok');
    expect(oracleView({ ...o, stale: true }).tone).toBe('stale');
    expect(oracleView({ ...o, price: null, conf: null, ageSec: null, publishTs: null, stale: true }).tone).toBe('unknown');
  });
  it('prints a single dollar sign before the price', () => {
    expect(oracleView(o).label).toMatch(/^Pyth \$[\d,.]+/);
    expect(oracleView({ ...o, stale: true }).label).not.toMatch(/\$\$/);
  });
  it('stale text says what still works', () => {
    expect(oracleView({ ...o, stale: true }).title).toMatch(/selling and merging still work/i);
  });
});

describe('fees and amounts', () => {
  it('fee segments add up to 100 percent and name the recent flow component', () => {
    const segs = feeSegments({ baseBps: 100, nearBps: 50, flowBps: 50, totalBps: 200, capBps: 300 });
    expect(segs.map((s) => s.label)).toEqual(['Base', 'Near resolution', 'Recent flow']);
    expect(segs.reduce((a, s) => a + s.pct, 0)).toBeCloseTo(100, 6);
  });
  it('bps to percent', () => {
    expect(bpsPct(100)).toBe('1.00%');
    expect(bpsPct(50)).toBe('0.50%');
  });
  it('parses typed amounts strictly', () => {
    expect(parseAmount('12.5')).toBe(12.5);
    expect(parseAmount('1,000')).toBe(1000);
    expect(parseAmount('.5')).toBe(0.5);
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('.')).toBeNull();
    expect(parseAmount('1e3')).toBeNull();
    expect(parseAmount('-4')).toBeNull();
    expect(parseAmount('abc')).toBeNull();
  });
  it('flags a buy that is large against the balance', () => {
    expect(largeVsBalance(30, 100)).toBe(30);
    expect(largeVsBalance(10, 100)).toBeNull();
    expect(largeVsBalance(10, null)).toBeNull();
    expect(largeVsBalance(10, 0)).toBeNull();
  });
  it('radar favors the side with the edge', () => {
    expect(radarFavors(5)).toBe('above');
    expect(radarFavors(-5)).toBe('below');
    expect(radarFavors(0)).toBeNull();
    expect(radarFavors(null)).toBeNull();
  });
  it('share links', () => {
    expect(marketUrl('https://gg.test', 'ID')).toBe('https://gg.test/markets/ID');
    expect(blinkUrl('https://gg.test', 'ID')).toBe('https://dial.to/?action=solana-action:https://gg.test/api/actions/m/ID');
  });
});
