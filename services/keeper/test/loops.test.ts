import type { MarketRow } from '@groundgraph/db';
import { assetBySymbol, fairValueClose, listAssetFeeds, RK, SECONDS_PER_YEAR, type OraclePriceService, type OracleSnapshot, type PriceReading } from '@groundgraph/svc-core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fairValueFor, FairValueLoop } from '../src/fairvalue';
import { housekeeping } from '../src/housekeeping';
import { OracleLoop } from '../src/oracle';
import { chainMarket, FakePoster, makeHarness, memAlerter, pushReading, seedDbMarket, silentLog, waitFor, type Harness } from './helpers';

let h: Harness;
beforeEach(async () => {
  if (h) await h.stop();
  h = await makeHarness();
});
afterAll(async () => {
  if (h) await h.stop();
});

const SOL = assetBySymbol('SOL')!;
const ETH = assetBySymbol('ETH')!;

class FakeOracle {
  readings = new Map<string, PriceReading>();
  fail: Error | null = null;
  async latest(): Promise<Map<string, PriceReading>> {
    if (this.fail) throw this.fail;
    return this.readings;
  }
}

function oracleLoop(oracle: FakeOracle, nowRef: { ms: number }, extra: Partial<ConstructorParameters<typeof OracleLoop>[0]> = {}) {
  const alerter = memAlerter(900, () => nowRef.ms);
  const loop = new OracleLoop({
    oracle: oracle as unknown as OraclePriceService,
    redis: h.redis,
    sql: h.sql,
    log: silentLog,
    metrics: h.metrics,
    alerter,
    staleSecs: 60,
    now: () => nowRef.ms,
    feeds: [SOL, ETH].map((a) => listAssetFeeds().find((f) => f.symbol === a.symbol)!),
    ...extra,
  });
  return { loop, alerter };
}

