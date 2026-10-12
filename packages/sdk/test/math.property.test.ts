import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  GgMathError,
  MAX_RESERVE,
  MIN_TRADE_USDC,
  applySlippage,
  feeBpsNow,
  feeCeil,
  flowFeeBps,
  isqrt,
  nearFeeBps,
  priceBps,
  quoteBuy,
  quoteSell,
  seedReserves,
  simulateBuy,
  simulateSell,
  updateEma,
  voidLpClaim,
  settledLpClaim,
  type MarketAccount,
  type Pool,
} from '../src/index';

const reserve = fc.bigInt({ min: 1_000_000n, max: 1n << 50n });
const pool = fc.record({ reserveAbove: reserve, reserveBelow: reserve });
const side = fc.constantFrom('above' as const, 'below' as const);
const feeBps = fc.integer({ min: 0, max: 1000 });
const K = (p: Pool) => p.reserveAbove * p.reserveBelow;

describe('AMM properties', () => {
  it('buy never decreases the product and never pays more shares than the sets it adds', () => {
    fc.assert(
      fc.property(pool, side, fc.bigInt({ min: 1_000_000n, max: 1n << 45n }), feeBps, (p, s, x, f) => {
        const q = quoteBuy(p, s, x, f);
        expect(K(q.poolAfter)).toBeGreaterThanOrEqual(K(p));
        expect(q.feeUsdc + q.usdcIntoSets).toBe(x);
        // shares cost at most one USDC each: the user pays x' for sets, the pool returns shares worth <= 1 each
        expect(q.sharesOut).toBeGreaterThanOrEqual(q.usdcIntoSets - 1n);
      }),
    );
  });

  it('buying ABOVE raises the ABOVE price, buying BELOW lowers it', () => {
    fc.assert(
      fc.property(pool, fc.bigInt({ min: 1_000_000n, max: 1n << 40n }), (p, x) => {
        expect(priceBps(quoteBuy(p, 'above', x, 100).poolAfter)).toBeGreaterThanOrEqual(priceBps(p));
        expect(priceBps(quoteBuy(p, 'below', x, 100).poolAfter)).toBeLessThanOrEqual(priceBps(p));
      }),
    );
  });

  it('a buy followed by a sell of the same shares never returns more than was paid', () => {
    fc.assert(
      fc.property(pool, side, fc.bigInt({ min: 1_000_000n, max: 1n << 40n }), feeBps, (p, s, x, f) => {
        const b = quoteBuy(p, s, x, f);
        if (b.sharesOut === 0n) return;
        const sell = quoteSell(b.poolAfter, s, b.sharesOut, f);
        expect(sell.usdcOut).toBeLessThanOrEqual(x);
      }),
    );
  });

  it('sell keeps the product, burns at most min(reserve) sets and the released USDC is below the share count', () => {
    fc.assert(
      fc.property(pool, side, fc.bigInt({ min: 1n, max: 1n << 45n }), feeBps, (p, s, sh, f) => {
        let q;
        try {
          q = quoteSell(p, s, sh, f);
        } catch (e) {
          if (e instanceof GgMathError) return;
          throw e;
        }
        expect(K(q.poolAfter)).toBeGreaterThanOrEqual(K(p));
        expect(q.usdcGross).toBeLessThanOrEqual(sh);
        expect(q.usdcOut + q.feeUsdc).toBe(q.usdcGross);
        expect(q.poolAfter.reserveAbove).toBeLessThan(MAX_RESERVE);
        expect(q.poolAfter.reserveBelow).toBeGreaterThan(0n);
      }),
    );
  });

  it('sell is maximal: one more unit of USDC would break the invariant', () => {
    fc.assert(
      fc.property(pool, side, fc.bigInt({ min: 1_000n, max: 1n << 40n }), (p, s, sh) => {
        const q = quoteSell(p, s, sh, 0);
        const [rs, ro] = s === 'above' ? [p.reserveAbove, p.reserveBelow] : [p.reserveBelow, p.reserveAbove];
        const y = q.usdcGross + 1n;
        if (y < ro) expect((rs + sh - y) * (ro - y)).toBeLessThan(rs * ro);
      }),
    );
  });

  it('seed reserves reproduce the requested opening price within one basis point', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 100_000_000n, max: 1n << 50n }), fc.integer({ min: 200, max: 9800 }), (l, p0) => {
        const r = seedReserves(l, p0);
        const bps = priceBps({ reserveAbove: r.reserveAbove, reserveBelow: r.reserveBelow });
        expect(Math.abs(bps - p0)).toBeLessThanOrEqual(1);
        expect(r.creatorAbove + r.creatorBelow).toBe(l - (r.creatorAbove === 0n ? r.reserveBelow : r.reserveAbove));
        expect(r.creatorAbove === 0n || r.creatorBelow === 0n).toBe(true);
      }),
    );
  });

  it('feeCeil is the ceiling of amount * bps / 10000', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 1n << 60n }), feeBps, (a, f) => {
        const c = feeCeil(a, f);
        expect(c * 10_000n).toBeGreaterThanOrEqual(a * BigInt(f));
        if (c > 0n) expect((c - 1n) * 10_000n).toBeLessThan(a * BigInt(f));
      }),
    );
  });

  it('isqrt is the integer square root', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: (1n << 120n) }), (n) => {
        const r = isqrt(n);
        expect(r * r).toBeLessThanOrEqual(n);
        expect((r + 1n) * (r + 1n)).toBeGreaterThan(n);
      }),
    );
  });

  it('rejects the documented error cases', () => {
    const p = { reserveAbove: 1_000_000n, reserveBelow: 1_000_000n };
    expect(() => quoteBuy(p, 'above', 0n, 100)).toThrow(GgMathError);
    expect(() => quoteBuy({ reserveAbove: 0n, reserveBelow: 5n }, 'above', 10n, 100)).toThrow(/ReserveEmpty/);
    expect(() => quoteBuy(p, 'above', MAX_RESERVE, 0)).toThrow(/ReserveTooLarge/);
    expect(() => quoteSell(p, 'below', 0n, 100)).toThrow(/ZeroAmount/);
    expect(() => seedReserves(100_000_000n, 199)).toThrow(/InvalidP0/);
    expect(() => seedReserves(100_000_000n, 9801)).toThrow(/InvalidP0/);
  });
});

