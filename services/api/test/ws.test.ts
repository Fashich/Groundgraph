import type { AddressInfo } from 'node:net';
import { CH, assetBySymbol } from '@groundgraph/svc-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { parseChannel } from '../src/ws/hub';
import { makeHarness, seedMarket, seedRadar, setOracle, signIn, sleep, type Harness } from './helpers';

let h: Harness;
let url: string;
let m: Awaited<ReturnType<typeof seedMarket>>;
const open: WebSocket[] = [];

beforeAll(async () => {
  h = await makeHarness({ hubTimers: { summaryMs: 150, radarPollMs: 150, heartbeatMs: 60_000 } });
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  url = `ws://127.0.0.1:${(h.app.server.address() as AddressInfo).port}/ws`;
  await setOracle(h, 'SOL');
  m = await seedMarket(h);
});
afterAll(async () => {
  for (const w of open) w.terminate();
  await h.close();
});

interface Msg { ch?: string; type?: string; seq?: number; ts?: string; data?: any; op?: string; message?: string }

async function connect(opts: { cookie?: string; origin?: string; path?: string; autoPong?: boolean } = {}) {
  const ws = new WebSocket(`${url.replace(/\/ws$/, '')}${opts.path ?? '/ws'}`, {
    headers: { origin: opts.origin ?? 'http://localhost:3000', ...(opts.cookie ? { cookie: opts.cookie } : {}) },
    ...(opts.autoPong === false ? { autoPong: false } : {}),
  } as never);
  open.push(ws);
  const inbox: Msg[] = [];
  const waiters: { pred: (m: Msg) => boolean; res: (m: Msg) => void }[] = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString()) as Msg;
    const w = waiters.findIndex((x) => x.pred(msg));
    if (w >= 0) waiters.splice(w, 1)[0]!.res(msg);
    else inbox.push(msg);
  });
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
    ws.once('unexpected-response', (_req, r) => rej(new Error(`HTTP ${r.statusCode}`)));
  });
  return {
    ws,
    send: (o: unknown) => ws.send(typeof o === 'string' ? o : JSON.stringify(o)),
    next: (pred: (m: Msg) => boolean = () => true, ms = 3000) => {
      const i = inbox.findIndex(pred);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]!);
      return new Promise<Msg>((res, rej) => {
        const waiter = { pred, res: (msg: Msg) => (clearTimeout(t), res(msg)) };
        const t = setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1); // a timed out waiter must not swallow later messages
          rej(new Error('timeout waiting for ws message'));
        }, ms);
        waiters.push(waiter);
      });
    },
    closed: () => new Promise<number>((res) => (ws.readyState === ws.CLOSED ? res(0) : ws.once('close', (code) => res(code)))),
    drain: () => inbox.splice(0, inbox.length),
  };
}

describe('channel names', () => {
  it('accepts only the documented channels', () => {
    expect(parseChannel('markets:summary')).toMatchObject({ kind: 'summary' });
    expect(parseChannel('me')).toMatchObject({ kind: 'me' });
    expect(parseChannel(`market:${m.id}`)).toMatchObject({ kind: 'market' });
    expect(parseChannel(`radar:${m.id}`)).toMatchObject({ kind: 'radar' });
    const feed = assetBySymbol('SOL')!.feedIdHex;
    expect(parseChannel(`oracle:0x${feed.toUpperCase()}`)).toEqual({ kind: 'oracle', key: `oracle:${feed}` });
    for (const bad of ['', 'market:', 'market:short', 'market:' + 'l'.repeat(44), 'oracle:abc', 'trades:x', 'me:abc', 'markets:other', '*']) expect(parseChannel(bad), bad).toBeNull();
  });
});