describe('OracleLoop', () => {
  it('caches each reading in Redis in the contract shape and streams changes', async () => {
    const oracle = new FakeOracle();
    const now = { ms: 1_800_000_010_000 };
    const r = pushReading('SOL', { publishTs: 1_800_000_008, price: 213.93, conf: 0.08 });
    oracle.readings.set(r.feedIdHex, r);
    const { loop } = oracleLoop(oracle, now);
    expect(await loop.tick()).toBe(1);

    const snap = JSON.parse((await h.redis.get(RK.oracle(SOL.feedIdHex)))!) as OracleSnapshot;
    expect(snap).toMatchObject({ feedId: SOL.feedIdHex, symbol: 'SOL/USD', price: 213.93, conf: 0.08, expo: -8, publishTs: 1_800_000_008, fetchedAt: now.ms, source: 'push-feed', stale: false });
    expect(await h.redis.ttl(RK.oracle(SOL.feedIdHex))).toBeGreaterThan(100);

    await waitFor(() => h.published.some((p) => p.channel === `gg:ch:oracle:${SOL.feedIdHex}`));
    // same publish time: no duplicate delta
    now.ms += 2000;
    await loop.tick();
    await new Promise((res) => setTimeout(res, 100));
    expect(h.published.filter((p) => p.channel === `gg:ch:oracle:${SOL.feedIdHex}`)).toHaveLength(1);
    // a new publish time is streamed
    oracle.readings.set(r.feedIdHex, { ...r, publishTs: 1_800_000_011 });
    now.ms += 1000;
    await loop.tick();
    await waitFor(() => h.published.filter((p) => p.channel === `gg:ch:oracle:${SOL.feedIdHex}`).length === 2);
  });

  it('flags stale readings', async () => {
    const oracle = new FakeOracle();
    const now = { ms: 1_800_000_200_000 };
    const r = pushReading('SOL', { publishTs: 1_800_000_000 });
    oracle.readings.set(r.feedIdHex, r);
    const { loop } = oracleLoop(oracle, now);
    await loop.tick();
    const snap = JSON.parse((await h.redis.get(RK.oracle(SOL.feedIdHex)))!) as OracleSnapshot;
    expect(snap.stale).toBe(true);
  });

  it('writes oracle_status downsampled to one row per 15 seconds and records a stale flip immediately', async () => {
    const oracle = new FakeOracle();
    const now = { ms: 1_800_000_010_000 };
    const r = pushReading('SOL', { publishTs: 1_800_000_009 });
    oracle.readings.set(r.feedIdHex, r);
    const { loop } = oracleLoop(oracle, now);
    for (let i = 0; i < 5; i++) {
      await loop.tick();
      now.ms += 2000; // 10s in total
    }
    expect((await h.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM oracle_status WHERE feed_id = ${SOL.feedIdHex}`)[0]!.n).toBe(1);
    now.ms += 6000; // 16s since the first row
    await loop.tick();
    expect((await h.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM oracle_status WHERE feed_id = ${SOL.feedIdHex}`)[0]!.n).toBe(2);
    // the feed goes stale (publishTs frozen, time moves on): the flip is stored at once
    now.ms = 1_800_000_090_000;
    await loop.tick();
    const rows = await h.sql`SELECT stale, price FROM oracle_status WHERE feed_id = ${SOL.feedIdHex} ORDER BY ts`;
    expect(rows.map((x) => x.stale)).toEqual([false, false, true]);
    expect(rows[0]!.price).toBe('251.25');
  });

  it('keeps going when the source fails and leaves the old snapshot to expire', async () => {
    const oracle = new FakeOracle();
    const now = { ms: 1_800_000_010_000 };
    const r = pushReading('SOL', { publishTs: 1_800_000_009 });
    oracle.readings.set(r.feedIdHex, r);
    const { loop } = oracleLoop(oracle, now);
    await loop.tick();
    oracle.fail = new Error('rpc down');
    await expect(loop.tick()).rejects.toThrow(/rpc down/);
    expect(await h.redis.get(RK.oracle(SOL.feedIdHex))).not.toBeNull();
  });

  it('alerts when a feed with open markets stays stale for two minutes, and resolves when it recovers', async () => {
    const oracle = new FakeOracle();
    const now = { ms: 1_800_000_000_000 };
    const r = pushReading('SOL', { publishTs: 1_799_999_000 });
    oracle.readings.set(r.feedIdHex, r);
    const { loop, alerter } = oracleLoop(oracle, now, { watchedFeeds: async () => new Set([SOL.feedIdHex]) });
    await loop.tick();
    expect(alerter.sent).toHaveLength(0);
    now.ms += 130_000;
    await loop.tick();
    expect(alerter.sent.map((a) => a.key)).toEqual([`oracle-stale:${SOL.feedIdHex}`]);
    now.ms += 5_000;
    oracle.readings.set(r.feedIdHex, { ...r, publishTs: Math.floor(now.ms / 1000) - 1 });
    await loop.tick();
    expect(alerter.sent.map((a) => a.title)).toContain('resolved: SOL/USD oracle');
  });

  it('does not alert for feeds nobody trades', async () => {
    const oracle = new FakeOracle();
    const now = { ms: 1_800_000_000_000 };
    const r = pushReading('ETH', { publishTs: 1_799_999_000 });
    oracle.readings.set(r.feedIdHex, r);
    const { loop, alerter } = oracleLoop(oracle, now, { watchedFeeds: async () => new Set([SOL.feedIdHex]) });
    await loop.tick();
    now.ms += 300_000;
    await loop.tick();
    expect(alerter.sent).toHaveLength(0);
  });
});

describe('fairValueFor', () => {
  const m = (o: Partial<Pick<MarketRow, 'kind' | 'direction' | 'targetPrice' | 'settleTs'>> = {}) => ({ kind: 'close' as const, direction: null, targetPrice: '250', settleTs: new Date(1_800_086_400_000), ...o });
  const now = 1_800_000_000_000;

  it('matches the SDK digital option formula', () => {
    const fv = fairValueFor(m(), { price: 260, publishTs: now / 1000 - 3 }, 0.8, now, 900)!;
    expect(fv.pAbove).toBeCloseTo(fairValueClose(260, 250, 0.8, 86400 / SECONDS_PER_YEAR), 12);
    expect(fv).toMatchObject({ spot: 260, vol: 0.8, ts: new Date(now).toISOString() });
  });

  it('refuses to price from an old spot, a missing volatility or a bad strike', () => {
    expect(fairValueFor(m(), { price: 260, publishTs: now / 1000 - 1000 }, 0.8, now, 900)).toBeNull();
    expect(fairValueFor(m(), { price: 260, publishTs: now / 1000 }, 0, now, 900)).toBeNull();
    expect(fairValueFor(m({ targetPrice: '0' }), { price: 260, publishTs: now / 1000 }, 0.8, now, 900)).toBeNull();
    expect(fairValueFor(m(), { price: Number.NaN, publishTs: now / 1000 }, 0.8, now, 900)).toBeNull();
  });

  it('collapses to the step function at settlement', () => {
    expect(fairValueFor(m({ settleTs: new Date(now - 1000) }), { price: 251, publishTs: now / 1000 }, 0.8, now, 900)!.pAbove).toBe(1);
    expect(fairValueFor(m({ settleTs: new Date(now - 1000) }), { price: 249, publishTs: now / 1000 }, 0.8, now, 900)!.pAbove).toBe(0);
  });
});

