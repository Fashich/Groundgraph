import { Keypair } from '@solana/web3.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { valuePosition } from '../src/routes/account';
import { makeHarness, seedMarket, seedRadar, seedTrade, setOracle, signIn, viewIn, type Harness } from './helpers';

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
  await setOracle(h, 'SOL');
});
afterAll(async () => {
  await h.close();
});

const get = (url: string, cookie?: string) => h.app.inject({ url, headers: cookie ? { cookie } : {} });
const send = (method: 'POST' | 'PUT', url: string, cookie: string | undefined, payload?: unknown) => h.app.inject({ method, url, headers: cookie ? { cookie } : {}, payload: payload as never });

describe('valuePosition (exact bigint valuation)', () => {
  const open = { status: 'open' as const, outcome: null, reserveAbove: 1_000_000_000n, reserveBelow: 250_000_000n };
  it('marks open positions at the pool price', () => {
    const a = valuePosition({ ...open, side: 'above', shares: 100_000_000n });
    expect(a.value).toBe(20_000_000n); // price of ABOVE = rb / (ra + rb) = 0.2
    const b = valuePosition({ ...open, side: 'below', shares: 100_000_000n });
    expect(b.value).toBe(80_000_000n);
    expect(a.markPrice).toBeCloseTo(0.2, 9);
    expect(a.redeemable).toBe(0n);
  });
  it('pays $1 / $0 after settlement and $0.50 when voided', () => {
    expect(valuePosition({ ...open, status: 'settled', outcome: 'above', side: 'above', shares: 7n })).toMatchObject({ value: 7n, redeemable: 7n, markPrice: 1 });
    expect(valuePosition({ ...open, status: 'settled', outcome: 'above', side: 'below', shares: 7n })).toMatchObject({ value: 0n, redeemable: 0n, markPrice: 0 });
    expect(valuePosition({ ...open, status: 'voided', side: 'below', shares: 7n })).toMatchObject({ value: 3n, redeemable: 3n, markPrice: 0.5 });
  });
});

describe('GET /me', () => {
  it('401 without a session; sign sessions get real settings with the default limit', async () => {
    expect((await get('/me')).statusCode).toBe(401);
    const s = await signIn(h);
    const me = (await get('/me', s.cookie)).json();
    expect(me).toMatchObject({ wallet: s.wallet, mode: 'sign', walletScore: null });
    expect(me.settings).toEqual({ dailyLimitUsdc: '500000000', breakUntil: null, sessionReminder: false, spentToday: '0' });
  });
  it('view sessions see neutral settings and create no settings row', async () => {
    const addr = Keypair.generate().publicKey.toBase58();
    const v = await viewIn(h, addr);
    const me = (await get('/me', v.cookie)).json();
    expect(me).toMatchObject({ wallet: addr, mode: 'view' });
    expect(me.settings).toEqual({ dailyLimitUsdc: null, breakUntil: null, sessionReminder: false, spentToday: '0' });
    expect(await h.sql`SELECT 1 FROM user_settings WHERE wallet = ${addr}`).toHaveLength(0);
  });
  it('includes the wallet score when the wallet is flagged', async () => {
    const s = await signIn(h);
    const { seedWallet } = await import('./helpers');
    await seedWallet(h, { address: s.wallet, score: 77 });
    const me = (await get('/me', s.cookie)).json();
    expect(me.walletScore).toMatchObject({ score: 77, smart: true });
    expect(me.walletScore.reasons).toHaveLength(3);
  });
});

describe('PUT /me/settings and break', () => {
  it('validates and persists the limit and reminder, and records activity', async () => {
    const s = await signIn(h);
    expect((await send('PUT', '/me/settings', undefined, { dailyLimitUsdc: null, sessionReminder: true })).statusCode).toBe(401);
    const v = await viewIn(h, Keypair.generate().publicKey.toBase58());
    expect((await send('PUT', '/me/settings', v.cookie, { dailyLimitUsdc: null, sessionReminder: true })).json().error.code).toBe('view_only');
    expect((await send('PUT', '/me/settings', s.cookie, { dailyLimitUsdc: '0', sessionReminder: false })).statusCode).toBe(400);
    expect((await send('PUT', '/me/settings', s.cookie, { dailyLimitUsdc: 'abc', sessionReminder: false })).statusCode).toBe(400);
    const ok = await send('PUT', '/me/settings', s.cookie, { dailyLimitUsdc: '100000000', sessionReminder: true });
    expect(ok.json()).toEqual({ dailyLimitUsdc: '100000000', breakUntil: null, sessionReminder: true, spentToday: '0' });
    const none = await send('PUT', '/me/settings', s.cookie, { dailyLimitUsdc: null, sessionReminder: true });
    expect(none.json().dailyLimitUsdc).toBeNull();
    const act = (await get('/me/activity', s.cookie)).json();
    expect(act.items.map((a: { type: string }) => a.type)).toEqual(['limit', 'limit']);
    expect(act.items[0].summary).toBe('Daily limit removed');
    expect(act.items[1].summary).toBe('Daily limit set to $100');
  });
  it('/me/break accepts 1, 7 or 30 days only', async () => {
    const s = await signIn(h);
    expect((await send('POST', '/me/break', s.cookie, { days: 2 })).statusCode).toBe(400);
    const r = await send('POST', '/me/break', s.cookie, { days: 7 });
    expect(Date.parse(r.json().breakUntil) - h.nowMs()).toBeGreaterThan(6.9 * 86_400_000);
    const act = (await get('/me/activity', s.cookie)).json().items[0];
    expect(act.type).toBe('break');
  });
});