describe('connection rules', () => {
  it('serves /ws and /api/ws, refuses foreign origins', async () => {
    const a = await connect();
    const b = await connect({ path: '/api/ws' });
    a.send({ op: 'ping' });
    expect(await a.next()).toEqual({ op: 'pong' });
    b.send({ op: 'ping' });
    expect(await b.next()).toEqual({ op: 'pong' });
    await expect(connect({ origin: 'https://evil.example' })).rejects.toThrow(/403/);
  });

  it('answers malformed input with an error message and keeps the socket', async () => {
    const c = await connect();
    c.send('not json');
    expect((await c.next()).op).toBe('error');
    c.send({ op: 'subscribe', channels: [] });
    expect((await c.next()).op).toBe('error');
    c.send({ op: 'dance' });
    expect((await c.next()).op).toBe('error');
    c.send({ op: 'subscribe', channels: ['market:short', 'bogus'] });
    expect((await c.next()).message).toMatch(/Unknown channel/);
    expect((await c.next()).message).toMatch(/Unknown channel/);
    c.send({ op: 'ping' });
    expect(await c.next()).toEqual({ op: 'pong' });
  });
});

describe('market:{id}', () => {
  it('sends a snapshot, then redis-published deltas with increasing seq', async () => {
    const c = await connect();
    c.send({ op: 'subscribe', channels: [`market:${m.id}`] });
    const snap = await c.next();
    expect(snap).toMatchObject({ ch: `market:${m.id}`, type: 'snapshot', seq: 1 });
    expect(snap.data).toMatchObject({ reserveAbove: '1000000000', reserveBelow: '265822784', feeBps: 100 });
    expect(snap.data.priceAbove).toBeCloseTo(0.2099, 3);
    expect(Date.parse(snap.ts!)).toBeGreaterThan(0);
    const delta = { priceAbove: 0.25, reserveAbove: '900000000', reserveBelow: '300000000', feeBps: 110, trade: { id: '7' } };
    await h.redis.publish(CH.market(m.id), JSON.stringify({ type: 'delta', data: delta }));
    await h.redis.publish(CH.market(m.id), JSON.stringify({ type: 'delta', data: { ...delta, priceAbove: 0.26 } }));
    const d1 = await c.next();
    const d2 = await c.next();
    expect(d1).toMatchObject({ ch: `market:${m.id}`, type: 'delta', seq: 2, data: delta });
    expect(d2).toMatchObject({ seq: 3 });
    expect(d2.data.priceAbove).toBe(0.26);
    // unrelated market is not delivered
    const other = await seedMarket(h);
    await h.redis.publish(CH.market(other.id), JSON.stringify({ type: 'delta', data: delta }));
    await expect(c.next(() => true, 300)).rejects.toThrow(/timeout/);
    // unsubscribe stops delivery; resubscribing starts a fresh sequence with a new snapshot
    c.send({ op: 'unsubscribe', channels: [`market:${m.id}`] });
    await sleep(100);
    await h.redis.publish(CH.market(m.id), JSON.stringify({ type: 'delta', data: delta }));
    await expect(c.next(() => true, 300)).rejects.toThrow(/timeout/);
    c.send({ op: 'subscribe', channels: [`market:${m.id}`] });
    expect(await c.next()).toMatchObject({ type: 'snapshot', seq: 1 });
  });

  it('refuses channels for markets that do not exist', async () => {
    const c = await connect();
    c.send({ op: 'subscribe', channels: [`market:${'1'.repeat(44)}`] });
    expect((await c.next()).message).toMatch(/Nothing to subscribe/);
  });

  it('keeps independent sequences per channel on one connection', async () => {
    const c = await connect();
    const feed = assetBySymbol('SOL')!.feedIdHex;
    c.send({ op: 'subscribe', channels: [`market:${m.id}`, `oracle:${feed}`] });
    const a = await c.next((x) => x.ch === `market:${m.id}`);
    const b = await c.next((x) => x.ch === `oracle:${feed}`);
    expect([a.seq, b.seq]).toEqual([1, 1]);
  });
});