describe('FairValueLoop', () => {
  const nowMs = 1_800_000_000_000;
  const snap = (symbol: string, price: number, ageSecs = 2): OracleSnapshot => {
    const a = assetBySymbol(symbol)!;
    return { feedId: a.feedIdHex, symbol: a.pair, price, conf: 0.1, expo: -8, publishTs: nowMs / 1000 - ageSecs, fetchedAt: nowMs, source: 'push-feed', stale: false };
  };
  function loop(snaps: Map<string, OracleSnapshot>, fetchImpl?: typeof fetch) {
    return new FairValueLoop({ sql: h.sql, redis: h.redis, log: silentLog, metrics: h.metrics, now: () => nowMs, snapshots: () => snaps, maxSpotAgeSecs: 900, benchmarksUrl: 'https://benchmarks.example', ...(fetchImpl ? { fetchImpl } : {}) });
  }
  async function openMarket(symbol = 'SOL', settleInSecs = 86_400) {
    const m = chainMarket({ symbol, settleTs: nowMs / 1000 + settleInSecs, targetUsd: 250 });
    await seedDbMarket(h.sql, m, symbol);
    return m;
  }

  it('writes fair_values and the Redis cache for every open market', async () => {
    const m = await openMarket('SOL');
    const other = await openMarket('ETH');
    await h.sql`UPDATE markets SET target_price = '3000' WHERE id = ${other.id}`;
    await h.redis.set(RK.vol(SOL.feedIdHex), JSON.stringify({ feedId: SOL.feedIdHex, vol: 0.8, source: 'test', nCloses: 30, asOf: nowMs }));
    await h.redis.set(RK.vol(ETH.feedIdHex), JSON.stringify({ feedId: ETH.feedIdHex, vol: 0.6, source: 'test', nCloses: 30, asOf: nowMs }));
    const snaps = new Map([[SOL.feedIdHex, snap('SOL', 260)], [ETH.feedIdHex, snap('ETH', 3100)]]);
    expect(await loop(snaps).tick()).toBe(2);

    const [row] = await h.sql`SELECT spot, vol_annual, p_above FROM fair_values WHERE market_id = ${m.id}`;
    expect(Number(row!.spot)).toBe(260);
    expect(Number(row!.volAnnual)).toBe(0.8);
    expect(Number(row!.pAbove)).toBeCloseTo(fairValueClose(260, 250, 0.8, 86400 / SECONDS_PER_YEAR), 10);
    const cached = JSON.parse((await h.redis.get(RK.fairValue(m.id)))!);
    expect(cached).toMatchObject({ spot: 260, vol: 0.8, ts: new Date(nowMs).toISOString() });
    expect(cached.pAbove).toBeCloseTo(Number(row!.pAbove), 10);
    expect(await h.redis.ttl(RK.fairValue(m.id))).toBeGreaterThan(200);
  });

  it('is idempotent within a second and skips markets past settle_ts, resolved markets and stale spots', async () => {
    const live = await openMarket('SOL');
    const past = await openMarket('ETH', -10);
    const done = chainMarket({ symbol: 'SOL', settleTs: nowMs / 1000 + 5000 });
    await seedDbMarket(h.sql, done, 'SOL', 'settled');
    await h.redis.set(RK.vol(SOL.feedIdHex), JSON.stringify({ feedId: SOL.feedIdHex, vol: 0.8, source: 'test', nCloses: 30, asOf: nowMs }));
    await h.redis.set(RK.vol(ETH.feedIdHex), JSON.stringify({ feedId: ETH.feedIdHex, vol: 0.6, source: 'test', nCloses: 30, asOf: nowMs }));
    const snaps = new Map([[SOL.feedIdHex, snap('SOL', 260)], [ETH.feedIdHex, snap('ETH', 3100)]]);
    const l = loop(snaps);
    expect(await l.tick()).toBe(1);
    await l.tick();
    const rows = await h.sql`SELECT market_id FROM fair_values`;
    expect(rows.map((r) => r.marketId)).toEqual([live.id]);
    expect(past.id).toBeTruthy();
    // stale spot: nothing new is computed
    await h.sql`DELETE FROM fair_values`;
    expect(await loop(new Map([[SOL.feedIdHex, snap('SOL', 260, 5000)]])).tick()).toBe(0);
  });

  it('computes the volatility on demand when none is cached, from the first provider that answers', async () => {
    await openMarket('SOL');
    const day = 86_400;
    const today = nowMs / 1000 - ((nowMs / 1000) % day);
    // coinbase candles: [time, low, high, open, close, volume], newest first
    const candles = Array.from({ length: 32 }, (_, i) => [today - (i + 1) * day, 0, 0, 0, 200 * (1 + 0.02 * Math.sin(i)), 1]);
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('coinbase')) return new Response(JSON.stringify(candles));
      return new Response('nope', { status: 500 });
    }) as typeof fetch;
    const snaps = new Map([[SOL.feedIdHex, snap('SOL', 260)]]);
    expect(await loop(snaps, fetchImpl).tick()).toBe(1);
    const vol = JSON.parse((await h.redis.get(RK.vol(SOL.feedIdHex)))!);
    expect(vol).toMatchObject({ source: 'coinbase', nCloses: 31 });
    expect(vol.vol).toBeGreaterThan(0.05);
    expect(await h.redis.ttl(RK.vol(SOL.feedIdHex))).toBeGreaterThan(3600);
  });

  it('skips a market and backs off when no volatility source answers', async () => {
    await openMarket('SOL');
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('down', { status: 503 });
    }) as typeof fetch;
    const snaps = new Map([[SOL.feedIdHex, snap('SOL', 260)]]);
    const l = loop(snaps, fetchImpl);
    expect(await l.tick()).toBe(0);
    const after = calls;
    expect(after).toBeGreaterThan(0);
    expect(await l.tick()).toBe(0);
    expect(calls).toBe(after); // 60s backoff: no hammering
  });

  it('refreshAllVols warms the majors and every asset with an open market', async () => {
    await openMarket('JUP');
    const day = 86_400;
    const today = nowMs / 1000 - ((nowMs / 1000) % day);
    const candles = Array.from({ length: 32 }, (_, i) => [today - (i + 1) * day, 0, 0, 0, 100 + (i % 5), 1]);
    const fetchImpl = (async () => new Response(JSON.stringify(candles))) as typeof fetch;
    const n = await loop(new Map(), fetchImpl).refreshAllVols();
    expect(n).toBe(4); // SOL, BTC, ETH + JUP
    const keys = await h.redis.keys('vol:*');
    expect(keys).toHaveLength(4);
  });
});

