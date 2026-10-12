import { describe, expect, it } from 'vitest';
import { addrMessage, addrStatus } from '@/lib/addr';
import { DEFAULT_BLOCKED, countryFromHeaders, isBlocked, isEntryRoute, parseBlocked } from '@/lib/geo';
import { HEDGE_DEFAULT, hedgeExample } from '@/lib/hedge';
import { graphLimit, nodePasses, pickNodes } from '@/lib/graph';
import { arbLoss, depthLevel, impactCents, roundOpen, seedReserves } from '@/lib/math';
import { LIQ_MAX, LIQ_MIN, addressSchema, validateTarget, validateTiming } from '@/lib/validation';
import { graphStats, signalMarkets, topWallet } from '@/lib/landing';
import { closerStats, leadBuckets } from '@/lib/track';
import { deriveRadar } from '@/lib/radar';
import type { GraphNode, GraphPayload } from '@groundgraph/sdk/api-types';
import { summary } from './helpers';

describe('addr', () => {
  it('classifies pasted addresses', () => {
    expect(addrStatus('')).toBe('empty');
    expect(addrStatus('0x71C7656EC7ab88b098defB751B7401B5f6d8976F')).toBe('evm');
    expect(addrStatus('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU')).toBe('ok');
    expect(addrStatus('hello')).toBe('bad');
    expect(addrStatus('O'.repeat(40))).toBe('bad'); // 'O' is not in the base58 alphabet
  });
  it('gives the EVM case its own message', () => {
    expect(addrMessage('evm', '').text).toMatch(/EVM/);
    expect(addrMessage('ok', '7xKX').tone).toBe('ok');
  });
  it('zod schema matches the status check', () => {
    expect(addressSchema.safeParse('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU').success).toBe(true);
    expect(addressSchema.safeParse('0x71C7656EC7ab88b098defB751B7401B5f6d8976F').success).toBe(false);
  });
});

describe('geo', () => {
  it('parses the blocked list', () => {
    expect([...parseBlocked('us, cu ,IR,USA,1x')].sort()).toEqual(['CU', 'IR', 'US']);
    expect(parseBlocked(undefined).size).toBe(0);
    expect(parseBlocked(DEFAULT_BLOCKED).has('US')).toBe(true);
  });
  it('reads the country header and ignores unknown values', () => {
    expect(countryFromHeaders((n) => (n === 'cf-ipcountry' ? 'us' : null))).toBe('US');
    expect(countryFromHeaders((n) => (n === 'x-vercel-ip-country' ? 'DE' : null))).toBe('DE');
    expect(countryFromHeaders((n) => (n === 'cf-ipcountry' ? 'XX' : null))).toBeNull();
    expect(countryFromHeaders((n) => (n === 'cf-ipcountry' ? 'T1' : null))).toBeNull();
    expect(countryFromHeaders(() => null)).toBeNull();
  });
  it('allows access when no country is known', () => {
    expect(isBlocked(null, parseBlocked('US'))).toBe(false);
    expect(isBlocked('US', parseBlocked('US'))).toBe(true);
    expect(isBlocked('DE', parseBlocked('US'))).toBe(false);
  });
  it('closes only the entry routes so holders can still exit', () => {
    for (const p of ['/markets', '/markets/', '/create', '/radar']) expect(isEntryRoute(p)).toBe(true);
    for (const p of ['/', '/positions', '/markets/AbC', '/legal/terms', '/m/AbC', '/blocked']) expect(isEntryRoute(p)).toBe(false);
  });
});