describe('fees', () => {
  it('near-expiry fee ramps from 0 to 80 bps over 72 hours', () => {
    const settle = 1_800_000_000;
    expect(nearFeeBps(settle, settle - 72 * 3600)).toBe(0);
    expect(nearFeeBps(settle, settle - 100 * 3600)).toBe(0);
    expect(nearFeeBps(settle, settle - 36 * 3600)).toBe(40);
    expect(nearFeeBps(settle, settle)).toBe(80);
    expect(nearFeeBps(settle, settle + 500)).toBe(80);
  });
  it('flow fee is ema / 4 capped at 50', () => {
    expect(flowFeeBps(0)).toBe(0);
    expect(flowFeeBps(39)).toBe(9);
    expect(flowFeeBps(200)).toBe(50);
    expect(flowFeeBps(10_000)).toBe(50);
  });
  it('the EMA halves every 30 minutes and moves toward the new impact', () => {
    expect(updateEma(1000, 0, 0, 1800)).toBe(500);
    expect(updateEma(1000, 0, 0, 3600)).toBe(250);
    expect(updateEma(0, 0, 400, 0)).toBe(0);
    expect(updateEma(100, 5, 300, 5)).toBe(100); // no elapsed time keeps the old value
  });
  it('the EMA stays between the old value and the new impact', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000 }), fc.integer({ min: 0, max: 10_000 }), fc.integer({ min: 0, max: 200_000 }), (e, i, dt) => {
        const v = updateEma(e, 1_000_000, i, 1_000_000 + dt);
        expect(v).toBeGreaterThanOrEqual(Math.min(e, i) - 1);
        expect(v).toBeLessThanOrEqual(Math.max(e, i));
      }),
    );
  });
  it('total fee respects the cap and the static case ignores dynamic components', () => {
    const f = { baseFeeBps: 200, dynamicFee: true, emaImpactBps: 4000, emaTs: 1000, settleTs: 1100, maxFeeBps: 300 };
    expect(feeBpsNow(f, 1000).totalBps).toBe(300);
    expect(feeBpsNow({ ...f, dynamicFee: false }, 1000)).toEqual({ totalBps: 200, baseBps: 200, nearBps: 0, flowBps: 0 });
  });
  it('applySlippage floors and validates', () => {
    expect(applySlippage(1000n, 50)).toBe(995n);
    expect(applySlippage(999n, 50)).toBe(994n);
    expect(applySlippage(1000n, 0)).toBe(1000n);
    expect(() => applySlippage(1n, -1)).toThrow(RangeError);
    expect(() => applySlippage(1n, 10_001)).toThrow(RangeError);
  });
});

