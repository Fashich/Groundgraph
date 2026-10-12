import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  buildQuestion,
  expectedArbLossUsdc,
  fairValueClose,
  fairValueTouch,
  formatPct,
  formatPrice,
  formatUsdc,
  impliedProbability,
  normCdf,
  parseAssetFeed,
  radarProbability,
  realizedVol,
  toOpeningBps,
  PYTH_FEEDS,
  feedIdFromHex,
  feedIdToHex,
  pythPushFeedAddress,
} from '../src/index';

describe('normCdf known values', () => {
  const known: [number, number][] = [
    [0, 0.5],
    [1, 0.8413447460685429],
    [-1, 0.15865525393145707],
    [1.96, 0.9750021048517795],
    [2.5, 0.9937903346742238],
    [-3, 0.0013498980316301],
    [5, 0.9999997133484281],
  ];
  it.each(known)('Phi(%f)', (x, p) => {
    expect(Math.abs(normCdf(x) - p)).toBeLessThan(1e-12);
  });
  it('is monotone and symmetric', () => {
    fc.assert(
      fc.property(fc.double({ min: -8, max: 8, noNaN: true }), fc.double({ min: -8, max: 8, noNaN: true }), (a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(normCdf(lo)).toBeLessThanOrEqual(normCdf(hi) + 1e-15);
        expect(Math.abs(normCdf(a) + normCdf(-a) - 1)).toBeLessThan(1e-14);
      }),
    );
  });
});

describe('fairValueClose', () => {
  it('at the money with zero drift is slightly below one half (volatility drag)', () => {
    const p = fairValueClose(100, 100, 0.8, 1 / 365);
    expect(p).toBeLessThan(0.5);
    expect(p).toBeGreaterThan(0.49);
  });
  it('known value: S=250, K=250, sigma=0.8, T=1d', () => {
    // d2 = -0.5 * 0.64 / 365 / (0.8 / sqrt(365)) = -0.5 * 0.8 / sqrt(365)
    const d2 = (-0.5 * 0.8) / Math.sqrt(365);
    expect(fairValueClose(250, 250, 0.8, 1 / 365)).toBeCloseTo(normCdf(d2), 12);
  });
  it('is deep in or out of the money far from the strike', () => {
    expect(fairValueClose(300, 200, 0.5, 1 / 365)).toBeGreaterThan(0.999);
    expect(fairValueClose(200, 300, 0.5, 1 / 365)).toBeLessThan(0.001);
  });
  it('degenerates to a step function at expiry', () => {
    expect(fairValueClose(101, 100, 0.8, 0)).toBe(1);
    expect(fairValueClose(100, 100, 0.8, 0)).toBe(0);
    expect(fairValueClose(99, 100, 0, 1)).toBe(0);
  });
  it('rejects non-positive spot or strike', () => {
    expect(() => fairValueClose(0, 100, 0.5, 1)).toThrow(RangeError);
    expect(() => fairValueClose(100, -1, 0.5, 1)).toThrow(RangeError);
  });
  it('stays in [0, 1] and increases with spot', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 1000, noNaN: true }),
        fc.double({ min: 1, max: 1000, noNaN: true }),
        fc.double({ min: 0.05, max: 3, noNaN: true }),
        fc.double({ min: 0.0001, max: 2, noNaN: true }),
        (s, k, v, t) => {
          const p = fairValueClose(s, k, v, t);
          expect(p).toBeGreaterThanOrEqual(0);
          expect(p).toBeLessThanOrEqual(1);
          expect(fairValueClose(s * 1.01, k, v, t)).toBeGreaterThanOrEqual(p);
        },
      ),
    );
  });
});

describe('fairValueTouch', () => {
  it('known value: strike 1 sigma away', () => {
    // |ln(K/S)| = sigma sqrt(T) -> 2 (1 - Phi(1)) = 0.31731050786291415
    const sigma = 0.5;
    const t = 0.25;
    const s = 100;
    const k = s * Math.exp(sigma * Math.sqrt(t));
    expect(fairValueTouch(s, k, sigma, t, 'up')).toBeCloseTo(0.31731050786291415, 10);
    expect(fairValueTouch(s, k, sigma, t, 'down')).toBeCloseTo(1 - 0.31731050786291415, 10);
  });
  it('caps the touch probability at 0.99', () => {
    expect(fairValueTouch(100, 100, 0.5, 1, 'up')).toBe(0.99);
  });
});

