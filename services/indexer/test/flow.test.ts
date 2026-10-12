import { seedReserves } from '@groundgraph/svc-core';
import type { Sql } from '@groundgraph/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { chainMarket, ev, FakeLedger, makeHarness, marketFixture, pk, waitFor, type Harness, type MarketFixture } from './helpers';

let h: Harness;
beforeEach(async () => {
  if (h) await h.stop();
  h = await makeHarness();
});
afterAll(async () => {
  if (h) await h.stop();
});

const T0 = 1_800_000_000;

/** The reference story: create, four trades, settle, redeem, LP exit. Returns who is who. */
function story(ledger: FakeLedger, m: MarketFixture = marketFixture()) {
  const alice = pk().toBase58();
  const bob = pk().toBase58();
  ledger.add([ev.created(m)]);
  ledger.add([ev.trade(m, { wallet: alice, side: 'above', buy: true, usdc: 10_000_000n, shares: 40_000_000n, fee: 100_000n, priceAfterBps: 2300, ts: T0 + 10 })]);
  ledger.add([ev.trade(m, { wallet: bob, side: 'below', buy: true, usdc: 20_000_000n, shares: 25_000_000n, fee: 200_000n, priceAfterBps: 2200, ts: T0 + 20 })]);
  ledger.add([ev.trade(m, { wallet: alice, side: 'above', buy: true, usdc: 5_000_000n, shares: 15_000_000n, fee: 50_000n, priceAfterBps: 2400, ts: T0 + 30 })]);
  ledger.add([ev.trade(m, { wallet: alice, side: 'above', buy: false, usdc: 6_000_000n, shares: 20_000_000n, fee: 60_000n, priceAfterBps: 2350, ts: T0 + 40, ra: 3_100_000_000n, rb: 1_050_000_000n })]);
  return { m, alice, bob };
}

async function dump(sql: Sql) {
  const q = async (rows: PromiseLike<unknown>) => JSON.parse(JSON.stringify(await rows));
  return {
    markets: await q(sql`SELECT id, status, outcome, settle_price, reserve_above, reserve_below, question, category, asset_symbol, target_price, created_tx, created_slot FROM markets ORDER BY id`),
    trades: await q(sql`SELECT market_id, wallet, side, direction, usdc, shares, fee_usdc, price_after, tx_sig, ix_index, slot FROM trades ORDER BY tx_sig, ix_index`),
    positions: await q(sql`SELECT wallet, market_id, side, shares, cost_basis_usdc, realized_pnl FROM positions ORDER BY wallet, market_id, side`),
    scored: await q(sql`SELECT market_id, wallet, side, usdc, entry_price, data_source FROM scored_positions ORDER BY market_id, wallet, side`),
    lp: await q(sql`SELECT wallet, market_id, lp_tokens FROM lp_positions ORDER BY wallet, market_id`),
    redemptions: await q(sql`SELECT wallet, side, shares, usdc, tx_sig, ix_index FROM redemptions ORDER BY tx_sig, ix_index`),
    merges: await q(sql`SELECT wallet, amount, tx_sig, ix_index FROM merges ORDER BY tx_sig, ix_index`),
    liq: await q(sql`SELECT wallet, kind, lp_amount, usdc, seed_above, seed_below, tx_sig, ix_index FROM liquidity_events ORDER BY tx_sig, ix_index`),
  };
}

