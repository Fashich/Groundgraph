import { RK, type PriceReading } from '@groundgraph/svc-core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SettleLoop, type SettleDeps } from '../src/settle';
import { chainMarket, FakeChain, FakePoster, makeHarness, memAlerter, pushReading, seedDbMarket, SETTLE_TS, silentLog, waitFor, type Harness } from './helpers';

let h: Harness;
let chain: FakeChain;
let poster: FakePoster;
let nowMs: number;
let push: Map<string, PriceReading>;
let hermes: { calls: number[]; result: { readings: Map<string, PriceReading>; updates: string[] } | Error };

const alerter = () => memAlerter();

beforeEach(async () => {
  if (h) await h.stop();
  h = await makeHarness();
  chain = new FakeChain();
  poster = new FakePoster();
  nowMs = (SETTLE_TS + 5) * 1000;
  push = new Map();
  hermes = { calls: [], result: new Error('not configured') };
});
afterAll(async () => {
  if (h) await h.stop();
});

function loop(o: Partial<SettleDeps> = {}) {
  const a = alerter();
  const l = new SettleLoop({
    sql: h.sql,
    redis: h.redis,
    chain,
    poster,
    push: { latest: async () => push },
    hermes: {
      atTime: async (t: number) => {
        hermes.calls.push(t);
        if (hermes.result instanceof Error) throw hermes.result;
        return hermes.result;
      },
    },
    mode: 'push-feed',
    pushAssets: new Set(['SOL', 'ETH']),
    log: silentLog,
    metrics: h.metrics,
    alerter: a,
    alertAfterAttempts: 3,
    now: () => new Date(nowMs),
    ...o,
  });
  return { l, a };
}

async function market(symbol = 'SOL', o: { settleTs?: number; status?: 'open' | 'settled' | 'voided'; chainStatus?: 'open' | 'settled' | 'voided' } = {}) {
  const m = chainMarket({ symbol, settleTs: o.settleTs ?? SETTLE_TS, status: o.chainStatus ?? 'open' });
  chain.markets.set(m.id, m);
  await seedDbMarket(h.sql, m, symbol, o.status ?? 'open');
  return m;
}

describe('push feed mode (no PYTH_API_KEY)', () => {
  it('does nothing before settle_ts', async () => {
    await market();
    nowMs = (SETTLE_TS - 20) * 1000;
    const { l } = loop();
    expect(await l.runOnce()).toMatchObject({ due: 0 });
    expect(poster.calls).toHaveLength(0);
  });

  it('settles a SOL market with the push feed account once settle_ts has passed', async () => {
    const m = await market('SOL');
    const r = pushReading('SOL');
    push.set(r.feedIdHex, r);
    const { l } = loop();
    const rep = await l.runOnce();
    expect(rep.settled).toEqual([m.id]);
    expect(poster.calls).toEqual([{ kind: 'settle-push', market: m.id, attempt: 0, priceUpdate: r.account }]);
    expect(l.stats.settled).toBe(1);
  });

  it('does not send twice while the first settlement is still being mirrored (lock)', async () => {
    await market('SOL');
    const r = pushReading('SOL');
    push.set(r.feedIdHex, r);
    const { l } = loop();
    await l.runOnce();
    await l.runOnce();
    expect(poster.calls).toHaveLength(1);
  });

  it('two keepers racing for the same market settle it once', async () => {
    await market('SOL');
    const r = pushReading('SOL');
    push.set(r.feedIdHex, r);
    const a = loop().l;
    const b = loop().l;
    await Promise.all([a.runOnce(), b.runOnce()]);
    expect(poster.calls).toHaveLength(1);
  });

  it('waits for the feed to publish after settle_ts, then settles inside the window', async () => {
    const m = await market('SOL');
    const stale = pushReading('SOL', { publishTs: SETTLE_TS - 8 });
    push.set(stale.feedIdHex, stale);
    const { l } = loop();
    const first = await l.runOnce();
    expect(first.waiting).toEqual([m.id]);
    expect(poster.calls).toHaveLength(0);
    expect(l.nextDelayMs(10_000)).toBe(2000); // hot: poll quickly while the window is open
    nowMs = (SETTLE_TS + 12) * 1000;
    push.set(stale.feedIdHex, pushReading('SOL', { publishTs: SETTLE_TS + 10 }));
    const second = await l.runOnce();
    expect(second.settled).toEqual([m.id]);
  });

  it('does not settle assets without a fresh push feed, warns, and voids after one hour', async () => {
    const m = await market('BONK');
    const r = pushReading('BONK');
    push.set(r.feedIdHex, r);
    const { l, a } = loop();
    const rep = await l.runOnce();
    expect(rep.unavailable).toEqual([m.id]);
    expect(poster.calls).toHaveLength(0);
    expect(a.sent.map((x) => x.key)).toContain(`settle-unavailable:${m.id}`);
    expect(a.sent[0]!.message).toMatch(/PYTH_API_KEY/);

    nowMs = (SETTLE_TS + 3600 + 1) * 1000;
    const later = await l.runOnce();
    expect(later.voided).toEqual([m.id]);
    expect(poster.calls).toEqual([{ kind: 'void', market: m.id, attempt: 0 }]);
    expect(a.sent.map((x) => x.key)).toContain(`voided:${m.id}`);
  });

  it('a stale feed after the window closes is reported, not settled', async () => {
    const m = await market('SOL');
    const r = pushReading('SOL', { publishTs: SETTLE_TS - 500 });
    push.set(r.feedIdHex, r);
    nowMs = (SETTLE_TS + 100) * 1000;
    const { l, a } = loop();
    const rep = await l.runOnce();
    expect(rep.unavailable).toEqual([m.id]);
    expect(a.sent[0]).toMatchObject({ key: `settle-unavailable:${m.id}`, severity: 'warn' });
  });

  it('skips markets the chain already resolved (database not yet updated)', async () => {
    await market('SOL', { chainStatus: 'settled' });
    const { l } = loop();
    await l.runOnce();
    expect(poster.calls).toHaveLength(0);
  });

  it('skips markets whose account cannot be found', async () => {
    const m = chainMarket();
    await seedDbMarket(h.sql, m);
    const { l } = loop();
    expect(await l.runOnce()).toMatchObject({ due: 1, settled: [] });
    expect(poster.calls).toHaveLength(0);
  });

  it('never touches markets the database already shows as resolved', async () => {
    await market('SOL', { status: 'settled' });
    const { l } = loop();
    expect(await l.runOnce()).toMatchObject({ due: 0 });
  });

  it('nudges the indexer after a settlement', async () => {
    await market('SOL');
    const r = pushReading('SOL');
    push.set(r.feedIdHex, r);
    const { l } = loop();
    await l.runOnce();
    await waitFor(() => h.published.some((p) => p.channel === 'gg:indexer:nudge'));
  });
});