describe('housekeeping', () => {
  const base = () => ({ sql: h.sql, log: silentLog, metrics: h.metrics, now: () => new Date('2027-01-15T08:00:00Z'), oracleRetentionDays: 7, fairValueRetentionDays: 14, minLamports: 200_000_000n });

  it('prunes old oracle rows and old fair values of resolved markets only', async () => {
    const open = chainMarket({ settleTs: 1_800_100_000 });
    const done = chainMarket({ settleTs: 1_800_100_000 });
    await seedDbMarket(h.sql, open);
    await seedDbMarket(h.sql, done, 'SOL', 'settled');
    const old = new Date('2027-01-01T00:00:00Z');
    const fresh = new Date('2027-01-15T07:59:00Z');
    await h.sql`INSERT INTO oracle_status (feed_id, ts, price, conf, publish_ts, stale) VALUES ('f', ${old}, 1, 1, ${old}, false), ('f', ${fresh}, 1, 1, ${fresh}, false)`;
    await h.sql`INSERT INTO fair_values (market_id, ts, spot, vol_annual, p_above) VALUES (${open.id}, ${old}, 1, 1, 0.5), (${done.id}, ${old}, 1, 1, 0.5), (${done.id}, ${fresh}, 1, 1, 0.5)`;
    const poster = new FakePoster();
    const res = await housekeeping({ ...base(), poster, alerter: memAlerter(), checkBalance: true });
    expect(res).toMatchObject({ oracleRows: 1, fairValueRows: 1, balanceLamports: 5_000_000_000n });
    expect((await h.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM fair_values`)[0]!.n).toBe(2);
  });

  it('alerts when the keeper wallet is nearly empty and resolves when refilled', async () => {
    const poster = new FakePoster();
    poster.balance = 50_000_000n;
    const alerter = memAlerter();
    await housekeeping({ ...base(), poster, alerter, checkBalance: true });
    expect(alerter.sent).toMatchObject([{ key: 'keeper-balance-low', severity: 'critical' }]);
    poster.balance = 2_000_000_000n;
    await housekeeping({ ...base(), poster, alerter, checkBalance: true });
    expect(alerter.sent.map((a) => a.title)).toContain('resolved: keeper balance');
  });
});