describe('first start', () => {
  it('indexes markets, trades, positions, scored positions, ticks and the cursor', async () => {
    const { m, alice, bob } = story(h.ledger);
    const stats = await h.indexer.pollOnce();
    expect(stats).toMatchObject({ scanned: 5, processed: 5, stalled: false });

    const [mk] = await h.sql`SELECT * FROM markets WHERE id = ${m.id}`;
    expect(mk).toMatchObject({
      creator: m.creator,
      kind: 'close',
      assetSymbol: 'SOL',
      targetPrice: '250',
      targetExpo: -8,
      targetRaw: '25000000000',
      baseFeeBps: 100,
      status: 'open',
      category: 'Majors',
      question: expect.stringContaining('SOL above or below $250'),
    });
    expect(mk!.createdTx).toMatch(/^sig/);
    // the last trade event carries the post-trade reserves
    expect(mk).toMatchObject({ reserveAbove: '3100000000', reserveBelow: '1050000000' });

    const trades = await h.sql`SELECT wallet, side, direction, usdc, shares, fee_usdc, price_after, ix_index FROM trades ORDER BY id`;
    expect(trades).toHaveLength(4);
    expect(trades[3]).toMatchObject({ wallet: alice, side: 'above', direction: 'sell', usdc: '6000000', shares: '20000000', feeUsdc: '60000', priceAfter: '0.2350', ixIndex: 0 });

    const pos = await h.sql`SELECT wallet, side, shares, cost_basis_usdc, realized_pnl FROM positions WHERE wallet IN ${h.sql([alice, bob])} ORDER BY wallet, side`;
    const a = pos.find((p) => p.wallet === alice)!;
    // cost 15 for 55 shares, 20 sold for 6: released 5_454_545, realized 545_455
    expect(a).toMatchObject({ side: 'above', shares: '35000000', costBasisUsdc: '9545455', realizedPnl: '545455' });
    expect(pos.find((p) => p.wallet === bob)).toMatchObject({ side: 'below', shares: '25000000', costBasisUsdc: '20000000', realizedPnl: '0' });

    const sp = await h.sql`SELECT wallet, side, usdc, entry_price, data_source FROM scored_positions ORDER BY wallet`;
    expect(sp).toHaveLength(2);
    const sa = sp.find((p) => p.wallet === alice)!;
    expect(sa).toMatchObject({ side: 'above', usdc: '9545455', dataSource: 'onchain' });
    expect(Number(sa.entryPrice)).toBeCloseTo(0.233333, 5);
    expect(Number(sp.find((p) => p.wallet === bob)!.entryPrice)).toBeCloseTo(0.22, 6);

    // the creator holds the seeded BELOW shares and the LP tokens
    const seed = seedReserves(m.liquidity, m.p0Bps);
    const cp = await h.sql`SELECT side, shares, cost_basis_usdc FROM positions WHERE wallet = ${m.creator}`;
    expect(cp).toHaveLength(1);
    expect(cp[0]).toMatchObject({ side: 'below', shares: seed.creatorBelow.toString() });
    const [lp] = await h.sql`SELECT lp_tokens FROM lp_positions WHERE wallet = ${m.creator}`;
    expect(lp!.lpTokens).toBe(m.liquidity.toString());

    const ticks = await h.sql`SELECT price_above, fee_bps FROM market_ticks WHERE market_id = ${m.id} ORDER BY ts`;
    expect(ticks).toHaveLength(4);
    expect(Number(ticks[0]!.priceAbove)).toBeCloseTo(0.23, 6);

    const cursor = await h.indexer.loadCursor();
    expect(cursor?.signature).toBe(h.ledger.txs[h.ledger.txs.length - 1]!.signature);
    expect(await h.indexer.loadBackfill()).toMatchObject({ done: true });
    expect(h.indexer.state.indexedSlot).toBe(h.ledger.headSlot);

    // buys count towards today's limit: alice bought 15 USDC and the creator seeded 1000 USDC
    const spent = await h.sql`SELECT wallet, spent_today FROM user_settings ORDER BY wallet`;
    expect(Object.fromEntries(spent.map((s) => [s.wallet, s.spentToday]))).toMatchObject({ [alice]: '15000000', [bob]: '20000000', [m.creator]: '1000000000' });
  });

  it('writes the question the creator asked for', async () => {
    const m = marketFixture();
    await h.redis.set(`q:pending:${m.id}`, 'Will SOL be above $250 on Friday?');
    h.ledger.add([ev.created(m)]);
    await h.indexer.pollOnce();
    const [mk] = await h.sql`SELECT question FROM markets WHERE id = ${m.id}`;
    expect(mk!.question).toBe('Will SOL be above $250 on Friday?');
    expect(await h.redis.get(`q:pending:${m.id}`)).toBeNull();
  });

  it('records an unknown feed with a placeholder symbol instead of failing', async () => {
    const m = marketFixture({ feedIdHex: 'ab'.repeat(32) });
    h.ledger.add([ev.created(m)]);
    await h.indexer.pollOnce();
    const [mk] = await h.sql`SELECT asset_symbol FROM markets WHERE id = ${m.id}`;
    expect(mk!.assetSymbol).toBe('FEED-abababab');
  });
});

