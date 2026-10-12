/**
 * In-process end-to-end: the real indexer and keeper loops write into the same Postgres and Redis that the real API serves from.
 * Chain, Pyth and Hermes are the in-memory doubles from the indexer / keeper test helpers (the program is not deployed yet).
 * This is the substitute for a devnet smoke until a program id exists.
 */
import type { AddressInfo } from 'node:net';
import { CH, createRegistry, listAssetFeeds, RK, type OraclePriceService, type PriceReading } from '@groundgraph/svc-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { FairValueLoop } from '../../keeper/src/fairvalue';
import { createKeeperMetrics } from '../../keeper/src/metrics';
import { OracleLoop } from '../../keeper/src/oracle';
import { memAlerter, pushReading, silentLog } from '../../keeper/test/helpers';
import { Indexer } from '../../indexer/src/indexer';
import { createIndexerMetrics } from '../../indexer/src/metrics';
import { Publisher } from '../../indexer/src/publish';
import { chainMarket, ev, FakeLedger, marketFixture } from '../../indexer/test/helpers';
import { makeHarness, signIn, sleep, type Harness } from './helpers';

let h: Harness;
let url: string;
let indexer: Indexer;
let ledger: FakeLedger;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  h = await makeHarness({ hubTimers: { summaryMs: 60_000, radarPollMs: 60_000, heartbeatMs: 60_000 } });
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  url = `ws://127.0.0.1:${(h.app.server.address() as AddressInfo).port}/ws`;
  ledger = new FakeLedger();
  indexer = new Indexer({
    sql: h.sql,
    source: ledger,
    redis: h.redis,
    publisher: new Publisher(h.redis, h.ctx.log),
    log: h.ctx.log,
    metrics: createIndexerMetrics(createRegistry('e2e-indexer')),
    opts: { batchSize: 100, txConcurrency: 2, backfillOnStart: true, defaultLimit: 500_000_000n, dropGraceSlots: 0 },
  });
});
afterAll(async () => {
  for (const w of sockets) w.terminate();
  await h.close();
});

interface Msg { ch?: string; type?: string; seq?: number; data?: any }

async function wsConnect(cookie: string) {
  const ws = new WebSocket(url, { headers: { origin: 'http://localhost:3000', cookie } });
  sockets.push(ws);
  const inbox: Msg[] = [];
  ws.on('message', (raw) => inbox.push(JSON.parse(raw.toString()) as Msg));
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  return {
    send: (o: unknown) => ws.send(JSON.stringify(o)),
    inbox,
    until: async (pred: (m: Msg) => boolean, ms = 4000): Promise<Msg> => {
      const t0 = Date.now();
      for (;;) {
        const m = inbox.find(pred);
        if (m) return m;
        if (Date.now() - t0 > ms) throw new Error(`timeout; saw ${inbox.map((x) => `${x.ch}/${x.type}`).join(',')}`);
        await sleep(20);
      }
    },
  };
}

describe('indexer -> postgres/redis -> api', () => {
  const m = marketFixture({ symbol: 'SOL', liquidity: 1_000_000_000n, p0Bps: 2100 });
  let wallet: string;
  let cookie: string;

  it('serves a market, its trades and the holder positions that the indexer wrote', async () => {
    const s = await signIn(h);
    wallet = s.wallet;
    cookie = s.cookie;
    ledger.markets.set(m.id, chainMarket(m));
    ledger.add([ev.created(m)]);
    ledger.add([ev.trade(m, { wallet, side: 'above', buy: true, usdc: 100_000_000n, shares: 400_000_000n, fee: 1_000_000n, priceAfterBps: 2600 })]);
    ledger.add([ev.trade(m, { wallet: m.creator, side: 'below', buy: true, usdc: 50_000_000n, shares: 90_000_000n, priceAfterBps: 2500 })]);
    ledger.headSlot += 10;
    ledger.finalizedSlot = ledger.headSlot;
    await indexer.pollOnce();

    const detail = await h.app.inject({ method: 'GET', url: `/markets/${m.id}` });
    expect(detail.statusCode).toBe(200);
    const d = detail.json();
    expect(d.id).toBe(m.id);
    expect(d.assetSymbol).toBe('SOL');
    expect(['open', 'trading_closed']).toContain(d.status);
    expect(d.pool.aboveMint).toBe(m.aboveMint);

    const trades = await h.app.inject({ method: 'GET', url: `/markets/${m.id}/trades` });
    expect(trades.statusCode).toBe(200);
    const body = trades.json();
    const rows = Array.isArray(body) ? body : body.items;
    expect(rows).toHaveLength(2);
    expect(rows.some((t: any) => t.wallet === wallet && t.side === 'above')).toBe(true);

    const pos = await h.app.inject({ method: 'GET', url: '/me/positions?tab=open', headers: { cookie } });
    expect(pos.statusCode).toBe(200);
    const items = pos.json().items ?? pos.json();
    const mine = items.filter((p: any) => p.marketId === m.id);
    expect(mine.length).toBeGreaterThan(0);
    const above = mine.find((p: any) => p.side === 'above');
    expect(above).toBeTruthy();
    expect(String(above.shares)).toBe('400000000');

    const list = await h.app.inject({ method: 'GET', url: '/markets' });
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).toContain(m.id);
  });

  it('pushes the next indexed trade over the market and me websocket channels', async () => {
    const c = await wsConnect(cookie);
    c.send({ op: 'subscribe', channels: [`market:${m.id}`, 'me'] });
    await c.until((x) => x.ch === `market:${m.id}` && x.type === 'snapshot');
    await c.until((x) => x.ch === 'me' && x.type === 'snapshot');

    ledger.add([ev.trade(m, { wallet, side: 'above', buy: true, usdc: 20_000_000n, shares: 70_000_000n, priceAfterBps: 2700, ra: 3_100_000_000n, rb: 900_000_000n })]);
    ledger.headSlot += 5;
    ledger.finalizedSlot = ledger.headSlot;
    ledger.markets.set(m.id, chainMarket(m, { ra: 3_100_000_000n, rb: 900_000_000n }));
    await indexer.pollOnce();

    const delta = await c.until((x) => x.ch === `market:${m.id}` && x.type === 'delta');
    expect(delta.data).toBeTruthy();
    const mine = await c.until((x) => x.ch === 'me' && x.type === 'delta');
    expect(mine.data?.kind).toBe('fill');
    expect(mine.data?.marketId).toBe(m.id);
  });

  it('serves the settled outcome and the redeem tab after Settled and Redeemed events', async () => {
    ledger.add([ev.settled(m, 'above')]);
    ledger.markets.set(m.id, chainMarket(m, { status: 'settled', outcome: 'above', lpClaim: 400_000_000n }));
    ledger.headSlot += 5;
    ledger.finalizedSlot = ledger.headSlot;
    await indexer.pollOnce();
    const detail = (await h.app.inject({ method: 'GET', url: `/markets/${m.id}` })).json();
    expect(detail.status).toBe('settled');
    expect(detail.outcome).toBe('above');
    const redeem = (await h.app.inject({ method: 'GET', url: '/me/positions?tab=redeem', headers: { cookie } })).json();
    const items = redeem.items ?? redeem;
    expect(items.some((p: any) => p.marketId === m.id && p.side === 'above')).toBe(true);
  });
});

