import { PROGRAM_ID } from '@groundgraph/svc-core';
import { ComputeBudgetProgram, Keypair, VersionedTransaction } from '@solana/web3.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { b64tx, makeHarness, seedMarket, setOracle, signIn, viewIn, type Harness } from './helpers';

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
});
afterAll(async () => {
  await h.close();
});

const U = (usdc: number) => String(Math.round(usdc * 1e6));
const post = (url: string, cookie: string | undefined, payload: unknown, headers: Record<string, string> = {}) =>
  h.app.inject({ method: 'POST', url, headers: { ...(cookie ? { cookie } : {}), ...headers }, payload: payload as never });

function decodeTx(b64: string) {
  const tx = VersionedTransaction.deserialize(b64tx(b64));
  const keys = tx.message.staticAccountKeys;
  const programs = tx.message.compiledInstructions.map((i) => keys[i.programIdIndex]!.toBase58());
  return { tx, keys, programs };
}

describe('session and ToS gating on /tx/*', () => {
  let market: Awaited<ReturnType<typeof seedMarket>>;
  beforeEach(async () => {
    market = await seedMarket(h);
    await setOracle(h, 'SOL');
  });

  it('401 without a session, 403 view_only for a pasted address', async () => {
    const body = { marketId: market.id, side: 'above', amount: U(10) };
    for (const path of ['buy', 'sell', 'merge', 'redeem', 'create']) {
      const r = await post(`/tx/${path}`, undefined, path === 'merge' ? { marketId: market.id, amount: U(1) } : body);
      expect([400, 401], path).toContain(r.statusCode); // create/merge bodies fail validation first with the wrong shape
    }
    const noSession = await post('/tx/buy', undefined, body);
    expect(noSession.statusCode).toBe(401);
    expect(noSession.json().error.code).toBe('unauthorized');
    const { cookie } = await viewIn(h, Keypair.generate().publicKey.toBase58());
    const view = await post('/tx/buy', cookie, body);
    expect(view.statusCode).toBe(403);
    expect(view.json().error.code).toBe('view_only');
    for (const path of ['sell', 'redeem']) expect((await post(`/tx/${path}`, cookie, body)).json().error.code).toBe('view_only');
    expect((await post('/tx/merge', cookie, { marketId: market.id, amount: U(1) })).json().error.code).toBe('view_only');
  });

  it('403 tos_required when the wallet has not accepted the current Terms version', async () => {
    const s = await signIn(h);
    await h.sql`DELETE FROM tos_acceptances WHERE wallet = ${s.wallet}`;
    const r = await post('/tx/buy', s.cookie, { marketId: market.id, side: 'above', amount: U(10) });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('tos_required');
    expect(r.json().error.details).toEqual({ tosVersion: '2026-10-01' });
    // accepting through /auth/tos unlocks it
    const acc = await post('/auth/tos', s.cookie, { tosVersion: '2026-10-01' });
    expect(acc.statusCode).toBe(200);
    expect((await post('/tx/buy', s.cookie, { marketId: market.id, side: 'above', amount: U(10) })).statusCode).toBe(200);
  });

  it('sign + ToS returns an UNSIGNED v0 transaction with compute budget and priority fee', async () => {
    const s = await signIn(h);
    const r = await post('/tx/buy', s.cookie, { marketId: market.id, side: 'above', amount: U(10), slippageBps: 100 });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.blockhash).toBeTruthy();
    expect(body.lastValidBlockHeight).toBe(123456);
    expect(body.summary).toMatch(/^Buy ABOVE/);
    expect(body.receipt).toMatchObject({ side: 'above', dir: 'buy', amountIn: U(10), slippageBps: 100 });
    const { tx, keys, programs } = decodeTx(body.transaction);
    expect(tx.version).toBe(0);
    expect(keys[0]!.toBase58()).toBe(s.wallet); // fee payer is the user
    expect(tx.signatures.every((sig) => sig.every((b) => b === 0))).toBe(true); // nothing is signed server side
    expect(programs[0]).toBe(ComputeBudgetProgram.programId.toBase58());
    expect(programs[1]).toBe(ComputeBudgetProgram.programId.toBase58());
    expect(programs).toContain(PROGRAM_ID.toBase58());
  });
});

