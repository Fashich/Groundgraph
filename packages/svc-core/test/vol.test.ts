import { describe, expect, it } from 'vitest';
import { closeProviders, computeVol, fetchDailyCloses, realizedVolAnnual } from '../src/vol';

describe('realizedVolAnnual', () => {
  it('matches a hand computed example', () => {
    // alternating +1% / -1% daily log returns have stdev 0.01 (sample), annualised with sqrt(365)
    const closes = [100];
    for (let i = 0; i < 30; i++) closes.push(closes[i]! * Math.exp(i % 2 === 0 ? 0.01 : -0.01));
    const v = realizedVolAnnual(closes);
    expect(v).toBeCloseTo(0.01 * Math.sqrt(365) * Math.sqrt(30 / 29) * 1.0, 1);
  });
  it('is clamped to a sane band', () => {
    expect(realizedVolAnnual(Array.from({ length: 31 }, () => 100))).toBe(0.05);
    const wild = Array.from({ length: 31 }, (_, i) => (i % 2 ? 100 : 1000));
    expect(realizedVolAnnual(wild)).toBe(6);
  });
  it('needs enough data', () => {
    expect(() => realizedVolAnnual([1, 2, 3])).toThrow(/not enough/);
  });
});

describe('fetchDailyCloses', () => {
  const day = 86_400;
  const nowSec = 1_800_000_000 + 3600;
  const today = nowSec - (nowSec % day);
  const coinbase = Array.from({ length: 33 }, (_, i) => [today - i * day, 0, 0, 0, 100 + i, 1]);

  it('drops the incomplete current day and keeps the last 31 closes oldest first', async () => {
    const closes = await closeProviders['coinbase']!('SOL', (async () => new Response(JSON.stringify(coinbase))) as typeof fetch, nowSec);
    expect(closes).toHaveLength(31);
    // today's candle (close 100) is dropped; the oldest of the 31 kept is 31 days back (close 131), the newest is yesterday (close 101)
    expect([closes[0], closes[30]]).toEqual([131, 101]);
  });

  it('falls through providers in order until one has enough data', async () => {
    const order: string[] = [];
    const f = (async (url: string) => {
      const host = new URL(url).host;
      order.push(host);
      if (host.includes('coinbase')) return new Response('x', { status: 429 });
      if (host.includes('kraken')) return new Response(JSON.stringify({ error: [], result: { XSOLUSD: [[today - day, '1', '1', '1', '150', '1', '1', 1]], last: 1 } }));
      if (host.includes('binance')) return new Response(JSON.stringify(Array.from({ length: 33 }, (_, i) => [(today - (33 - i) * day) * 1000, '1', '1', '1', String(120 + i)])));
      return new Response('x', { status: 500 });
    }) as typeof fetch;
    const r = await fetchDailyCloses('SOL', 'ab', { fetchImpl: f, nowSec });
    expect(r.source).toBe('binance');
    expect(order).toEqual(['api.exchange.coinbase.com', 'api.kraken.com', 'data-api.binance.vision']);
    expect(r.closes.length).toBeGreaterThanOrEqual(20);
  });

  it('reports every provider failure when none works', async () => {
    const f = (async () => new Response('x', { status: 500 })) as typeof fetch;
    await expect(fetchDailyCloses('SOL', 'ab', { fetchImpl: f, nowSec })).rejects.toThrow(/coinbase.*kraken.*binance.*coingecko/s);
  });

  it('computeVol returns a snapshot', async () => {
    const f = (async () => new Response(JSON.stringify(coinbase.map((c, i) => [c[0], 0, 0, 0, 100 + (i % 3) * 2, 1])))) as typeof fetch;
    const snap = await computeVol('SOL', 'feed', { fetchImpl: f, nowSec });
    expect(snap).toMatchObject({ feedId: 'feed', source: 'coinbase', nCloses: 31 });
    expect(snap.vol).toBeGreaterThan(0.05);
  });
});