describe('expectedArbLossUsdc', () => {
  it('is zero when the market opens at the fair price of one half', () => {
    expect(expectedArbLossUsdc(1_000_000_000n, 0.5)).toBe(0n);
  });
  it('known value: p* = 0.2 loses 20% of liquidity', () => {
    // 1 - 2 sqrt(0.2 * 0.8) = 0.2
    expect(expectedArbLossUsdc(1_000_000_000n, 0.2)).toBe(200_000_000n);
  });
  it('is the whole liquidity at certainty', () => {
    expect(expectedArbLossUsdc(500_000_000n, 1)).toBe(500_000_000n);
  });
});

describe('radarProbability', () => {
  const flagged = (n: number, side: 'above' | 'below', hit: number, pos = 10_000, sybil = false) =>
    Array.from({ length: n }, () => ({ positionUsd: pos, side, hitRate: hit, sybil }));

  it('is "building" with fewer than three flagged wallets', () => {
    expect(radarProbability({ pMarket: 0.4, flagged: flagged(2, 'above', 0.8) })).toEqual({ state: 'building', p: null, ci: null, edge: null, n: 2 });
    expect(radarProbability({ pMarket: 0.4, flagged: [] }).state).toBe('building');
  });
  it('known value: four sharp wallets all on ABOVE', () => {
    const r = radarProbability({ pMarket: 0.5, flagged: flagged(4, 'above', 0.7) });
    // sy = 1, hr = 0.7, sig = 1 * 0.4 = 0.4; logit = 1.4 * 4/10 * 0.4 = 0.224; p = 1 / (1 + e^-0.224)
    const p = 1 / (1 + Math.exp(-0.224));
    expect(r.state).toBe('ready');
    expect(r.p).toBeCloseTo(p, 12);
    expect(r.edge).toBe(Math.round(100 * (p - 0.5)));
    expect(r.ci).toBe(Math.max(2, Math.round(164 * Math.sqrt((p * (1 - p)) / 26))));
    expect(r.n).toBe(4);
  });
  it('moves toward BELOW when the sharp money is on BELOW', () => {
    const r = radarProbability({ pMarket: 0.5, flagged: flagged(5, 'below', 0.8) });
    expect(r.p!).toBeLessThan(0.5);
    expect(r.edge!).toBeLessThan(0);
  });
  it('does not move when wallets have a hit rate of one half (no skill signal)', () => {
    const r = radarProbability({ pMarket: 0.37, flagged: flagged(6, 'above', 0.5) });
    expect(r.p!).toBeCloseTo(0.37, 12);
    expect(r.edge).toBe(0);
  });
  it('down-weights sybil wallets', () => {
    const mixed = [...flagged(3, 'above', 0.8, 10_000, true), ...flagged(3, 'below', 0.8, 10_000, false)];
    const r = radarProbability({ pMarket: 0.5, flagged: mixed });
    expect(r.p!).toBeLessThan(0.5);
  });
  it('is bounded and symmetric under side flip', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 0.99, noNaN: true }),
        fc.array(fc.record({ positionUsd: fc.double({ min: 0, max: 1e6, noNaN: true }), side: fc.constantFrom('above' as const, 'below' as const), hitRate: fc.double({ min: 0, max: 1, noNaN: true }), sybil: fc.boolean() }), { minLength: 3, maxLength: 20 }),
        (pm, fl) => {
          const r = radarProbability({ pMarket: pm, flagged: fl });
          if (r.state === 'ready') {
            expect(r.p!).toBeGreaterThan(0);
            expect(r.p!).toBeLessThan(1);
            expect(r.ci!).toBeGreaterThanOrEqual(2);
            const flipped = radarProbability({ pMarket: 1 - pm, flagged: fl.map((f) => ({ ...f, side: f.side === 'above' ? ('below' as const) : ('above' as const) })) });
            expect(flipped.p!).toBeCloseTo(1 - r.p!, 9);
          }
        },
      ),
    );
  });
});

