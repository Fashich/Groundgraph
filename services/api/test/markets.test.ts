import { Keypair } from '@solana/web3.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeHarness, seedMarket, seedRadar, seedScoredPosition, seedTick, seedTrade, seedWallet, setOracle, signIn, type Harness } from './helpers';

let h: Harness;
let sol: Awaited<ReturnType<typeof seedMarket>>;
let btc: Awaited<ReturnType<typeof seedMarket>>;
let jup: Awaited<ReturnType<typeof seedMarket>>;
let done: Awaited<ReturnType<typeof seedMarket>>;

beforeAll(async () => {
  h = await makeHarness();
  await setOracle(h, 'SOL');
  sol = await seedMarket(h, { symbol: 'SOL', targetUsd: 250, settleInSecs: 40 * 3600, tradingEndInSecs: 39 * 3600 });
  btc = await seedMarket(h, { symbol: 'BTC', targetUsd: 100000, settleInSecs: 20 * 86400, tradingEndInSecs: 20 * 86400 - 3600, p0Bps: 6000 });
  jup = await seedMarket(h, { symbol: 'JUP', targetUsd: 0.9, settleInSecs: 60 * 86400, tradingEndInSecs: 60 * 86400 - 3600, p0Bps: 4000 });
  done = await seedMarket(h, { symbol: 'ETH', targetUsd: 3500, status: 'settled', outcome: 'above' });
  const w1 = await seedWallet(h, { score: 90 });
  const w2 = await seedWallet(h, { score: 88 });
  const w3 = await seedWallet(h, { score: 86 });
  for (const w of [w1, w2, w3]) await seedScoredPosition(h, sol.id, w);
  await seedRadar(h, sol.id, { p: 0.35, ci: 9, n: 3, edge: 9 });
  await seedTrade(h, sol.id, w1, { usdc: 30_000_000n });
  await seedTrade(h, sol.id, w2, { usdc: 5_000_000n, side: 'below', priceAfter: 0.2 });
  await seedTrade(h, btc.id, Keypair.generate().publicKey.toBase58(), { usdc: 900_000_000n });
  await seedTick(h, sol.id, 60 * 30, 0.30);
  await seedTick(h, sol.id, 60 * 25, 0.18);
  await seedTick(h, sol.id, 60, 0.2);
});
afterAll(async () => {
  await h.close();
});

const get = (url: string, cookie?: string) => h.app.inject({ url, headers: cookie ? { cookie } : {} });
const ids = (r: { json(): { items: { id: string }[] } }) => r.json().items.map((m) => m.id);