describe('idempotency', () => {
  it('polling again changes nothing and fetches nothing', async () => {
    story(h.ledger);
    await h.indexer.pollOnce();
    const before = await dump(h.sql);
    const fetched = h.ledger.calls.getTransaction;
    const stats = await h.indexer.pollOnce();
    expect(stats.scanned).toBe(0);
    expect(h.ledger.calls.getTransaction).toBe(fetched);
    expect(await dump(h.sql)).toEqual(before);
  });

  it('re-reading the whole history from scratch (lost cursor) yields identical rows and publishes nothing new', async () => {
    story(h.ledger);
    await h.indexer.pollOnce();
    await waitFor(() => h.published.length >= 4);
    const before = await dump(h.sql);
    const published = h.published.length;
    await h.sql`DELETE FROM indexer_state`;
    await h.indexer.pollOnce();
    await new Promise((r) => setTimeout(r, 150));
    expect(await dump(h.sql)).toEqual(before);
    expect(h.published.length).toBe(published);
    const n = (await h.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM trades`)[0]!.n;
    expect(n).toBe(4);
  });

  it('applying the same decoded transaction twice writes one row', async () => {
    const { m, alice } = story(h.ledger);
    await h.indexer.pollOnce();
    const logs = h.ledger.txs[1]!;
    const { decodeTx } = await import('../src/decode');
    const decoded = decodeTx(logs)!;
    const r1 = await h.indexer.applyDecoded(decoded);
    const r2 = await h.indexer.applyDecoded(decoded);
    expect(r1).toMatchObject({ inserted: 0, duplicates: 1 });
    expect(r2).toMatchObject({ inserted: 0, duplicates: 1 });
    const n = (await h.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM trades WHERE market_id = ${m.id} AND wallet = ${alice}`)[0]!.n;
    expect(n).toBe(3);
  });

  it('two events in one transaction are keyed by their ordinal', async () => {
    const m = marketFixture();
    const w = pk().toBase58();
    h.ledger.add([ev.created(m)]);
    h.ledger.add([
      ev.trade(m, { wallet: w, side: 'above', buy: true, usdc: 2_000_000n, shares: 8_000_000n, ts: T0 + 5 }),
      ev.trade(m, { wallet: w, side: 'above', buy: true, usdc: 3_000_000n, shares: 9_000_000n, ts: T0 + 5 }),
    ]);
    await h.indexer.pollOnce();
    const rows = await h.sql`SELECT ix_index, usdc FROM trades ORDER BY ix_index`;
    expect(rows.map((r) => [r.ixIndex, r.usdc])).toEqual([[0, '2000000'], [1, '3000000']]);
    const [p] = await h.sql`SELECT shares, cost_basis_usdc FROM positions WHERE wallet = ${w}`;
    expect(p).toMatchObject({ shares: '17000000', costBasisUsdc: '5000000' });
  });
});