describe('keeper -> redis/postgres -> api', () => {
  it('oracle and fair-value loops feed the market detail and the oracle websocket channel', async () => {
    const open = marketFixture({ symbol: 'SOL', liquidity: 1_000_000_000n, p0Bps: 2100, settleTs: Math.floor(Date.now() / 1000) + 7200, tradingEndTs: Math.floor(Date.now() / 1000) + 3600 });
    ledger.markets.set(open.id, chainMarket(open));
    ledger.add([ev.created(open)]);
    ledger.headSlot += 5;
    ledger.finalizedSlot = ledger.headSlot;
    await indexer.pollOnce();

    const sol = listAssetFeeds().find((f) => f.symbol === 'SOL')!;
    const nowSec = Math.floor(Date.now() / 1000);
    const reading: PriceReading = pushReading('SOL', { price: 251.25, publishTs: nowSec - 1 });
    const oracle = { latest: async () => new Map([[sol.feedIdHex, reading]]) } as unknown as OraclePriceService;
    const metrics = createKeeperMetrics(createRegistry('e2e-keeper'));
    const alerter = memAlerter(900);
    const loop = new OracleLoop({ oracle, redis: h.redis, sql: h.sql, log: silentLog, metrics, alerter, staleSecs: 60, now: () => Date.now(), feeds: [sol] });

    const c = await wsConnect('');
    c.send({ op: 'subscribe', channels: [`oracle:${sol.feedIdHex}`] });
    await c.until((x) => x.ch === `oracle:${sol.feedIdHex}` && x.type === 'snapshot');
    await loop.tick();
    const od = await c.until((x) => x.ch === `oracle:${sol.feedIdHex}` && x.type === 'delta');
    expect(Number(od.data?.price)).toBeCloseTo(251.25, 2);

    await h.redis.set(RK.vol(sol.feedIdHex), JSON.stringify({ feedId: sol.feedIdHex, vol: 0.7, source: 'test', nCloses: 30, asOf: Date.now() }), 'EX', 600);
    const fv = new FairValueLoop({ sql: h.sql, redis: h.redis, log: silentLog, metrics, now: () => Date.now(), snapshots: () => loop.latest, maxSpotAgeSecs: 900, benchmarksUrl: 'https://benchmarks.example' });
    expect(await fv.tick()).toBeGreaterThan(0);

    const detail = (await h.app.inject({ method: 'GET', url: `/markets/${open.id}` })).json();
    expect(detail.fairValue).toMatchObject({ spot: 251.25, vol: 0.7 });
    expect(detail.fairValue.pAbove).toBeGreaterThan(0);
    expect(detail.fairValue.pAbove).toBeLessThan(1);
    expect(detail.oracle.price).toBeCloseTo(251.25, 2);
    const stored = await h.sql`SELECT count(*)::int AS n FROM fair_values WHERE market_id = ${open.id}`;
    expect(stored[0]!.n).toBe(1);
    const snap = await h.redis.get(RK.fairValue(open.id));
    expect(snap).toBeTruthy();
    expect(CH.oracle(sol.feedIdHex)).toContain(sol.feedIdHex);
  });
});