describe('GET /markets', () => {
  it('lists active markets with the MarketSummary shape', async () => {
    const r = await get('/markets');
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.nextCursor).toBeNull();
    expect(ids(r).sort()).toEqual([sol.id, btc.id, jup.id].sort());
    const m = body.items.find((x: { id: string }) => x.id === sol.id);
    expect(m).toMatchObject({
      assetSymbol: 'SOL', kind: 'close', direction: null, status: 'open', outcome: null, targetPrice: 250, baseFeeBps: 100, dynamicFee: false,
      category: 'Majors', creator: sol.creator, traders: 2, volume: '35000000', liquidity: '1000000000',
    });
    expect(m.priceAbove).toBeCloseTo(0.2099, 3);
    expect(m.implied).toBe(m.priceAbove);
    expect(m.feeBpsNow).toBe(100);
    expect(m.spark.length).toBeGreaterThanOrEqual(2);
    expect(m.spark.at(-1)).toBeCloseTo(m.priceAbove, 3);
    expect(m.ch24).toBeCloseTo((m.priceAbove - 0.18) * 100, 0); // vs the last tick older than 24h (25h ago)
    expect(m.radar).toMatchObject({ state: 'ready', p: 0.35, ci: 9, n: 3, edge: 9, modelVersion: 'gs-test-1' });
    expect(new Date(m.endsAt).getTime()).toBeGreaterThan(h.nowMs());
    expect(m.question).toContain('SOL');
    const jupItem = body.items.find((x: { id: string }) => x.id === jup.id);
    expect(jupItem.category).toBe('Solana ecosystem');
    expect(jupItem.radar.state).toBe('building');
  });

  it('filters by status, category, expiry, search, lean', async () => {
    expect(ids(await get('/markets?status=resolved'))).toEqual([done.id]);
    expect(ids(await get('/markets?status=all')).length).toBe(4);
    expect(ids(await get('/markets?status=settled'))).toEqual([done.id]);
    expect(ids(await get('/markets?cat=Majors')).sort()).toEqual([sol.id, btc.id].sort());
    expect(ids(await get('/markets?cat=Solana%20ecosystem'))).toEqual([jup.id]);
    expect(ids(await get('/markets?cat=Ratios'))).toEqual([]); // not available in this version
    expect(ids(await get('/markets?cat=High%20signal'))).toEqual([sol.id]);
    expect(ids(await get('/markets?ends=48h'))).toEqual([sol.id]);
    expect(ids(await get('/markets?ends=2w')).sort()).toEqual([sol.id].sort());
    expect(ids(await get('/markets?ends=long')).sort()).toEqual([btc.id, jup.id].sort());
    expect(ids(await get('/markets?q=jup'))).toEqual([jup.id]);
    expect(ids(await get('/markets?q=%25'))).toEqual([]); // wildcard characters are escaped
    expect(ids(await get('/markets?lean=above'))).toEqual([sol.id]);
    expect(ids(await get('/markets?lean=below'))).toEqual([]);
  });

  it('sorts and paginates with an opaque cursor', async () => {
    expect(ids(await get('/markets?sort=ending'))[0]).toBe(sol.id);
    expect(ids(await get('/markets?sort=volume'))[0]).toBe(btc.id);
    expect(ids(await get('/markets?sort=signal'))[0]).toBe(sol.id);
    const p1 = await get('/markets?limit=2&sort=ending');
    expect(p1.json().items).toHaveLength(2);
    expect(p1.json().nextCursor).toBe('o:2');
    const p2 = await get('/markets?limit=2&sort=ending&cursor=o:2');
    expect(p2.json().items).toHaveLength(1);
    expect(p2.json().nextCursor).toBeNull();
    expect(new Set([...ids(p1), ...ids(p2)]).size).toBe(3);
  });

  it('hidden markets are not listed', async () => {
    await h.sql`UPDATE markets SET hidden = true WHERE id = ${jup.id}`;
    expect(ids(await get('/markets'))).not.toContain(jup.id);
    await h.sql`UPDATE markets SET hidden = false WHERE id = ${jup.id}`;
  });

  it('?watch=true needs a session and returns only the watchlist', async () => {
    expect((await get('/markets?watch=true')).statusCode).toBe(401);
    const s = await signIn(h);
    expect(ids(await get('/markets?watch=true', s.cookie))).toEqual([]);
    const t = await h.app.inject({ method: 'POST', url: `/me/watch/${btc.id}`, headers: { cookie: s.cookie } });
    expect(t.json()).toEqual({ watching: true });
    expect(ids(await get('/markets?watch=true', s.cookie))).toEqual([btc.id]);
    expect((await h.app.inject({ method: 'POST', url: `/me/watch/${btc.id}`, headers: { cookie: s.cookie } })).json()).toEqual({ watching: false });
  });

  it('shows trading_closed once trading_end_ts passed, derived from the clock', async () => {
    const closing = await seedMarket(h, { tradingEndInSecs: 100, settleInSecs: 4000, symbol: 'WIF', targetUsd: 2 });
    h.advance(200_000);
    try {
      const r = (await get('/markets?status=trading_closed')).json();
      expect(r.items.map((m: { id: string }) => m.id)).toContain(closing.id);
      expect(r.items.find((m: { id: string }) => m.id === closing.id).status).toBe('trading_closed');
      expect(ids(await get('/markets?status=open'))).not.toContain(closing.id);
    } finally {
      h.advance(-200_000);
    }
  });
});

describe('GET /markets/:id', () => {
  it('returns the full MarketDetail', async () => {
    const r = await get(`/markets/${sol.id}`);
    expect(r.statusCode).toBe(200);
    const d = r.json();
    expect(d.id).toBe(sol.id);
    expect(d.pool).toMatchObject({ reserveAbove: '1000000000', reserveBelow: '265822784', completeSets: '1000000000', feePool: '0', vault: sol.chain.vault, aboveMint: sol.chain.aboveMint, belowMint: sol.chain.belowMint, lpMint: sol.chain.lpMint });
    expect(d.feeBreakdown).toEqual({ baseBps: 100, nearBps: 0, flowBps: 0, totalBps: 100, capBps: 300 });
    expect(d.rules.oracleFeedId).toBe(sol.chain.feedIdHex);
    expect(d.rules.text).toMatch(/strictly above \$250/);
    expect(d.rules.settleRule).toMatch(/\$0\.50/);
    expect(d.oracle).toMatchObject({ symbol: 'SOL/USD', price: 213.93, stale: false });
    expect(d.history.tf).toBe('1D');
    expect(d.history.points.length).toBeGreaterThanOrEqual(2);
    expect(d.flaggedEntries).toHaveLength(3);
    expect(d.flaggedEntries[0]).toMatchObject({ side: 'above', priceAtEntry: 0.21, usdc: '50000000' });
    expect(d.fairValue).toMatchObject({ spot: 213.93, vol: 0.6 });
    expect(d.fairValue.pAbove).toBeGreaterThan(0);
    expect(d.fairValue.pAbove).toBeLessThan(0.5);
    expect(d.settlePrice).toBeNull();
  });

  it('history honours the timeframe', async () => {
    const day = (await get(`/markets/${sol.id}?tf=1D`)).json().history.points;
    const all = (await get(`/markets/${sol.id}?tf=ALL`)).json().history.points;
    expect(all.length).toBeGreaterThanOrEqual(day.length);
    expect((await get(`/markets/${sol.id}?tf=9Y`)).statusCode).toBe(400);
  });

  it('a settled market has no fair value and shows its outcome', async () => {
    const d = (await get(`/markets/${done.id}`)).json();
    expect(d.status).toBe('settled');
    expect(d.outcome).toBe('above');
    expect(d.fairValue).toBeNull();
  });

  it('404 for an unknown market, 400 for a malformed id', async () => {
    expect((await get(`/markets/${Keypair.generate().publicKey.toBase58()}`)).statusCode).toBe(404);
    expect((await get('/markets/short')).statusCode).toBe(400);
  });

  it('reports a stale oracle on the detail', async () => {
    await setOracle(h, 'SOL', { ageSec: 400 });
    try {
      expect((await get(`/markets/${sol.id}`)).json().oracle.stale).toBe(true);
    } finally {
      await setOracle(h, 'SOL');
    }
  });
});