describe('restart and catch-up', () => {
  it('a restarted indexer continues from the persisted cursor', async () => {
    const { m, alice } = story(h.ledger);
    await h.indexer.pollOnce();
    const next = h.restart();
    h.ledger.add([ev.trade(m, { wallet: alice, side: 'above', buy: true, usdc: 1_000_000n, shares: 3_000_000n, ts: T0 + 50 })]);
    const calls = h.ledger.calls.getTransaction;
    const stats = await next.pollOnce();
    expect(stats).toMatchObject({ scanned: 1, processed: 1 });
    expect(h.ledger.calls.getTransaction).toBe(calls + 1);
    const n = (await h.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM trades`)[0]!.n;
    expect(n).toBe(5);
  });

  it('pages through more than one batch of new signatures', async () => {
    const small = await makeHarness({ opts: { batchSize: 10 } });
    try {
      const m = marketFixture();
      small.ledger.add([ev.created(m)]);
      await small.indexer.pollOnce();
      const w = pk().toBase58();
      for (let i = 0; i < 37; i++) small.ledger.add([ev.trade(m, { wallet: w, side: 'above', buy: true, usdc: 1_000_000n, shares: 2_000_000n, ts: T0 + i })]);
      const stats = await small.indexer.pollOnce();
      expect(stats.scanned).toBe(37);
      const n = (await small.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM trades`)[0]!.n;
      expect(n).toBe(37);
    } finally {
      await small.stop();
    }
  });

  it('stalls in front of a transaction the node cannot return yet, then recovers', async () => {
    const { m, alice } = story(h.ledger);
    await h.indexer.pollOnce();
    const missing = h.ledger.add([ev.trade(m, { wallet: alice, side: 'above', buy: true, usdc: 1_000_000n, shares: 3_000_000n, ts: T0 + 60 })]);
    const after = h.ledger.add([ev.trade(m, { wallet: alice, side: 'above', buy: true, usdc: 2_000_000n, shares: 6_000_000n, ts: T0 + 61 })]);
    h.ledger.unavailable.add(missing);
    const st = await h.indexer.pollOnce();
    expect(st).toMatchObject({ scanned: 2, processed: 0, stalled: true });
    expect((await h.indexer.loadCursor())?.signature).not.toBe(after);
    h.ledger.unavailable.delete(missing);
    const st2 = await h.indexer.pollOnce();
    expect(st2).toMatchObject({ processed: 2, stalled: false });
    expect((await h.indexer.loadCursor())?.signature).toBe(after);
  });

  it('skips failed transactions and foreign programs', async () => {
    const { m, alice } = story(h.ledger);
    h.ledger.add([ev.trade(m, { wallet: alice, side: 'below', buy: true, usdc: 9_000_000n, shares: 9_000_000n, ts: T0 + 70 })], { failed: true });
    h.ledger.add([ev.trade(m, { wallet: alice, side: 'below', buy: true, usdc: 9_000_000n, shares: 9_000_000n, ts: T0 + 71 })], { programId: pk() });
    await h.indexer.pollOnce();
    const n = (await h.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM trades`)[0]!.n;
    expect(n).toBe(4);
  });

  it('an unknown cursor signature (dropped fork) does not re-walk the whole history', async () => {
    const small = await makeHarness({ opts: { batchSize: 10 } });
    try {
      const m = marketFixture();
      const w = pk().toBase58();
      small.ledger.add([ev.created(m)]);
      for (let i = 0; i < 60; i++) small.ledger.add([ev.trade(m, { wallet: w, side: 'above', buy: true, usdc: 1_000_000n, shares: 2_000_000n, ts: T0 + i })], { slot: 2_000 + i * 10 });
      await small.indexer.pollOnce(); // fresh: newest page only
      await small.indexer.loadCursor();
      small.ledger.dropped.add(small.ledger.txs[small.ledger.txs.length - 1]!.signature); // the cursor transaction vanishes
      small.ledger.add([ev.trade(m, { wallet: w, side: 'above', buy: true, usdc: 1_000_000n, shares: 2_000_000n, ts: T0 + 99 })], { slot: 3_000 });
      small.ledger.calls.getSignatures = 0;
      const stats = await small.indexer.pollOnce();
      expect(stats.scanned).toBeLessThanOrEqual(10);
      expect(small.ledger.calls.getSignatures).toBeLessThanOrEqual(2);
    } finally {
      await small.stop();
    }
  });
});

describe('backfill', () => {
  function bulk(ledger: FakeLedger, m: MarketFixture, n: number) {
    const wallets = Array.from({ length: 7 }, () => pk().toBase58());
    ledger.add([ev.created(m)]);
    const held = new Map<string, bigint>();
    for (let i = 0; i < n; i++) {
      const w = wallets[i % wallets.length]!;
      const side = i % 3 === 0 ? ('below' as const) : ('above' as const);
      const key = `${w}:${side}`;
      const have = held.get(key) ?? 0n;
      const sell = have > 5_000_000n && i % 4 === 0;
      const shares = sell ? 3_000_000n : BigInt(4_000_000 + (i % 5) * 1_000_000);
      held.set(key, sell ? have - shares : have + shares);
      ledger.add([ev.trade(m, { wallet: w, side, buy: !sell, usdc: shares / 3n, shares, fee: 1_000n, priceAfterBps: 2000 + (i % 40) * 10, ts: T0 + i })]);
    }
    ledger.add([ev.settled(m, 'above')]);
    for (const w of wallets) ledger.add([ev.redeemed(m, w, 'above', 1_000_000n, 1_000_000n)]);
  }

  it('walking the history backwards converges to exactly what in-order ingestion produces', async () => {
    const m = marketFixture();
    const ordered = await makeHarness({ opts: { batchSize: 1000 } });
    bulk(ordered.ledger, m, 120);
    await ordered.indexer.pollOnce();
    const expected = await dump(ordered.sql);
    const markets = chainMarket(m, { status: 'settled', outcome: 'above' });
    await ordered.stop();

    h = await makeHarness({ opts: { batchSize: 25 } });
    bulk(h.ledger, m, 120);
    h.ledger.markets.set(m.id, markets);
    // same signatures as the reference run so rows compare equal
    h.ledger.txs.forEach((t, i) => (t.signature = `sig${String(i).padStart(6, '0')}x`));
    const first = await h.indexer.pollOnce();
    expect(first.scanned).toBe(25); // a fresh database takes only the newest page live
    expect(await h.indexer.loadBackfill()).toMatchObject({ done: false });
    let steps = 0;
    while ((await h.indexer.backfillStep()).more) steps++;
    expect(steps).toBeGreaterThanOrEqual(4);
    expect(await h.indexer.loadBackfill()).toMatchObject({ done: true });

    const got = await dump(h.sql);
    const norm = (d: Awaited<ReturnType<typeof dump>>) => ({
      positions: d.positions.map((p: Record<string, string>) => [p.wallet === m.creator ? 'creator' : 'w', p.side, p.shares, p.costBasisUsdc, p.realizedPnl].join('|')).sort(),
      trades: d.trades.length,
      redemptions: d.redemptions.length,
      liq: d.liq.length,
      scoredN: d.scored.length,
    });
    // wallet addresses differ between the two runs, so compare the multiset of (side, shares, cost, realized)
    expect(norm(got)).toEqual(norm(expected));
    expect(got.markets[0]).toMatchObject({ status: 'settled', outcome: 'above' });
  });

  it('is resumable: an interrupted run continues where it stopped and ends in the same state', async () => {
    const m = marketFixture();
    h = await makeHarness({ opts: { batchSize: 20 } });
    bulk(h.ledger, m, 90);
    h.ledger.markets.set(m.id, chainMarket(m));
    await h.indexer.pollOnce();
    await h.indexer.backfillStep();
    await h.indexer.backfillStep();
    const mid = await h.indexer.loadBackfill();
    expect(mid).toMatchObject({ done: false });
    expect(mid!.processed).toBeGreaterThanOrEqual(60);

    const next = h.restart(); // process restart
    let guard = 0;
    while ((await next.backfillStep()).more && guard++ < 50);
    const n = (await h.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM trades`)[0]!.n;
    expect(n).toBe(90);
    const after = await next.backfillStep();
    expect(after).toMatchObject({ more: false, scanned: 0 });
  });

  it('--reset style rewind re-reads history without duplicating rows', async () => {
    const m = marketFixture();
    h = await makeHarness({ opts: { batchSize: 30 } });
    bulk(h.ledger, m, 50);
    h.ledger.markets.set(m.id, chainMarket(m));
    await h.indexer.pollOnce();
    while ((await h.indexer.backfillStep()).more);
    const before = await dump(h.sql);
    await h.indexer.resetBackfill();
    while ((await h.indexer.backfillStep()).more);
    expect(await dump(h.sql)).toEqual(before);
  });
});