describe('create math', () => {
  it('seeds reserves so the price equals p0', () => {
    for (const p0 of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const { ra, rb } = seedReserves(1000, p0);
      expect(rb / (ra + rb)).toBeCloseTo(p0, 6);
    }
  });
  it('clamps p0 to the program bounds', () => {
    const lo = seedReserves(100, 0);
    expect(lo.rb / (lo.ra + lo.rb)).toBeCloseTo(0.02, 6);
    expect(roundOpen(0.999)).toBe(0.98);
    expect(roundOpen(0.001)).toBe(0.02);
    expect(roundOpen(0.4549)).toBe(0.45);
  });
  it('price impact falls as liquidity grows', () => {
    const a = impactCents(100, 0.5, 50);
    const b = impactCents(10_000, 0.5, 50);
    expect(a).toBeGreaterThan(b);
    expect(impactCents(0, 0.5, 50)).toBe(100);
  });
  it('depth levels', () => {
    expect(depthLevel(15)).toBe(1);
    expect(depthLevel(5)).toBe(2);
    expect(depthLevel(1)).toBe(3);
  });
  it('arb loss is zero at an even fair value and grows with the gap', () => {
    expect(arbLoss(1000, 0.5)).toBeCloseTo(0, 6);
    expect(arbLoss(1000, 0.8)).toBeGreaterThan(arbLoss(1000, 0.6));
    expect(arbLoss(1000, 0.8)).toBeLessThan(1000);
  });
});

describe('create validation', () => {
  const now = Date.parse('2026-10-12T12:00:00.000Z');
  it('target must be set and at least 1% from spot', () => {
    expect(validateTarget(0, 100)).toMatch(/target/i);
    expect(validateTarget(100.5, 100)).toMatch(/1%/);
    expect(validateTarget(110, 100)).toBe('');
    expect(validateTarget(110, null)).toBe('');
  });
  it('timing window is 24h to 180 days', () => {
    expect(validateTiming('nope', 500, now)).toMatch(/date/i);
    expect(validateTiming('2026-10-12', 500, now)).toMatch(/24h/);
    expect(validateTiming('2027-12-31', 500, now)).toMatch(/180/);
    expect(validateTiming('2026-11-12', 500, now)).toBe('');
  });
  it('liquidity bounds', () => {
    expect(validateTiming('2026-11-12', LIQ_MIN - 1, now)).toMatch(/Minimum/);
    expect(validateTiming('2026-11-12', LIQ_MAX + 1, now)).toMatch(/Maximum/);
    expect(validateTiming('2026-11-12', LIQ_MIN, now)).toBe('');
  });
});

describe('hedge illustration', () => {
  it('is pure arithmetic on the assumed inputs', () => {
    const h = hedgeExample(HEDGE_DEFAULT);
    expect(h.holdValue).toBeCloseTo(HEDGE_DEFAULT.qty * HEDGE_DEFAULT.spot, 6);
    expect(h.cost).toBeCloseTo(HEDGE_DEFAULT.shares * HEDGE_DEFAULT.belowPrice, 6);
    expect(h.netWithout).toBeCloseTo(-h.holdingsLoss, 6);
    expect(h.netIfHolds).toBeCloseTo(-h.cost, 6);
    expect(h.netWithHedge).toBeGreaterThan(h.netWithout);
  });
});

const node = (id: number, score: number, over: Partial<GraphNode> = {}): GraphNode => ({ id, addr: `A${id}`, score, smart: score >= 70, top: score >= 98, cluster: id % 3, x: 0, y: 0, ...over }) as GraphNode;