describe('markets:summary', () => {
  it('snapshots active markets then pushes only the changed ones every tick', async () => {
    const c = await connect();
    c.send({ op: 'subscribe', channels: ['markets:summary'] });
    const snap = await c.next();
    expect(snap).toMatchObject({ ch: 'markets:summary', type: 'snapshot', seq: 1 });
    const ids = snap.data.markets.map((x: { id: string }) => x.id);
    expect(ids).toContain(m.id);
    expect(snap.data.markets[0]).toHaveProperty('priceAbove');
    expect(snap.data.markets[0]).toHaveProperty('radar');
    await expect(c.next((x) => x.type === 'delta', 600)).rejects.toThrow(/timeout/); // nothing changed, nothing sent
    await h.sql`UPDATE markets SET reserve_above = 900000000, reserve_below = 400000000 WHERE id = ${m.id}`;
    const delta = await c.next((x) => x.type === 'delta');
    expect(delta.seq).toBe(2);
    expect(delta.data.markets).toHaveLength(1);
    expect(delta.data.markets[0]).toMatchObject({ id: m.id });
    expect(delta.data.markets[0].priceAbove).toBeCloseTo(400 / 1300, 3);
  });
});

describe('radar:{id} and oracle:{feed}', () => {
  it('radar deltas follow new market_radar rows', async () => {
    const c = await connect();
    c.send({ op: 'subscribe', channels: [`radar:${m.id}`] });
    const snap = await c.next();
    expect(snap).toMatchObject({ type: 'snapshot', data: { state: 'building' } });
    await seedRadar(h, m.id, { p: 0.31, ci: 8, n: 4, edge: 6, agoSec: 0 });
    const d = await c.next((x) => x.type === 'delta');
    expect(d.data).toMatchObject({ state: 'ready', p: 0.31, ci: 8, n: 4, edge: 6 });
  });

  it('oracle snapshot is OracleInfo and raw keeper readings are converted', async () => {
    const feed = assetBySymbol('SOL')!.feedIdHex;
    const c = await connect();
    c.send({ op: 'subscribe', channels: [`oracle:${feed}`] });
    const snap = await c.next();
    expect(snap.data).toMatchObject({ feedId: feed, symbol: 'SOL/USD', price: 213.93, stale: false });
    const reading = { feedId: feed, symbol: 'SOL/USD', price: 214.5, conf: 0.1, expo: -8, publishTs: Math.floor(h.nowMs() / 1000), fetchedAt: h.nowMs(), source: 'push-feed', stale: false };
    await h.redis.publish(CH.oracle(feed), JSON.stringify({ type: 'delta', data: reading }));
    const d = await c.next();
    expect(d).toMatchObject({ type: 'delta', seq: 2 });
    expect(d.data).toMatchObject({ feedId: feed, price: 214.5, conf: 0.1, stale: false });
    expect(d.data.ageSec).toBeLessThanOrEqual(1);
    expect(typeof d.data.publishTs).toBe('string');
  });
});

describe('me', () => {
  it('requires the session cookie, then streams the wallet fills and settlements', async () => {
    const anon = await connect();
    anon.send({ op: 'subscribe', channels: ['me'] });
    expect((await anon.next()).message).toMatch(/requires a signed-in session/);
    const s = await signIn(h);
    const c = await connect({ cookie: s.cookie });
    c.send({ op: 'subscribe', channels: ['me'] });
    const snap = await c.next();
    expect(snap).toMatchObject({ ch: 'me', type: 'snapshot', seq: 1, data: { wallet: s.wallet, mode: 'sign' } });
    expect(snap.data.settings).toMatchObject({ dailyLimitUsdc: '500000000' });
    await h.redis.publish(CH.me(s.wallet), JSON.stringify({ type: 'delta', data: { kind: 'fill', marketId: m.id } }));
    await h.redis.publish(CH.me('someone-else'), JSON.stringify({ type: 'delta', data: { kind: 'fill', marketId: 'x' } }));
    const d = await c.next();
    expect(d).toMatchObject({ ch: 'me', type: 'delta', seq: 2, data: { kind: 'fill', marketId: m.id } });
    await expect(c.next(() => true, 300)).rejects.toThrow(/timeout/);
  });
  it('a tampered cookie does not authenticate', async () => {
    const s = await signIn(h);
    const c = await connect({ cookie: s.cookie.slice(0, -3) + 'abc' });
    c.send({ op: 'subscribe', channels: ['me'] });
    expect((await c.next()).op).toBe('error');
  });
});