describe('markets the indexer did not see being created', () => {
  it('bootstraps the market from its account and then indexes the trades', async () => {
    const m = marketFixture();
    const w = pk().toBase58();
    h.ledger.markets.set(m.id, chainMarket(m));
    h.ledger.add([ev.trade(m, { wallet: w, side: 'above', buy: true, usdc: 4_000_000n, shares: 9_000_000n, ts: T0 + 3 })]);
    await h.indexer.pollOnce();
    const [mk] = await h.sql`SELECT created_tx, asset_symbol, creator, target_price FROM markets WHERE id = ${m.id}`;
    expect(mk).toMatchObject({ createdTx: null, assetSymbol: 'SOL', creator: m.creator, targetPrice: '250' });
    const n = (await h.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM trades`)[0]!.n;
    expect(n).toBe(1);
  });

  it('skips events of markets that do not exist on chain without failing the batch', async () => {
    const ghost = marketFixture();
    const real = marketFixture();
    const w = pk().toBase58();
    h.ledger.add([ev.trade(ghost, { wallet: w, side: 'above', buy: true, usdc: 4_000_000n, shares: 9_000_000n, ts: T0 + 3 })]);
    h.ledger.add([ev.created(real)]);
    const st = await h.indexer.pollOnce();
    expect(st).toMatchObject({ processed: 2, stalled: false });
    const n = (await h.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM markets`)[0]!.n;
    expect(n).toBe(1);
  });

  it('a late MarketCreated for a bootstrapped market only fills in the creation transaction', async () => {
    const m = marketFixture();
    h.ledger.markets.set(m.id, chainMarket(m));
    const w = pk().toBase58();
    // history arrives newest first during a backfill: the trade is processed before the creation
    h.ledger.add([ev.created(m)]);
    h.ledger.add([ev.trade(m, { wallet: w, side: 'above', buy: true, usdc: 4_000_000n, shares: 9_000_000n, ts: T0 + 3 })]);
    const small = await makeHarness({ keepData: true, ledger: h.ledger, opts: { batchSize: 1 } });
    try {
      await small.indexer.pollOnce(); // newest page: the trade, bootstraps the market
      let g = 0;
      while ((await small.indexer.backfillStep()).more && g++ < 10);
      const [mk] = await small.sql`SELECT created_tx, created_slot FROM markets WHERE id = ${m.id}`;
      expect(mk!.createdTx).toBe(h.ledger.txs[0]!.signature);
      expect(mk!.createdSlot).toBe(h.ledger.txs[0]!.slot);
      const liq = await small.sql`SELECT kind FROM liquidity_events WHERE market_id = ${m.id}`;
      expect(liq).toHaveLength(1);
    } finally {
      await small.stop();
    }
  });
});