describe('formatting and helpers', () => {
  it('formatUsdc truncates and groups', () => {
    expect(formatUsdc(12_345_678n)).toBe('12.34');
    expect(formatUsdc(-1_999_999n)).toBe('-1.99');
    expect(formatUsdc(1_234_567_890n, { grouping: true, symbol: true })).toBe('$1,234.56');
    expect(formatUsdc(5n, { decimals: 6 })).toBe('0.000005');
    expect(formatUsdc(7_000_000n, { decimals: 0 })).toBe('7');
  });
  it('formatPct and formatPrice', () => {
    expect(formatPct(0.424)).toBe('42%');
    expect(formatPrice(0.424)).toBe('42c');
    expect(formatPrice(0.005)).toBe('1c');
  });
  it('impliedProbability clamps', () => {
    expect(impliedProbability(0.42)).toBe(0.42);
    expect(impliedProbability(1.2)).toBe(1);
    expect(impliedProbability(-1)).toBe(0);
  });
  it('realizedVol of a flat series is zero and of a doubling series is large', () => {
    expect(realizedVol([10, 10, 10, 10])).toBe(0);
    expect(realizedVol([100, 101, 99, 102, 98], 365)).toBeGreaterThan(0.5);
    expect(realizedVol([1, 2])).toBe(0);
  });
  it('toOpeningBps clamps to the program bounds', () => {
    expect(toOpeningBps(0)).toBe(200);
    expect(toOpeningBps(1)).toBe(9800);
    expect(toOpeningBps(0.4249)).toBe(4249);
  });
});

describe('buildQuestion', () => {
  it('close wording matches the contract', () => {
    expect(buildQuestion({ assetSymbol: 'SOL', kind: 'close', targetPrice: 250, settleTs: Date.UTC(2026, 9, 31, 20) / 1000 })).toBe('SOL above or below $250 at the Oct 31 close?');
    expect(buildQuestion({ assetSymbol: 'BTC', kind: 'close', targetPrice: 100000, settleTs: Date.UTC(2026, 0, 5) / 1000 })).toBe('BTC above or below $100,000 at the Jan 5 close?');
    expect(buildQuestion({ assetSymbol: 'BONK', kind: 'close', targetPrice: 0.00002345, settleTs: Date.UTC(2026, 11, 1) / 1000 })).toBe('BONK above or below $0.00002345 at the Dec 1 close?');
  });
  it('touch wording', () => {
    const ts = Date.UTC(2026, 9, 20) / 1000;
    expect(buildQuestion({ assetSymbol: 'ETH', kind: 'touch', direction: 'down', targetPrice: 3800, settleTs: ts })).toBe('ETH before Oct 20: holds above $3,800 or breaks below?');
    expect(buildQuestion({ assetSymbol: 'ETH', kind: 'touch', direction: 'up', targetPrice: 3800, settleTs: ts })).toBe('ETH before Oct 20: holds below $3,800 or breaks above?');
  });
});

describe('pyth feeds', () => {
  it('has the six launch assets with 32 byte ids', () => {
    expect(Object.keys(PYTH_FEEDS).sort()).toEqual(['BONK', 'BTC', 'ETH', 'JUP', 'SOL', 'WIF']);
    for (const f of Object.values(PYTH_FEEDS)) expect(feedIdFromHex(f.feedIdHex)).toHaveLength(32);
  });
  it('parseAssetFeed accepts tickers and pair symbols', () => {
    expect(parseAssetFeed('sol')?.symbol).toBe('SOL/USD');
    expect(parseAssetFeed('BTC/USD')?.feedIdHex).toBe(PYTH_FEEDS.BTC!.feedIdHex);
    expect(parseAssetFeed('DOGE')).toBeUndefined();
    expect(parseAssetFeed('toString')).toBeUndefined();
  });
  it('feed id hex helpers round-trip and validate', () => {
    const id = feedIdFromHex('0x' + PYTH_FEEDS.ETH!.feedIdHex);
    expect(feedIdToHex(id)).toBe(PYTH_FEEDS.ETH!.feedIdHex);
    expect(() => feedIdFromHex('abcd')).toThrow(TypeError);
  });
  it('pythPushFeedAddress is a deterministic PDA of the push oracle program', () => {
    const a = pythPushFeedAddress(PYTH_FEEDS.SOL!.feedIdHex);
    expect(a.toBase58()).toBe(pythPushFeedAddress(PYTH_FEEDS.SOL!.feedIdHex, 0).toBase58());
    expect(a.equals(pythPushFeedAddress(PYTH_FEEDS.SOL!.feedIdHex, 1))).toBe(false);
  });
});