describe('GET /me/positions', () => {
  it('values open positions and splits the redeem / resolved tabs with P&L', async () => {
    const s = await signIn(h);
    const open = await seedMarket(h, { symbol: 'SOL', targetUsd: 250 }); // price above 0.2099
    const won = await seedMarket(h, { status: 'settled', outcome: 'above', symbol: 'SOL', targetUsd: 200 });
    const lost = await seedMarket(h, { status: 'settled', outcome: 'below', symbol: 'SOL', targetUsd: 300 });
    const voided = await seedMarket(h, { status: 'voided', symbol: 'SOL', targetUsd: 280 });
    await seedRadar(h, open.id, { p: 0.3, n: 4 });
    const ins = (market: string, side: string, shares: bigint, cost: bigint, realized: bigint) =>
      h.sql`INSERT INTO positions (wallet, market_id, side, shares, cost_basis_usdc, realized_pnl) VALUES (${s.wallet}, ${market}, ${side}, ${shares.toString()}, ${cost.toString()}, ${realized.toString()})`;
    await ins(open.id, 'above', 100_000_000n, 30_000_000n, 2_000_000n);
    await ins(open.id, 'below', 10_000_000n, 7_000_000n, 0n);
    await ins(won.id, 'above', 50_000_000n, 20_000_000n, 0n);
    await ins(lost.id, 'above', 40_000_000n, 25_000_000n, 0n);
    await ins(voided.id, 'above', 10_000_001n, 4_000_000n, 0n);
    await ins(won.id, 'below', 0n, 0n, 6_000_000n); // fully redeemed earlier

    const openTab = (await get('/me/positions?tab=open', s.cookie)).json();
    expect(openTab).toHaveLength(2);
    const a = openTab.find((p: { side: string }) => p.side === 'above');
    expect(a).toMatchObject({ marketId: open.id, shares: '100000000', costBasis: '30000000', status: 'open', outcome: null, redeemable: '0' });
    expect(a.avgPrice).toBeCloseTo(0.3, 6);
    expect(a.markPrice).toBeCloseTo(0.2099, 3);
    expect(Number(a.value)).toBeGreaterThan(20_900_000);
    expect(Number(a.value)).toBeLessThan(21_000_000);
    expect(BigInt(a.pnl)).toBe(BigInt(a.value) + 2_000_000n - 30_000_000n); // value + realized - cost, signed
    expect(BigInt(a.pnl)).toBeLessThan(0n);
    expect(a.radar).toMatchObject({ state: 'ready', p: 0.3 });
    const b = openTab.find((p: { side: string }) => p.side === 'below');
    expect(b.markPrice).toBeCloseTo(0.7901, 3);

    const redeem = (await get('/me/positions?tab=redeem', s.cookie)).json();
    expect(redeem.map((p: { marketId: string }) => p.marketId).sort()).toEqual([won.id, voided.id].sort());
    expect(redeem.find((p: { marketId: string }) => p.marketId === won.id)).toMatchObject({ redeemable: '50000000', value: '50000000', pnl: String(50_000_000 - 20_000_000), status: 'settled', outcome: 'above', markPrice: 1 });
    expect(redeem.find((p: { marketId: string }) => p.marketId === voided.id)).toMatchObject({ redeemable: '5000000', status: 'voided', markPrice: 0.5 });

    const resolved = (await get('/me/positions?tab=resolved', s.cookie)).json();
    expect(resolved).toHaveLength(4);
    const l = resolved.find((p: { marketId: string }) => p.marketId === lost.id);
    expect(l).toMatchObject({ redeemable: '0', value: '0', pnl: '-25000000', markPrice: 0 });
    const done = resolved.find((p: { marketId: string; side: string }) => p.marketId === won.id && p.side === 'below');
    expect(done).toMatchObject({ shares: '0', pnl: '6000000', avgPrice: 0 });
  });

  it('is readable by view sessions (public on-chain data) and needs a session', async () => {
    expect((await get('/me/positions')).statusCode).toBe(401);
    const v = await viewIn(h, Keypair.generate().publicKey.toBase58());
    expect((await get('/me/positions', v.cookie)).json()).toEqual([]);
    expect((await get('/me/positions?tab=nope', v.cookie)).statusCode).toBe(400);
  });
});