describe('settlement, redemption and liquidity', () => {
  it('settles, redeems and mirrors the result; scored positions freeze at settlement', async () => {
    const { m, alice, bob } = story(h.ledger);
    h.ledger.add([ev.settled(m, 'above')]);
    h.ledger.add([ev.redeemed(m, alice, 'above', 35_000_000n, 35_000_000n)]);
    h.ledger.add([ev.redeemed(m, bob, 'below', 25_000_000n, 0n)]);
    h.ledger.add([ev.liquidity(m, m.creator, 400_000_000n, 380_000_000n, false)]);
    h.ledger.markets.set(m.id, chainMarket(m, { status: 'settled', outcome: 'above', lpClaim: 400_000_000n }));
    await h.indexer.pollOnce();

    const [mk] = await h.sql`SELECT status, outcome, settle_price, settle_expo, settle_publish_ts, lp_claim_remaining FROM markets WHERE id = ${m.id}`;
    expect(mk).toMatchObject({ status: 'settled', outcome: 'above', settlePrice: '255', settleExpo: -8, lpClaimRemaining: '400000000' });
    expect(mk!.settlePublishTs.toISOString()).toBe(new Date((m.settleTs + 5) * 1000).toISOString());

    const pos = await h.sql`SELECT wallet, shares, cost_basis_usdc, realized_pnl FROM positions WHERE wallet IN ${h.sql([alice, bob])}`;
    expect(pos.find((p) => p.wallet === alice)).toMatchObject({ shares: '0', costBasisUsdc: '0', realizedPnl: '26000000' });
    expect(pos.find((p) => p.wallet === bob)).toMatchObject({ shares: '0', costBasisUsdc: '0', realizedPnl: '-20000000' });

    // frozen: both scored rows still describe the position that was held at settlement
    const sp = await h.sql`SELECT wallet, usdc FROM scored_positions ORDER BY wallet`;
    expect(Object.fromEntries(sp.map((r) => [r.wallet, r.usdc]))).toEqual({ [alice]: '9545455', [bob]: '20000000' });

    const [lp] = await h.sql`SELECT lp_tokens FROM lp_positions WHERE wallet = ${m.creator}`;
    expect(lp!.lpTokens).toBe('600000000');
    const reds = await h.sql`SELECT wallet, usdc FROM redemptions ORDER BY id`;
    expect(reds).toHaveLength(2);
  });

  it('a voided market is mirrored without an outcome', async () => {
    const { m } = story(h.ledger);
    h.ledger.add([ev.voided(m)]);
    await h.indexer.pollOnce();
    const [mk] = await h.sql`SELECT status, outcome, lp_claim_remaining FROM markets WHERE id = ${m.id}`;
    expect(mk).toMatchObject({ status: 'voided', outcome: null, lpClaimRemaining: '500000000' });
  });

  it('closing a position on an open market removes its scored row', async () => {
    const { m, alice } = story(h.ledger);
    h.ledger.add([ev.trade(m, { wallet: alice, side: 'above', buy: false, usdc: 11_000_000n, shares: 35_000_000n, ts: T0 + 80 })]);
    await h.indexer.pollOnce();
    const sp = await h.sql`SELECT wallet FROM scored_positions`;
    expect(sp.map((r) => r.wallet)).not.toContain(alice);
    const [p] = await h.sql`SELECT shares, realized_pnl FROM positions WHERE wallet = ${alice} AND side = 'above'`;
    expect(p).toMatchObject({ shares: '0', realizedPnl: '2000000' }); // 0.545455 + (11 - 9.545455)
  });

  it('merges burn both sides and realize pnl', async () => {
    const m = marketFixture();
    const w = pk().toBase58();
    h.ledger.add([ev.created(m)]);
    h.ledger.add([ev.trade(m, { wallet: w, side: 'above', buy: true, usdc: 3_000_000n, shares: 10_000_000n, ts: T0 + 1 })]);
    h.ledger.add([ev.trade(m, { wallet: w, side: 'below', buy: true, usdc: 6_000_000n, shares: 10_000_000n, ts: T0 + 2 })]);
    h.ledger.add([ev.merged(m, w, 10_000_000n)]);
    await h.indexer.pollOnce();
    const rows = await h.sql`SELECT side, shares, cost_basis_usdc, realized_pnl FROM positions WHERE wallet = ${w} ORDER BY side`;
    expect(rows.every((r) => r.shares === '0' && r.costBasisUsdc === '0')).toBe(true);
    expect(rows.reduce((s, r) => s + BigInt(r.realizedPnl as string), 0n)).toBe(1_000_000n);
    const [mg] = await h.sql`SELECT amount FROM merges WHERE wallet = ${w}`;
    expect(mg!.amount).toBe('10000000');
    const sp = await h.sql`SELECT wallet FROM scored_positions WHERE wallet = ${w}`;
    expect(sp).toHaveLength(0);
  });
});