describe('Hermes mode (PYTH_API_KEY set)', () => {
  const hermesReading = (symbol: string, publishTs: number) => pushReading(symbol, { publishTs, source: 'hermes', account: undefined as never });

  it('fetches the update at settle_ts and settles with it for any allow-listed asset', async () => {
    const m = await market('BONK');
    const r = hermesReading('BONK', SETTLE_TS + 1);
    hermes.result = { readings: new Map([[r.feedIdHex, r]]), updates: ['QUNDVQ=='] };
    const { l } = loop({ mode: 'hermes' });
    const rep = await l.runOnce();
    expect(rep.settled).toEqual([m.id]);
    expect(hermes.calls).toEqual([SETTLE_TS]);
    expect(poster.calls).toEqual([{ kind: 'settle-hermes', market: m.id, attempt: 0, updates: ['QUNDVQ=='] }]);
  });

  it('does not post an update the program would reject (outside the window) and reports it', async () => {
    const m = await market('SOL');
    const r = hermesReading('SOL', SETTLE_TS + 300);
    hermes.result = { readings: new Map([[r.feedIdHex, r]]), updates: ['QUNDVQ=='] };
    const { l, a } = loop({ mode: 'hermes' });
    const rep = await l.runOnce();
    expect(rep.unavailable).toEqual([m.id]);
    expect(poster.calls).toHaveLength(0);
    expect(a.sent[0]!.message).toMatch(/window|rules/i);
  });

  it('retries a failing settlement with backoff and an escalating priority fee, alerting after three attempts', async () => {
    const m = await market('SOL');
    const r = hermesReading('SOL', SETTLE_TS + 1);
    hermes.result = { readings: new Map([[r.feedIdHex, r]]), updates: ['QUNDVQ=='] };
    poster.failures = [new Error('blockhash not found'), new Error('blockhash not found'), new Error('blockhash not found')];
    const { l, a } = loop({ mode: 'hermes' });

    expect((await l.runOnce()).failed).toEqual([m.id]);
    expect(l.attempts.get(m.id)?.count).toBe(1);
    // within the 5s backoff nothing is retried
    nowMs += 2000;
    await l.runOnce();
    expect(poster.calls).toHaveLength(1);
    nowMs += 4000;
    await l.runOnce();
    expect(poster.calls.map((c) => c.attempt)).toEqual([0, 1]);
    nowMs += 11_000;
    await l.runOnce();
    expect(poster.calls.map((c) => c.attempt)).toEqual([0, 1, 2]);
    expect(a.sent.map((x) => x.key)).toContain(`settle-failed:${m.id}`);

    nowMs += 21_000;
    const ok = await l.runOnce();
    expect(ok.settled).toEqual([m.id]);
    expect(poster.calls[3]).toMatchObject({ attempt: 3 });
    expect(l.attempts.has(m.id)).toBe(false);
  });

  it('treats "market not open" from the program as already resolved, not as a failure', async () => {
    const m = await market('SOL');
    const r = hermesReading('SOL', SETTLE_TS + 1);
    hermes.result = { readings: new Map([[r.feedIdHex, r]]), updates: ['QUNDVQ=='] };
    poster.failures = [new Error('Program log: AnchorError ... Error Code: MarketNotOpen. Error Number: 6006')];
    const { l } = loop({ mode: 'hermes' });
    const rep = await l.runOnce();
    expect(rep.failed).toEqual([]);
    expect(l.attempts.has(m.id)).toBe(false);
  });

  it('survives Hermes outages: the attempt fails and is retried later', async () => {
    const m = await market('SOL');
    hermes.result = new Error('Hermes rejected the request (HTTP 401)');
    const { l } = loop({ mode: 'hermes' });
    expect((await l.runOnce()).failed).toEqual([m.id]);
    expect(poster.calls).toHaveLength(0);
  });

  it('still voids after the grace period when settlement never worked', async () => {
    const m = await market('SOL');
    hermes.result = new Error('down');
    const { l } = loop({ mode: 'hermes' });
    nowMs = (SETTLE_TS + 3601) * 1000;
    const rep = await l.runOnce();
    expect(rep.voided).toEqual([m.id]);
  });
});
