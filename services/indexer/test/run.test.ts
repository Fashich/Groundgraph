import { RK, readHeartbeat } from '@groundgraph/svc-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/backfill';
import { loadConfig } from '../src/config';
import { Wakeup } from '../src/indexer';
import { acquireLeaderLock, runLoops } from '../src/run';
import { chainMarket, ev, makeHarness, marketFixture, pk, waitFor, type Harness } from './helpers';

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.stop();
});

describe('runLoops', () => {
  it('follows the chain, backfills history, writes the heartbeat and stops cleanly', async () => {
    const m = marketFixture();
    const w = pk().toBase58();
    h.ledger.markets.set(m.id, chainMarket(m));
    h.ledger.add([ev.created(m)]);
    for (let i = 0; i < 12; i++) h.ledger.add([ev.trade(m, { wallet: w, side: 'above', buy: true, usdc: 1_000_000n, shares: 2_000_000n, ts: 1_800_000_000 + i })]);
    const small = h.restart({ batchSize: 5 });
    const ac = new AbortController();
    const done = runLoops(small, { pollMs: 40, reconcileMs: 10_000, finalizeMs: 10_000, tickMs: 10_000, heartbeatMs: 50 }, { debug() {}, info() {}, warn() {}, error() {} } as never, ac.signal);
    // history (older than the first page) is picked up by the idle-time backfill
    await waitFor(() => small.state.backfillDone, 5000);
    const count = async () => (await h.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM trades`)[0]!.n;
    await waitFor(() => small.state.indexedSlot >= h.ledger.headSlot, 3000);
    expect(await count()).toBe(12);

    // a new transaction is picked up by the next poll
    h.ledger.add([ev.trade(m, { wallet: w, side: 'below', buy: true, usdc: 1_000_000n, shares: 2_000_000n, ts: 1_800_000_050 })]);
    const t0 = Date.now();
    for (;;) {
      if ((await count()) === 13) break;
      if (Date.now() - t0 > 3000) throw new Error('new transaction was not indexed');
      await new Promise((r) => setTimeout(r, 30));
    }

    await waitFor(() => true);
    const hb = await readHeartbeat(h.redis, RK.heartbeatIndexer);
    expect(hb).toMatchObject({ service: 'indexer', backfillDone: true });
    expect(typeof hb!['indexedSlot']).toBe('number');
    expect(Date.now() - hb!.ts).toBeLessThan(2000);

    ac.abort();
    small.wakeup.wake();
    await done;
  });

  it('a nudge wakes the poller before the interval elapses', async () => {
    const m = marketFixture();
    h.ledger.add([ev.created(m)]);
    const ix = h.restart();
    const ac = new AbortController();
    const done = runLoops(ix, { pollMs: 60_000, reconcileMs: 60_000, finalizeMs: 60_000, tickMs: 60_000, heartbeatMs: 60_000 }, { debug() {}, info() {}, warn() {}, error() {} } as never, ac.signal);
    await waitFor(() => ix.state.lastPollAt > 0, 3000);
    const w = pk().toBase58();
    h.ledger.add([ev.trade(m, { wallet: w, side: 'above', buy: true, usdc: 1_000_000n, shares: 2_000_000n, ts: 1_800_000_001 })]);
    ix.wakeup.wake();
    await waitFor(() => ix.state.indexedSlot >= h.ledger.headSlot, 3000);
    const n = (await h.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM trades`)[0]!.n;
    expect(n).toBe(1);
    ac.abort();
    ix.wakeup.wake();
    await done;
  });

  it('keeps running after a poll error and records it', async () => {
    const ix = h.restart();
    let fail = true;
    const orig = h.ledger.getSlot.bind(h.ledger);
    h.ledger.getSlot = async (c) => {
      if (fail) throw new Error('rpc down');
      return orig(c);
    };
    const ac = new AbortController();
    const done = runLoops(ix, { pollMs: 30, reconcileMs: 60_000, finalizeMs: 60_000, tickMs: 60_000, heartbeatMs: 60_000 }, { debug() {}, info() {}, warn() {}, error() {} } as never, ac.signal);
    await waitFor(() => ix.state.lastError !== null, 3000);
    expect(ix.state.lastError).toMatch(/rpc down/);
    fail = false;
    ix.wakeup.wake();
    await waitFor(() => ix.state.lastError === null && ix.state.lastPollAt > 0, 5000);
    ac.abort();
    ix.wakeup.wake();
    await done;
  });
});

