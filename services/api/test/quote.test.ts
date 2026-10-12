import { applySlippage, feeBpsNow, priceAbove, quoteBuy, quoteSell } from '@groundgraph/svc-core';
import { simulateBuy, simulateSell } from '@groundgraph/sdk';
import { Keypair } from '@solana/web3.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeHarness, seedMarket, setOracle, signIn, type Harness } from './helpers';

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
  await setOracle(h, 'SOL');
});
afterAll(async () => {
  await h.close();
});

const q = (id: string, qs: string, cookie?: string) => h.app.inject({ url: `/markets/${id}/quote?${qs}`, headers: cookie ? { cookie } : {} });

describe('GET /markets/:id/quote equals the SDK / program math', () => {
  for (const [p0, dynamic, base] of [[2100, false, 100], [5000, true, 50], [9000, true, 200], [500, false, 100]] as const) {
    it(`buy and sell at p0=${p0} dynamic=${dynamic} base=${base}`, async () => {
      const m = await seedMarket(h, { p0Bps: p0, dynamicFee: dynamic, baseFeeBps: base, liquidity: 750_000_000n });
      const nowSec = Math.floor(h.nowMs() / 1000);
      const fee = feeBpsNow({ baseFeeBps: base, dynamicFee: dynamic, emaImpactBps: 0, emaTs: nowSec, settleTs: m.chain.settleTs, maxFeeBps: 300 }, nowSec);
      const pool = { reserveAbove: m.chain.reserveAbove, reserveBelow: m.chain.reserveBelow };
      for (const side of ['above', 'below'] as const) {
        for (const amount of [1_000_000n, 7_500_000n, 123_456_789n, 40_000_000_000n]) {
          const r = await q(m.id, `side=${side}&dir=buy&amount=${amount}&slippageBps=75`);
          expect(r.statusCode, `${side} ${amount}`).toBe(200);
          const body = r.json();
          const exp = quoteBuy(pool, side, amount, fee.totalBps);
          expect(body.amountOut).toBe(exp.sharesOut.toString());
          expect(body.feeUsdc).toBe(exp.feeUsdc.toString());
          expect(body.feeBps).toBe(fee.totalBps);
          expect(body.minOut).toBe(applySlippage(exp.sharesOut, 75).toString());
          expect(body.settleValue).toBe(exp.sharesOut.toString());
          expect(body.slippageBps).toBe(75);
          // identical to the SDK's full simulation of the instruction as well
          const sim = simulateBuy(
            Object.assign({}, m.chain.raw, { emaTs: BigInt(nowSec) }) as never, 300, side, amount, nowSec,
          );
          expect(sim.quote.sharesOut.toString()).toBe(body.amountOut);
          const priceBefore = side === 'above' ? priceAbove(pool) : 1 - priceAbove(pool);
          expect(body.priceBefore).toBeCloseTo(priceBefore, 12);
        }
        for (const shares of [2_000_000n, 55_000_000n]) {
          const r = await q(m.id, `side=${side}&dir=sell&amount=${shares}`);
          expect(r.statusCode).toBe(200);
          const exp = quoteSell(pool, side, shares, fee.totalBps);
          expect(r.json().amountOut).toBe(exp.usdcOut.toString());
          expect(r.json().feeUsdc).toBe(exp.feeUsdc.toString());
          expect(r.json().settleValue).toBeNull();
          expect(r.json().slippageBps).toBe(100);
          const sim = simulateSell(Object.assign({}, m.chain.raw, { emaTs: BigInt(nowSec) }) as never, 300, side, shares, nowSec);
          expect(sim.quote.usdcOut.toString()).toBe(r.json().amountOut);
        }
      }
    });
  }

  it('amountIn echoes the request and the avg price is amountIn / amountOut', async () => {
    const m = await seedMarket(h);
    const r = (await q(m.id, 'side=above&dir=buy&amount=10000000')).json();
    expect(r.amountIn).toBe('10000000');
    expect(r.avgPrice).toBeCloseTo(10_000_000 / Number(r.amountOut), 10);
    expect(r.avgPrice).toBeGreaterThan(r.priceBefore);
    expect(r.priceAfter).toBeGreaterThan(r.priceBefore);
    expect(r.marketId).toBe(m.id);
  });

  it('refuses amounts the program would reject', async () => {
    const m = await seedMarket(h);
    const small = await q(m.id, 'side=above&dir=buy&amount=500000');
    expect(small.statusCode).toBe(400);
    expect(small.json().error.code).toBe('below_min_trade');
    expect((await q(m.id, 'side=above&dir=buy&amount=0')).statusCode).toBe(400);
    expect((await q(m.id, 'side=above&dir=sell&amount=10')).json().error.code).toBe('below_min_trade');
    expect((await q(m.id, 'side=maybe&dir=buy&amount=5000000')).statusCode).toBe(400);
    const huge = await q(m.id, `side=above&dir=sell&amount=${10n ** 18n}`);
    // the math is bounded by the pool: even absurd share counts can never pay out more than the opposite reserve
    expect(huge.statusCode).toBe(200);
    expect(BigInt(huge.json().amountOut)).toBeLessThan(m.chain.reserveBelow);
    expect((await q(Keypair.generate().publicKey.toBase58(), 'side=above&dir=buy&amount=5000000')).statusCode).toBe(404);
  });

  it('a closed market cannot be bought but a sell quote still works', async () => {
    const m = await seedMarket(h, { tradingEndInSecs: -5, settleInSecs: 3000 });
    expect((await q(m.id, 'side=above&dir=buy&amount=5000000')).json().error.code).toBe('market_closed');
    expect((await q(m.id, 'side=above&dir=sell&amount=5000000')).statusCode).toBe(200);
    const settled = await seedMarket(h, { status: 'settled', outcome: 'below' });
    expect((await q(settled.id, 'side=above&dir=sell&amount=5000000')).json().error.code).toBe('market_closed');
  });

  it('adds responsible-trading, oracle and balance warnings for a signed-in buyer', async () => {
    const m = await seedMarket(h, { tradingEndInSecs: 3 * 86400, settleInSecs: 4 * 86400 });
    const s = await signIn(h);
    const high = await q(m.id, 'side=above&dir=buy&amount=300000000&slippageBps=1', s.cookie);
    expect(high.json().warnings).toContain('exceeds_slippage');
    h.chain.defaultBalance = 20_000_000n;
    try {
      expect((await q(m.id, 'side=above&dir=buy&amount=10000000', s.cookie)).json().warnings).toContain('large_vs_balance');
    } finally {
      h.chain.defaultBalance = 100_000_000_000n;
    }
    await h.app.inject({ method: 'PUT', url: '/me/settings', headers: { cookie: s.cookie }, payload: { dailyLimitUsdc: '5000000', sessionReminder: false } });
    expect((await q(m.id, 'side=above&dir=buy&amount=10000000', s.cookie)).json().warnings).toContain('daily_limit');
    await h.app.inject({ method: 'POST', url: '/me/break', headers: { cookie: s.cookie }, payload: { days: 1 } });
    expect((await q(m.id, 'side=above&dir=buy&amount=1000000', s.cookie)).json().warnings).toContain('break_active');
    await setOracle(h, 'SOL', { ageSec: 200 });
    expect((await q(m.id, 'side=above&dir=buy&amount=1000000')).json().warnings).toContain('oracle_stale');
    expect((await q(m.id, 'side=above&dir=sell&amount=5000000', s.cookie)).json().warnings).toEqual([]);
    await setOracle(h, 'SOL');
  });

  it('falls back to the indexed state for READ-ONLY quotes when the RPC is down', async () => {
    const m = await seedMarket(h);
    h.chain.failReads = true;
    try {
      const r = await q(m.id, 'side=above&dir=buy&amount=5000000');
      expect(r.statusCode).toBe(200);
      const s = await signIn(h);
      const tx = await h.app.inject({ method: 'POST', url: '/tx/buy', headers: { cookie: s.cookie }, payload: { marketId: m.id, side: 'above', amount: '5000000' } });
      expect(tx.statusCode).toBe(502); // building a transaction always needs the chain account
    } finally {
      h.chain.failReads = false;
    }
  });
});