describe('buy enforcement', () => {
  let market: Awaited<ReturnType<typeof seedMarket>>;
  let s: Awaited<ReturnType<typeof signIn>>;
  beforeEach(async () => {
    market = await seedMarket(h);
    await setOracle(h, 'SOL');
    s = await signIn(h);
    h.chain.simResult = { err: null, logs: [] };
    h.chain.defaultBalance = 100_000_000_000n;
  });
  const buy = (amount: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    post('/tx/buy', s.cookie, { marketId: market.id, side: 'above', amount, ...extra }, headers);

  it('minimum trade is 1 USDC', async () => {
    const r = await buy('999999');
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('below_min_trade');
    expect((await buy(U(1))).statusCode).toBe(200);
  });

  it('closed, settled and voided markets refuse buys', async () => {
    const closed = await seedMarket(h, { tradingEndInSecs: -10, settleInSecs: 3000 });
    const r = await post('/tx/buy', s.cookie, { marketId: closed.id, side: 'above', amount: U(5) });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('market_closed');
    const settled = await seedMarket(h, { status: 'settled', outcome: 'above' });
    expect((await post('/tx/buy', s.cookie, { marketId: settled.id, side: 'above', amount: U(5) })).json().error.code).toBe('market_closed');
    expect((await post('/tx/buy', s.cookie, { marketId: Keypair.generate().publicKey.toBase58(), side: 'above', amount: U(5) })).json().error.code).toBe('not_found');
  });

  it('a protocol pause blocks buys', async () => {
    h.chain.config = { ...h.chain.config!, paused: true };
    try {
      expect((await buy(U(5))).json().error.code).toBe('market_closed');
    } finally {
      h.chain.config = { ...h.chain.config!, paused: false };
    }
  });

  it('stale or missing oracle blocks buys with oracle_stale', async () => {
    await setOracle(h, 'SOL', { ageSec: 120 });
    const r = await buy(U(5));
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('oracle_stale');
    await h.redis.flushdb();
    expect((await buy(U(5))).json().error.code).toBe('oracle_stale');
    await setOracle(h, 'SOL', { fetchedAgoMs: 60_000 }); // keeper stopped refreshing
    expect((await buy(U(5))).json().error.code).toBe('oracle_stale');
    await setOracle(h, 'SOL');
    expect((await buy(U(5))).statusCode).toBe(200);
  });

  it('a break blocks buys, and can only be extended', async () => {
    const day = await post('/me/break', s.cookie, { days: 1 });
    expect(day.statusCode).toBe(200);
    const until = day.json().breakUntil as string;
    expect(Date.parse(until) - h.nowMs()).toBeGreaterThan(23.9 * 3600_000);
    const r = await buy(U(5));
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('break_active');
    expect(r.json().error.details.breakUntil).toBe(until);
    // shorter request never shortens the break
    const again = await post('/me/break', s.cookie, { days: 7 });
    const longer = again.json().breakUntil as string;
    expect(Date.parse(longer)).toBeGreaterThan(Date.parse(until));
    const shorter = await post('/me/break', s.cookie, { days: 1 });
    expect(shorter.json().breakUntil).toBe(longer);
  });

  it('a break ends by itself', async () => {
    market = await seedMarket(h, { tradingEndInSecs: 3 * 86400, settleInSecs: 4 * 86400 });
    await post('/me/break', s.cookie, { days: 1 });
    expect((await buy(U(5))).json().error.code).toBe('break_active');
    h.advance(25 * 3600_000); // session (7 days) is still valid
    try {
      await setOracle(h, 'SOL');
      expect((await buy(U(5))).statusCode).toBe(200);
      const me = await h.app.inject({ url: '/me', headers: { cookie: s.cookie } });
      expect(me.json().settings.breakUntil).toBeNull();
    } finally {
      h.advance(-25 * 3600_000);
    }
  });

  it('the daily limit counts confirmed spend plus unconfirmed reservations', async () => {
    const put = await h.app.inject({ method: 'PUT', url: '/me/settings', headers: { cookie: s.cookie }, payload: { dailyLimitUsdc: U(100), sessionReminder: false } });
    expect(put.json()).toMatchObject({ dailyLimitUsdc: U(100), spentToday: '0' });
    expect((await buy(U(60))).statusCode).toBe(200); // reserves 60 until the indexer confirms
    const over = await buy(U(60));
    expect(over.statusCode).toBe(403);
    expect(over.json().error.code).toBe('daily_limit_exceeded');
    expect(over.json().error.details).toMatchObject({ limit: U(100), spent: U(60), remaining: U(40) });
    expect((await buy(U(40))).statusCode).toBe(200);
    // confirmed spend (written by the indexer) is honoured too
    await h.sql`UPDATE user_settings SET spent_today = ${U(100)} WHERE wallet = ${s.wallet}`;
    await h.redis.flushdb();
    await setOracle(h, 'SOL');
    expect((await buy(U(1))).json().error.code).toBe('daily_limit_exceeded');
    // no limit at all
    await h.app.inject({ method: 'PUT', url: '/me/settings', headers: { cookie: s.cookie }, payload: { dailyLimitUsdc: null, sessionReminder: true } });
    expect((await buy(U(5000))).statusCode).toBe(200);
  });

  it('the daily counter resets on the next UTC day', async () => {
    await h.sql`UPDATE user_settings SET spent_today = ${U(500)}, day = ${new Date(h.nowMs() - 2 * 86_400_000).toISOString().slice(0, 10)}::date WHERE wallet = ${s.wallet}`;
    expect((await buy(U(10))).statusCode).toBe(200);
  });

  it('maps a SlippageExceeded simulation failure to slippage_exceeded', async () => {
    h.chain.simResult = { err: { InstructionError: [2, { Custom: 6000 + 23 }] }, logs: ['Program log: AnchorError ... Error Code: SlippageExceeded. Error Number: 6023.'] };
    const ctxCfg = h.ctx.cfg as { SIMULATE_TX: boolean };
    ctxCfg.SIMULATE_TX = true;
    try {
      const r = await buy(U(5));
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe('slippage_exceeded');
      expect(r.json().error.details).toEqual({ suggestSlippageBps: 200 });
      h.chain.simResult = { err: { InstructionError: [2, { Custom: 6000 + 21 }] }, logs: [] }; // by number only
      expect((await buy(U(5))).json().error.code).toBe('below_min_trade');
    } finally {
      ctxCfg.SIMULATE_TX = false;
    }
  });

  it('refuses a buy larger than the wallet balance with a clear message', async () => {
    h.chain.defaultBalance = 3_000_000n;
    const r = await buy(U(5));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details).toMatchObject({ reason: 'insufficient_balance', have: '3000000', need: U(5) });
  });

  it('geo-blocks buys from a blocked country but never sells', async () => {
    const r = await buy(U(5), {}, { 'cf-ipcountry': 'US' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('geo_blocked');
    const sell = await post('/tx/sell', s.cookie, { marketId: market.id, side: 'above', amount: U(5) }, { 'cf-ipcountry': 'US' });
    expect(sell.statusCode).toBe(200);
  });
});

describe('sell, merge and redeem are never blocked by break, limit or oracle', () => {
  it('stay available while a break is active, the limit is exhausted and the oracle is stale', async () => {
    const market = await seedMarket(h);
    const s = await signIn(h);
    await post('/me/break', s.cookie, { days: 30 });
    await h.app.inject({ method: 'PUT', url: '/me/settings', headers: { cookie: s.cookie }, payload: { dailyLimitUsdc: U(1), sessionReminder: false } });
    await h.sql`UPDATE user_settings SET spent_today = ${U(1)} WHERE wallet = ${s.wallet}`;
    await h.redis.flushdb(); // no oracle snapshot at all
    expect((await post('/tx/buy', s.cookie, { marketId: market.id, side: 'above', amount: U(5) })).statusCode).toBe(403);
    const sell = await post('/tx/sell', s.cookie, { marketId: market.id, side: 'below', amount: U(5), slippageBps: 300 });
    expect(sell.statusCode).toBe(200);
    expect(sell.json().summary).toMatch(/^Sell/);
    const merge = await post('/tx/merge', s.cookie, { marketId: market.id, amount: U(5) });
    expect(merge.statusCode).toBe(200);
    expect(merge.json().summary).toMatch(/^Merge/);
    // after trading ended a sell and a merge still work (only buys stop)
    const closing = await seedMarket(h, { tradingEndInSecs: -60, settleInSecs: 1800 });
    expect((await post('/tx/sell', s.cookie, { marketId: closing.id, side: 'above', amount: U(5) })).statusCode).toBe(200);
    expect((await post('/tx/merge', s.cookie, { marketId: closing.id, amount: U(5) })).statusCode).toBe(200);
    const settled = await seedMarket(h, { status: 'settled', outcome: 'above' });
    expect((await post('/tx/redeem', s.cookie, { marketId: settled.id, side: 'above', amount: U(5) })).statusCode).toBe(200);
  });

  it('redeem pays only the winning side, and half for a voided market', async () => {
    const s = await signIn(h);
    const settled = await seedMarket(h, { status: 'settled', outcome: 'below' });
    const win = await post('/tx/redeem', s.cookie, { marketId: settled.id, side: 'below', amount: U(8) });
    expect(win.statusCode).toBe(200);
    expect(win.json().summary).toContain('for $8.00');
    const lose = await post('/tx/redeem', s.cookie, { marketId: settled.id, side: 'above', amount: U(8) });
    expect(lose.statusCode).toBe(400);
    const voided = await seedMarket(h, { status: 'voided' });
    const v = await post('/tx/redeem', s.cookie, { marketId: voided.id, side: 'above', amount: U(8) });
    expect(v.json().summary).toContain('for $4.00');
    const open = await seedMarket(h);
    expect((await post('/tx/redeem', s.cookie, { marketId: open.id, side: 'above', amount: U(1) })).json().error.code).toBe('market_closed');
    expect((await post('/tx/merge', s.cookie, { marketId: settled.id, amount: U(1) })).json().error.code).toBe('market_closed');
  });
});

describe('POST /tx/create', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    assetSymbol: 'SOL', kind: 'close', targetPrice: 250, settleTs: new Date(h.nowMs() + 24 * 3600_000).toISOString(), baseFeeBps: 100, dynamicFee: true,
    liquidityUsdc: U(500), p0Bps: 3000, ...over,
  });
  let s: Awaited<ReturnType<typeof signIn>>;
  beforeEach(async () => {
    await setOracle(h, 'SOL');
    s = await signIn(h);
    h.chain.defaultBalance = 100_000_000_000n;
  });

  it('builds an unsigned creation transaction and returns the market id', async () => {
    const r = await post('/tx/create', s.cookie, body({ question: 'SOL above or below $250 at the close?' }));
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.marketId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(j.summary).toContain('Create market');
    const { tx, programs } = decodeTx(j.transaction);
    expect(tx.signatures.every((sig) => sig.every((b) => b === 0))).toBe(true);
    expect(programs).toContain(PROGRAM_ID.toBase58());
    expect(await h.redis.get(`q:pending:${j.marketId}`)).toBe('SOL above or below $250 at the close?');
  });

  it('seeds at the model fair value when p0Bps is omitted', async () => {
    const r = await post('/tx/create', s.cookie, body({ p0Bps: undefined }));
    expect(r.statusCode).toBe(200);
  });

  it('validates duration, liquidity, asset, wording, kind and balance', async () => {
    const soon = await post('/tx/create', s.cookie, body({ settleTs: new Date(h.nowMs() + 600_000).toISOString() }));
    expect(soon.json().error.message).toMatch(/at least/);
    const far = await post('/tx/create', s.cookie, body({ settleTs: new Date(h.nowMs() + 200 * 86400_000).toISOString() }));
    expect(far.json().error.message).toMatch(/within/);
    expect((await post('/tx/create', s.cookie, body({ liquidityUsdc: U(10) }))).json().error.message).toMatch(/Minimum liquidity/);
    expect((await post('/tx/create', s.cookie, body({ assetSymbol: 'DOGE' }))).json().error.message).toMatch(/Unknown asset/);
    expect((await post('/tx/create', s.cookie, body({ question: 'Place your bets on SOL, YES or NO?' }))).json().error.code).toBe('bad_request');
    expect((await post('/tx/create', s.cookie, body({ kind: 'touch' }))).json().error.details).toMatchObject({ feature: 'touch' });
    h.chain.defaultBalance = 1_000_000n;
    expect((await post('/tx/create', s.cookie, body())).json().error.details).toMatchObject({ reason: 'insufficient_balance' });
  });

  it('is blocked by a break, the daily limit and a stale oracle, but only for creation', async () => {
    await h.app.inject({ method: 'PUT', url: '/me/settings', headers: { cookie: s.cookie }, payload: { dailyLimitUsdc: U(100), sessionReminder: false } });
    expect((await post('/tx/create', s.cookie, body({ liquidityUsdc: U(500) }))).json().error.code).toBe('daily_limit_exceeded');
    await h.app.inject({ method: 'PUT', url: '/me/settings', headers: { cookie: s.cookie }, payload: { dailyLimitUsdc: null, sessionReminder: false } });
    await setOracle(h, 'SOL', { ageSec: 300 });
    expect((await post('/tx/create', s.cookie, body())).json().error.code).toBe('oracle_stale');
    await setOracle(h, 'SOL');
    await post('/me/break', s.cookie, { days: 1 });
    expect((await post('/tx/create', s.cookie, body())).json().error.code).toBe('break_active');
  });
});

describe('request validation', () => {
  it('rejects malformed bodies with the bad_request error shape', async () => {
    const s = await signIn(h);
    const r = await post('/tx/buy', s.cookie, { marketId: 'x', side: 'yes', amount: '-1' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('bad_request');
    const big = await post('/tx/buy', s.cookie, { marketId: 'a'.repeat(44), side: 'above', amount: '123456789012345678901234' });
    expect(big.statusCode).toBe(400);
  });
});