describe('reconcile against the account', () => {
  it('copies reserves, pool totals, fee state and status from the account', async () => {
    const { m } = story(h.ledger);
    await h.indexer.pollOnce();
    h.ledger.headSlot += 5;
    h.ledger.markets.set(m.id, chainMarket(m, { ra: 3_200_000_000n, rb: 1_100_000_000n, sets: 1_050_000_000n, feePool: 410_000n }));
    expect(await h.indexer.reconcile()).toBe(1);
    const [mk] = await h.sql`SELECT reserve_above, reserve_below, complete_sets, fee_pool, ema_impact_bps, ema_ts, reconciled_at FROM markets WHERE id = ${m.id}`;
    expect(mk).toMatchObject({ reserveAbove: '3200000000', reserveBelow: '1100000000', completeSets: '1050000000', feePool: '410000', emaImpactBps: 7, emaTs: 1_800_000_050 });
    expect(mk!.reconciledAt).toBeInstanceOf(Date);
  });

  it('does not overwrite newer event state with an older account read', async () => {
    const { m } = story(h.ledger);
    await h.indexer.pollOnce();
    const slotOfLastTrade = h.ledger.txs[4]!.slot;
    h.ledger.headSlot = slotOfLastTrade - 3; // the read happened before the last trade landed
    h.ledger.markets.set(m.id, chainMarket(m, { ra: 1n, rb: 2n }));
    await h.indexer.reconcile();
    const [mk] = await h.sql`SELECT reserve_above FROM markets WHERE id = ${m.id}`;
    expect(mk!.reserveAbove).toBe('3100000000');
  });

  it('flips a market back to open when a Settled event turns out not to have survived', async () => {
    const { m } = story(h.ledger);
    h.ledger.add([ev.settled(m)]);
    await h.indexer.pollOnce();
    h.ledger.headSlot += 10;
    h.ledger.markets.set(m.id, chainMarket(m)); // account still open
    await h.indexer.reconcile();
    const [mk] = await h.sql`SELECT status, outcome, settle_price FROM markets WHERE id = ${m.id}`;
    expect(mk).toMatchObject({ status: 'open', outcome: null, settlePrice: null });
  });
});

describe('finalization', () => {
  it('promotes confirmed rows to finalized once the cluster finalizes them', async () => {
    const { m } = story(h.ledger);
    await h.indexer.pollOnce();
    h.ledger.finalizedSlot = h.ledger.txs[2]!.slot;
    const r1 = await h.indexer.finalizePass();
    expect(r1.finalized).toBe(3);
    let n = (await h.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM trades WHERE finalized`)[0]!.n;
    expect(n).toBe(2);
    const [mk] = await h.sql`SELECT created_finalized FROM markets WHERE id = ${m.id}`;
    expect(mk!.createdFinalized).toBe(true);
    h.ledger.finalizedSlot = h.ledger.headSlot;
    await h.indexer.finalizePass();
    n = (await h.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM trades WHERE NOT finalized`)[0]!.n;
    expect(n).toBe(0);
  });

  it('removes a dropped transaction after two passes and rebuilds the positions it affected', async () => {
    const { m, alice } = story(h.ledger);
    await h.indexer.pollOnce();
    const dropped = h.ledger.txs[3]!.signature; // alice's second buy
    h.ledger.dropped.add(dropped);
    h.ledger.finalizedSlot = h.ledger.headSlot;
    const r1 = await h.indexer.finalizePass();
    expect(r1.dropped).toBe(0); // one miss is not enough
    const r2 = await h.indexer.finalizePass();
    expect(r2.dropped).toBe(1);
    const trades = await h.sql`SELECT tx_sig FROM trades`;
    expect(trades.map((t) => t.txSig)).not.toContain(dropped);
    // buy 10 for 40, sell 20 for 6 -> released 5, realized +1, left 20 shares at cost 5
    const [p] = await h.sql`SELECT shares, cost_basis_usdc, realized_pnl FROM positions WHERE wallet = ${alice} AND market_id = ${m.id}`;
    expect(p).toMatchObject({ shares: '20000000', costBasisUsdc: '5000000', realizedPnl: '1000000' });
    const [sp] = await h.sql`SELECT usdc FROM scored_positions WHERE wallet = ${alice}`;
    expect(sp!.usdc).toBe('5000000');
  });

  it('a market whose creation was dropped disappears with everything under it', async () => {
    const { m } = story(h.ledger);
    await h.indexer.pollOnce();
    h.ledger.dropped.add(h.ledger.txs[0]!.signature);
    h.ledger.finalizedSlot = h.ledger.headSlot;
    await h.indexer.finalizePass();
    await h.indexer.finalizePass();
    const n = (await h.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM markets WHERE id = ${m.id}`)[0]!.n;
    expect(n).toBe(0);
    const t = (await h.sql<{ t: number }[]>`SELECT count(*)::int AS t FROM trades`)[0]!.t;
    expect(t).toBe(0);
  });

  it('keeps rows that the cluster still knows about but has not finalized', async () => {
    story(h.ledger);
    await h.indexer.pollOnce();
    h.ledger.finalizedSlot = h.ledger.headSlot;
    for (const t of h.ledger.txs) h.ledger.notFinalized.add(t.signature);
    const r = await h.indexer.finalizePass();
    const r2 = await h.indexer.finalizePass();
    expect(r).toMatchObject({ finalized: 0, dropped: 0 });
    expect(r2).toMatchObject({ finalized: 0, dropped: 0 });
    const n = (await h.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM trades`)[0]!.n;
    expect(n).toBe(4);
  });
});