describe('GET /me/activity', () => {
  it('merges trades, redemptions, merges, created markets and settings events newest first with a stable cursor', async () => {
    const s = await signIn(h);
    const m = await seedMarket(h);
    await h.sql`UPDATE markets SET creator = ${s.wallet}, created_tx = 'createsig', created_at = ${new Date(h.nowMs() - 3 * 3600_000)} WHERE id = ${m.id}`;
    for (let i = 0; i < 4; i++) await seedTrade(h, m.id, s.wallet, { agoMin: 50 - i, usdc: BigInt(5_000_000 + i), dir: i % 2 ? 'sell' : 'buy', sig: `sig${i}` });
    await h.sql`INSERT INTO redemptions (wallet, market_id, side, shares, usdc, tx_sig, ix_index, ts) VALUES (${s.wallet}, ${m.id}, 'above', 5000000, 5000000, 'redeemsig', 0, ${new Date(h.nowMs() - 5 * 60_000)})`;
    await h.sql`INSERT INTO merges (wallet, market_id, amount, tx_sig, ix_index, slot, ts) VALUES (${s.wallet}, ${m.id}, 3000000, 'mergesig', 0, 5, ${new Date(h.nowMs() - 2 * 60_000)})`;
    await send('POST', '/me/break', s.cookie, { days: 1 });
    const p1 = (await get('/me/activity', s.cookie)).json();
    expect(p1.nextCursor).toBeNull();
    expect(p1.items.map((a: { type: string }) => a.type)).toEqual(['break', 'merge', 'redeem', 'sell', 'buy', 'sell', 'buy', 'create']);
    const buy = p1.items.find((a: { type: string }) => a.type === 'buy');
    expect(buy.summary).toMatch(/^Bought 45 ABOVE for \$5\.00/);
    expect(buy).toMatchObject({ marketId: m.id });
    expect(p1.items.find((a: { type: string }) => a.type === 'merge')).toMatchObject({ txSig: 'mergesig' });
    expect(p1.items.at(-1)).toMatchObject({ type: 'create', txSig: 'createsig' });
    // pagination: 30 per page; add enough rows to cross a page boundary and walk the cursor
    for (let i = 0; i < 30; i++) await seedTrade(h, m.id, s.wallet, { agoMin: 200 + i, sig: `bulk${i}` });
    const first = (await get('/me/activity', s.cookie)).json();
    expect(first.items).toHaveLength(30);
    expect(first.nextCursor).toBeTruthy();
    const second = (await get(`/me/activity?cursor=${first.nextCursor}`, s.cookie)).json();
    expect(second.items).toHaveLength(8);
    expect(second.nextCursor).toBeNull();
    const all = [...first.items, ...second.items].map((a) => a.ts + a.summary);
    expect(new Set(all).size).toBe(38);
    expect((await get('/me/activity?cursor=garbage', s.cookie)).statusCode).toBe(400);
  });
});

describe('watch, track, dispute', () => {
  it('toggles tracking, rejects self and invalid wallets, requires a sign session', async () => {
    const s = await signIn(h);
    const target = Keypair.generate().publicKey.toBase58();
    expect((await send('POST', `/me/track/${target}`, s.cookie)).json()).toEqual({ tracking: true });
    expect((await send('POST', `/me/track/${target}`, s.cookie)).json()).toEqual({ tracking: false });
    expect((await send('POST', `/me/track/${s.wallet}`, s.cookie)).statusCode).toBe(400);
    expect((await send('POST', `/me/track/${'0'.repeat(44)}`, s.cookie)).statusCode).toBe(400);
    const v = await viewIn(h, Keypair.generate().publicKey.toBase58());
    expect((await send('POST', `/me/track/${target}`, v.cookie)).json().error.code).toBe('view_only');
    expect((await send('POST', `/me/watch/${Keypair.generate().publicKey.toBase58()}`, s.cookie)).statusCode).toBe(404);
  });
  it('stores disputes from the wallet in question and rate limits them', async () => {
    const s = await signIn(h);
    expect((await send('POST', '/flags/dispute', s.cookie, { message: 'short' })).statusCode).toBe(400);
    const r = await send('POST', '/flags/dispute', s.cookie, { message: 'This label is wrong: I only trade my own funds.' });
    expect(r.statusCode).toBe(200);
    expect(typeof r.json().id).toBe('string');
    const [row] = await h.sql`SELECT wallet, status FROM flag_disputes WHERE id = ${r.json().id}`;
    expect(row).toMatchObject({ wallet: s.wallet, status: 'open' });
    for (let i = 0; i < 4; i++) await send('POST', '/flags/dispute', s.cookie, { message: `Dispute number ${i} about my label.` });
    expect((await send('POST', '/flags/dispute', s.cookie, { message: 'One more dispute that is too many.' })).json().error.code).toBe('rate_limited');
    expect((await send('POST', '/flags/dispute', undefined, { message: 'Anonymous dispute of a label.' })).statusCode).toBe(401);
  });
});