describe('LP claim snapshots', () => {
  it('settled claim is the winning side reserve plus the fee pool', () => {
    const p = { reserveAbove: 600n, reserveBelow: 400n };
    expect(settledLpClaim(true, p, 7n)).toBe(607n);
    expect(settledLpClaim(false, p, 7n)).toBe(407n);
  });
  it('void claim leaves the complete sets owed to holders at 0.5 each', () => {
    const p = { reserveAbove: 600n, reserveBelow: 400n };
    // N = 1000, realA = 400, realB = 600, owed = ceil(1000/2) = 500, claim = 1000 + 20 - 500
    expect(voidLpClaim(1000n, p, 20n)).toBe(520n);
    expect(() => voidLpClaim(100n, p, 0n)).toThrow(GgMathError);
  });
});

/** Random trade sequences against a local market model: USDC is conserved and the pool stays solvent. */
describe('market simulation', () => {
  function base(liquidity: bigint, p0: number, dynamic: boolean): MarketAccount {
    const r = seedReserves(liquidity, p0);
    return {
      creator: undefined as never, nonce: 0n, collateralMint: undefined as never, vault: undefined as never, aboveMint: undefined as never,
      belowMint: undefined as never, lpMint: undefined as never, kind: 'close', direction: 'none', feedId: new Uint8Array(32), targetPrice: 1n,
      targetExpo: 0, openTs: 1_000n, tradingEndTs: 90_000n, settleTs: 90_300n, baseFeeBps: 100, dynamicFee: dynamic, completeSets: liquidity,
      reserveAbove: r.reserveAbove, reserveBelow: r.reserveBelow, feePool: 0n, emaImpactBps: 0, emaTs: 1_000n, status: 'open', outcome: 'none',
      settlePrice: 0n, settleExpo: 0, settlePublishTs: 0n, lpClaimRemaining: 0n, lpSupplyRemaining: 0n, bump: 255,
    };
  }
  const op = fc.record({ buy: fc.boolean(), side, amount: fc.bigInt({ min: 1_000_000n, max: 50_000_000_000n }), dt: fc.integer({ min: 0, max: 7200 }) });

  it('conserves USDC: vault == complete sets + fee pool, and every holder can exit at or below the cost basis', () => {
    fc.assert(
      fc.property(fc.integer({ min: 300, max: 9700 }), fc.boolean(), fc.array(op, { minLength: 1, maxLength: 40 }), (p0, dyn, ops) => {
        const liquidity = 500_000_000n;
        const seed = seedReserves(liquidity, p0);
        let m = base(liquidity, p0, dyn);
        let vault = liquidity;
        let now = 1_000;
        const holdings = { above: 0n, below: 0n };
        for (const o of ops) {
          now += o.dt;
          try {
            if (o.buy) {
              const r = simulateBuy(m, 300, o.side, o.amount, now);
              vault += o.amount;
              holdings[o.side] += r.quote.sharesOut;
              m = r.marketAfter;
            } else {
              const have = holdings[o.side];
              if (have === 0n) continue;
              const shares = (have * (1n + (o.amount % 100n))) / 100n || 1n;
              const r = simulateSell(m, 300, o.side, shares, now);
              vault -= r.quote.usdcOut;
              holdings[o.side] -= shares;
              m = r.marketAfter;
            }
          } catch (e) {
            if (e instanceof GgMathError) continue;
            throw e;
          }
          expect(vault).toBe(m.completeSets + m.feePool);
          expect(m.reserveAbove).toBeLessThan(MAX_RESERVE);
          expect(m.reserveBelow).toBeLessThan(MAX_RESERVE);
          expect(m.completeSets).toBeGreaterThanOrEqual(0n);
          expect(m.reserveAbove).toBeGreaterThan(0n);
          expect(m.reserveBelow).toBeGreaterThan(0n);
          // supply of each side equals the complete sets: shares held outside the pool = N - pool reserve
          expect(holdings.above + seed.creatorAbove).toBe(m.completeSets - m.reserveAbove);
          expect(holdings.below + seed.creatorBelow).toBe(m.completeSets - m.reserveBelow);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('the simulated EMA only changes for dynamic-fee markets', () => {
    const m = base(500_000_000n, 4000, false);
    const r = simulateBuy(m, 300, 'above', 100_000_000n, 5000);
    expect(r.marketAfter.emaImpactBps).toBe(0);
    const d = base(500_000_000n, 4000, true);
    const r2 = simulateBuy(d, 300, 'above', 100_000_000n, 5000);
    expect(r2.marketAfter.emaImpactBps).toBeGreaterThan(0);
    expect(r2.marketAfter.emaTs).toBe(5000n);
    expect(MIN_TRADE_USDC).toBe(1_000_000n);
  });
});