describe('Wakeup', () => {
  it('resolves early when woken, and remembers a wake that happened while busy', async () => {
    const w = new Wakeup();
    const t0 = Date.now();
    setTimeout(() => w.wake(), 30);
    await w.wait(5000);
    expect(Date.now() - t0).toBeLessThan(1000);
    w.wake();
    const t1 = Date.now();
    await w.wait(5000);
    expect(Date.now() - t1).toBeLessThan(100);
  });
});

describe('leader lock', () => {
  it('lets only one instance run at a time', async () => {
    const log = { warn() {}, info() {} } as never;
    const a = await acquireLeaderLock(h.sql, log, new AbortController().signal, 991_001);
    expect(a).not.toBeNull();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const b = await acquireLeaderLock(h.sql, log, ac.signal, 991_001);
    expect(b).toBeNull();
    await a!.release();
    const c = await acquireLeaderLock(h.sql, log, new AbortController().signal, 991_001);
    expect(c).not.toBeNull();
    await c!.release();
  });
});

describe('config', () => {
  it('has safe defaults', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ INDEXER_POLL_INTERVAL_MS: 2000, INDEXER_BATCH_SIZE: 100, INDEXER_METRICS_PORT: 9102, INDEXER_BACKFILL_ON_START: true, wsNudge: false });
    expect(c.rpcUrl).toBe('https://api.devnet.solana.com');
  });

  it('uses Helius endpoints when a key is set and RPC_URL is left alone, without leaking the key into labels', () => {
    const c = loadConfig({ HELIUS_API_KEY: 'secret-key' });
    expect(c.rpcUrl).toBe('https://devnet.helius-rpc.com/?api-key=secret-key');
    expect(c.wsUrl).toBe('wss://devnet.helius-rpc.com/?api-key=secret-key');
    expect(c.wsNudge).toBe(true);
    expect(c.rpcLabel).toBe('helius-devnet');
    expect(JSON.stringify(c.rpcLabel)).not.toContain('secret-key');
  });

  it('an explicit RPC_URL always wins, and the websocket nudge can be switched off', () => {
    const c = loadConfig({ HELIUS_API_KEY: 'k', RPC_URL: 'https://rpc.example.org', INDEXER_WS_NUDGE: 'false' });
    expect(c.rpcUrl).toBe('https://rpc.example.org');
    expect(c.wsNudge).toBe(false);
  });

  it('rejects out-of-range values', () => {
    expect(() => loadConfig({ INDEXER_BATCH_SIZE: '5000' })).toThrow(/INDEXER_BATCH_SIZE/);
  });
});

describe('backfill arguments', () => {
  it('parses flags', () => {
    expect(parseArgs(['--reset', '--limit', '500', '--since', '2026-10-01T00:00:00Z', '--batch', '50', '--before', 'abc'])).toMatchObject({
      reset: true,
      limit: 500,
      since: Math.floor(Date.parse('2026-10-01T00:00:00Z') / 1000),
      batch: 50,
      before: 'abc',
    });
    expect(parseArgs(['--since', '1790000000']).since).toBe(1790000000);
  });
  it('rejects bad input', () => {
    expect(() => parseArgs(['--limit', '0'])).toThrow();
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--since', 'not-a-date'])).toThrow();
    expect(() => parseArgs(['--batch', '5'])).toThrow();
  });
});

void marketFixture;