describe('graph selection', () => {
  const nodes = Array.from({ length: 300 }, (_, i) => node(i, i % 100));
  it('limits by mode and device', () => {
    expect(graphLimit('explorer', true)).toBeLessThanOrEqual(70);
    expect(graphLimit('hero', true)).toBeLessThan(graphLimit('hero', false));
  });
  it('returns everything when under the limit', () => {
    expect(pickNodes(nodes.slice(0, 10), 50)).toHaveLength(10);
  });
  it('keeps members first, then top scores, then a spread of the crowd', () => {
    const members = new Set(['A5', 'A6']);
    const picked = pickNodes(nodes, 40, members);
    expect(picked.length).toBeLessThanOrEqual(40);
    expect(picked).toContain(5);
    expect(picked).toContain(6);
    expect([...picked].sort((a, b) => a - b)).toEqual(picked);
    const top = Math.max(...picked.map((i) => nodes[i]!.score));
    expect(top).toBeGreaterThanOrEqual(98);
  });
  it('filters by score, cluster and crowd', () => {
    const f = { minScore: 50, cluster: 'all', showCrowd: true };
    expect(nodePasses(node(1, 49), f)).toBe(false);
    expect(nodePasses(node(1, 60), f)).toBe(true);
    expect(nodePasses(node(1, 60), { ...f, showCrowd: false })).toBe(false);
    expect(nodePasses(node(1, 80), { ...f, cluster: '1' })).toBe(true);
    expect(nodePasses(node(1, 80), { ...f, cluster: '2' })).toBe(false);
  });
});

describe('radar derivation', () => {
  const payload = { nodes: [node(1, 40), node(2, 72), node(3, 99), node(4, 85)], edges: [], asOf: null, modelVersion: null, clusters: [], dataSource: 'demo-synthetic' } as unknown as GraphPayload;
  it('derives thresholds from the data, not from constants', () => {
    const d = deriveRadar(payload, { minScore: 50, cluster: 'all', crowd: true });
    expect(d.minSmart).toBe(72);
    expect(d.minTop).toBe(99);
    expect(d.flagged.map((n) => n.id)).toEqual([2, 3, 4]);
    expect(d.top[0]!.id).toBe(3);
  });
  it('handles an empty graph', () => {
    const d = deriveRadar(undefined, { minScore: 50, cluster: 'all', crowd: true });
    expect(d.pass).toEqual([]);
    expect(d.minSmart).toBeNull();
    expect(d.minTop).toBeNull();
  });
});

describe('landing helpers', () => {
  it('picks the strongest open signals', () => {
    const items = [
      summary({ id: 'a', radar: { ...summary().radar, edge: 3 } }),
      summary({ id: 'b', radar: { ...summary().radar, edge: -9 } }),
      summary({ id: 'c', status: 'settled' }),
      summary({ id: 'd', radar: { ...summary().radar, state: 'building', edge: null } }),
    ];
    expect(signalMarkets(items, 2).map((m) => m.id)).toEqual(['b', 'a']);
  });
  it('top wallet and stats', () => {
    const g = { nodes: [node(1, 40), node(2, 90)] } as unknown as GraphPayload;
    expect(topWallet(g)?.id).toBe(2);
    expect(topWallet(null)).toBeNull();
    expect(graphStats(g)).toEqual({ wallets: 2, smart: 1 });
  });
});

describe('track record helpers', () => {
  it('buckets the lead histogram and scales bars to the largest', () => {
    const b = leadBuckets([
      { bucketMin: 0, count: 2 },
      { bucketMin: 10, count: 8 },
      { bucketMin: 30, count: 4 },
    ]);
    expect(b.map((x) => x.label)).toEqual(['<10', '10-30', '30+']);
    expect(b[1]!.h).toBe(1);
    expect(b[0]!.h).toBeCloseTo(0.25, 6);
    expect(leadBuckets([])).toEqual([]);
  });
  it('counts which side was closer', () => {
    const rows = [
      { marketId: 'a', question: null, radarT24: 0.6, marketT24: 0.5, outcome: 'above', closer: 'radar' },
      { marketId: 'b', question: null, radarT24: 0.6, marketT24: 0.5, outcome: 'above', closer: 'market' },
      { marketId: 'c', question: null, radarT24: 0.5, marketT24: 0.5, outcome: 'below', closer: 'tie' },
      { marketId: 'd', question: null, radarT24: null, marketT24: null, outcome: null, closer: null },
    ] as const;
    expect(closerStats([...rows] as never)).toEqual({ radar: 1, market: 1, tie: 1, total: 3 });
  });
});