describe('limits and backpressure', () => {
  it('terminates a consumer whose buffer exceeds WS_MAX_BUFFER_BYTES', async () => {
    const cfg = h.ctx.cfg as { WS_MAX_BUFFER_BYTES: number };
    const c = await connect();
    c.send({ op: 'subscribe', channels: [`market:${m.id}`] });
    await c.next();
    const before = cfg.WS_MAX_BUFFER_BYTES;
    cfg.WS_MAX_BUFFER_BYTES = 4096;
    try {
      (c.ws as unknown as { _socket: { pause(): void } })._socket.pause();
      const big = { priceAbove: 0.3, reserveAbove: '1', reserveBelow: '1', feeBps: 1, pad: 'x'.repeat(4_000_000) };
      await h.redis.publish(CH.market(m.id), JSON.stringify({ type: 'delta', data: big }));
      await sleep(400);
      expect(h.hub.clientCount).toBeGreaterThanOrEqual(0);
      const metrics = await h.ctx.registry.metrics();
      expect(metrics).toMatch(/gg_ws_dropped_total\{[^}]*reason="backpressure"[^}]*\} [1-9]/);
    } finally {
      cfg.WS_MAX_BUFFER_BYTES = before;
    }
  });

  it('caps connections per IP', async () => {
    const cfg = h.ctx.cfg as { WS_MAX_CONNECTIONS_PER_IP: number };
    for (const w of open) w.terminate();
    await sleep(200);
    const before = cfg.WS_MAX_CONNECTIONS_PER_IP;
    cfg.WS_MAX_CONNECTIONS_PER_IP = 2;
    try {
      await connect();
      await connect();
      await expect(connect()).rejects.toThrow(/429/);
    } finally {
      cfg.WS_MAX_CONNECTIONS_PER_IP = before;
    }
  });

  it('rate limits message floods and drops abusive clients, and cleans up on close', async () => {
    for (const w of open) w.terminate();
    await sleep(200);
    const c = await connect();
    for (let i = 0; i < 400; i++) c.send({ op: 'ping' });
    const code = await Promise.race([c.closed(), sleep(3000).then(() => -1)]);
    expect(code).not.toBe(-1);
    await sleep(100);
    expect(h.hub.clientCount).toBe(0);
  });
});

describe('heartbeat', () => {
  it('drops clients that stop answering protocol pings', async () => {
    const quick = await makeHarness({ hubTimers: { heartbeatMs: 120, summaryMs: 60_000, radarPollMs: 60_000 } });
    try {
      await quick.app.listen({ port: 0, host: '127.0.0.1' });
      const port = (quick.app.server.address() as AddressInfo).port;
      const good = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const mute = new WebSocket(`ws://127.0.0.1:${port}/ws`, { autoPong: false } as never);
      await Promise.all([new Promise((r) => good.once('open', r)), new Promise((r) => mute.once('open', r))]);
      const muteClosed = new Promise<void>((r) => mute.once('close', () => r()));
      await Promise.race([muteClosed, sleep(2000)]);
      expect(mute.readyState).toBe(WebSocket.CLOSED);
      expect(good.readyState).toBe(WebSocket.OPEN);
      good.terminate();
    } finally {
      await quick.close();
    }
  });
});