describe('ticks', () => {
  it('writes one snapshot per open market and minute', async () => {
    const { m } = story(h.ledger);
    const other = marketFixture();
    h.ledger.add([ev.created(other)]);
    h.ledger.add([ev.settled(m)]);
    await h.indexer.pollOnce();
    expect(await h.indexer.snapshotTicks()).toBe(1); // only the open market
    expect(await h.indexer.snapshotTicks()).toBe(0); // same minute: no duplicate
    const rows = await h.sql`SELECT price_above, fee_bps FROM market_ticks WHERE market_id = ${other.id}`;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.priceAbove)).toBeCloseTo(0.21, 2);
    expect(rows[0]!.feeBps).toBe(100);
  });
});

describe('redis publishing', () => {
  it('publishes market deltas with the trade and per-wallet fills', async () => {
    const { m, alice } = story(h.ledger);
    await h.indexer.pollOnce();
    await waitFor(() => h.published.filter((p) => p.channel === `gg:ch:market:${m.id}`).length >= 4);
    const deltas = h.published.filter((p) => p.channel === `gg:ch:market:${m.id}`).map((p) => p.message);
    const last = deltas[deltas.length - 1]!;
    expect(last.type).toBe('delta');
    expect(last.data).toMatchObject({ priceAbove: 0.235, reserveAbove: '3100000000', reserveBelow: '1050000000', trade: { wallet: alice, dir: 'sell', side: 'above', usdc: '6000000', priceAfter: 0.235 } });
    const fills = h.published.filter((p) => p.channel === `gg:ch:me:${alice}`).map((p) => p.message.data);
    expect(fills).toHaveLength(3);
    expect(fills[2]).toMatchObject({ kind: 'fill', marketId: m.id, dir: 'sell' });
  });

  it('tells every holder when the market settles', async () => {
    const { m, alice, bob } = story(h.ledger);
    h.ledger.add([ev.settled(m, 'below')]);
    await h.indexer.pollOnce();
    await waitFor(() => h.published.filter((p) => p.message.data['kind'] === 'settled').length >= 3);
    const targets = h.published.filter((p) => p.message.data['kind'] === 'settled').map((p) => p.channel);
    expect(targets).toEqual(expect.arrayContaining([`gg:ch:me:${alice}`, `gg:ch:me:${bob}`, `gg:ch:me:${m.creator}`]));
    const market = h.published.filter((p) => p.channel === `gg:ch:market:${m.id}`).map((p) => p.message.data);
    expect(market[market.length - 1]).toMatchObject({ status: 'settled', outcome: 'below' });
  });

  it('marks trades of flagged wallets', async () => {
    const m = marketFixture();
    const smart = pk().toBase58();
    await h.sql`INSERT INTO wallet_scores (address, as_of, smart, data_source) VALUES (${smart}, now(), true, 'onchain')`.catch(() => undefined);
    h.ledger.add([ev.created(m)]);
    h.ledger.add([ev.trade(m, { wallet: smart, side: 'above', buy: true, usdc: 2_000_000n, shares: 5_000_000n, ts: T0 + 5 })]);
    await h.indexer.pollOnce();
    await waitFor(() => h.published.some((p) => p.channel === `gg:ch:market:${m.id}` && p.message.data['trade']));
    const t = h.published.find((p) => p.channel === `gg:ch:market:${m.id}`)!.message.data['trade'] as { flagged: boolean };
    expect(typeof t.flagged).toBe('boolean');
  });

  it('drops the matching pending reservation when the buy is indexed', async () => {
    const { m, alice } = story(h.ledger);
    const key = `rt:pending:${alice}`;
    await h.redis.zadd(key, Date.now() + 120_000, '10000000:aaaa', Date.now() + 120_000, '7000000:bbbb');
    await h.indexer.pollOnce();
    expect(await h.redis.zrange(key, 0, -1)).toEqual(['7000000:bbbb']);
    expect(m.id).toBeTruthy();
  });
});