describe('wallets, trades, fair value, assets', () => {
  it('GET /markets/:id/wallets ranks flagged wallets with side prices', async () => {
    const r = (await get(`/markets/${sol.id}/wallets`)).json();
    expect(r.map((w: { score: number }) => w.score)).toEqual([90, 88, 86]);
    expect(r[0]).toMatchObject({ smart: true, side: 'above', entryPrice: 0.21, usdc: '50000000', sybil: false });
    expect(r[0].features).toMatchObject({ whaleOverlap: 0.6, hitRate: 0.65, leadTimeMin: 42, nMarkets: 12 });
  });

  it('a wallet that opted out is hidden from every radar surface', async () => {
    const hidden = await seedWallet(h, { score: 99, hidden: true });
    await seedScoredPosition(h, sol.id, hidden, { side: 'below' });
    expect((await get(`/markets/${sol.id}/wallets`)).json().map((w: { address: string }) => w.address)).not.toContain(hidden);
    expect((await get(`/markets/${sol.id}`)).json().flaggedEntries.map((e: { wallet: string }) => e.wallet)).not.toContain(hidden);
    const wd = await get(`/wallets/${hidden}`);
    expect(wd.statusCode).toBe(200);
    expect(wd.json()).toMatchObject({ labelHidden: true, score: 0, smart: false, top: false, reasons: [], tags: [], openPositions: [] });
    const g = (await get('/radar/wallets')).json();
    expect(g.nodes.map((n: { addr: string }) => n.addr)).not.toContain(hidden);
  });

  it('GET /markets/:id/trades pages newest first with an id cursor', async () => {
    const p1 = (await get(`/markets/${sol.id}/trades?limit=1`)).json();
    expect(p1.items).toHaveLength(1);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = (await get(`/markets/${sol.id}/trades?limit=1&cursor=${p1.nextCursor}`)).json();
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    expect(p1.items[0].id).not.toBe(p2.items[0].id);
    expect(p1.items[0]).toMatchObject({ dir: 'buy', shares: '45000000', feeUsdc: '100000', flagged: true });
    expect(p1.items[0].usdc).toBe('5000000'); // same timestamp, higher id first
    expect(p2.items[0].usdc).toBe('30000000');
  });

  it('GET /fair-value computes from the oracle and cached volatility', async () => {
    const r = await get(`/fair-value?asset=SOL&target=250&settleTs=${encodeURIComponent(new Date(h.nowMs() + 30 * 86400_000).toISOString())}`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ spot: 213.93, vol: 0.6 });
    const atTheMoney = (await get(`/fair-value?asset=SOL&target=213.93&settleTs=${Math.floor(h.nowMs() / 1000) + 86400}`)).json();
    expect(atTheMoney.pAbove).toBeGreaterThan(0.45);
    expect(atTheMoney.pAbove).toBeLessThan(0.52);
    expect((await get('/fair-value?asset=DOGE&target=1&settleTs=2030-01-01T00:00:00Z')).statusCode).toBe(400);
    expect((await get('/fair-value?asset=SOL&target=250&settleTs=garbage')).statusCode).toBe(400);
  });

  it('GET /fair-value is unavailable (not invented) without a fresh oracle price', async () => {
    await h.redis.flushdb();
    const r = await get(`/fair-value?asset=SOL&target=250&settleTs=${Math.floor(h.nowMs() / 1000) + 86400}`);
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('oracle_stale');
    await setOracle(h, 'SOL');
  });

  it('GET /assets lists the allow-listed feeds with price and age', async () => {
    const r = (await get('/assets')).json();
    expect(r.map((a: { symbol: string }) => a.symbol).sort()).toEqual(['BONK', 'BTC', 'ETH', 'JUP', 'SOL', 'WIF']);
    const s = r.find((a: { symbol: string }) => a.symbol === 'SOL');
    expect(s.price).toBe(213.93);
    expect(s.ageSec).toBeLessThanOrEqual(2);
    expect(s.feedId).toMatch(/^[0-9a-f]{64}$/);
    expect(r.find((a: { symbol: string }) => a.symbol === 'BTC')).toMatchObject({ price: null, ageSec: null });
  });
});
