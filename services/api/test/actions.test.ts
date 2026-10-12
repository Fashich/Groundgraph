import { PROGRAM_ID } from '@groundgraph/svc-core';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MEMO_PROGRAM_ID } from '../src/routes/actions';
import { b64tx, makeHarness, seedMarket, seedRadar, setOracle, type Harness } from './helpers';

let h: Harness;
let m: Awaited<ReturnType<typeof seedMarket>>;
beforeAll(async () => {
  h = await makeHarness();
  await setOracle(h, 'SOL');
  m = await seedMarket(h, { tradingEndInSecs: 5 * 3600 });
  await seedRadar(h, m.id, { p: 0.25, ci: 12, n: 6 });
});
afterAll(async () => {
  await h.close();
});

describe('/actions.json and GET action', () => {
  it('maps /m/* to the API and answers CORS for any origin with the Actions headers', async () => {
    const r = await h.app.inject({ url: '/actions.json', headers: { origin: 'https://dial.to' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().rules[0]).toEqual({ pathPattern: '/m/*', apiPath: 'http://localhost:8787/api/actions/m/*' });
    expect(r.headers['access-control-allow-origin']).toBe('*');
    expect(r.headers['access-control-allow-credentials']).toBeUndefined();
    expect(r.headers['x-action-version']).toBeTruthy();
    expect(r.headers['x-blockchain-ids']).toBe('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1');
    const pre = await h.app.inject({ method: 'OPTIONS', url: `/api/actions/m/${m.id}`, headers: { origin: 'https://x.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-action-version' } });
    expect(pre.headers['access-control-allow-origin']).toBe('*');
    expect(String(pre.headers['access-control-allow-headers'])).toMatch(/X-Action-Version/i);
  });

  it('describes the market with price, radar, Terms link and Buy ABOVE / BELOW links', async () => {
    const r = await h.app.inject({ url: `/api/actions/m/${m.id}` });
    expect(r.statusCode).toBe(200);
    const a = r.json();
    expect(a.type).toBe('action');
    expect(a.title).toContain('SOL');
    expect(a.icon).toBe(`http://localhost:8787/og/m/${m.id}.png`);
    expect(a.description).toMatch(/ABOVE 21¢/);
    expect(a.description).toMatch(/Radar P\(above\) 25% ±12 from 6 flagged wallets/);
    expect(a.description).toContain('http://localhost:3000/terms');
    expect(a.description).toContain('2026-10-01');
    expect(a.description).not.toMatch(/\b(bet|odds|yes|no)\b/i);
    const labels = a.links.actions.map((x: { label: string }) => x.label);
    expect(labels).toEqual(['Buy ABOVE $10', 'Buy ABOVE $50', 'Buy ABOVE', 'Buy BELOW $10', 'Buy BELOW $50', 'Buy BELOW']);
    expect(a.links.actions[0].href).toBe(`http://localhost:8787/api/actions/m/${m.id}?side=above&amount=10`);
    expect(a.links.actions[2]).toMatchObject({ href: `http://localhost:8787/api/actions/m/${m.id}?side=above&amount={amount}`, parameters: [{ name: 'amount', type: 'number', min: 1, required: true }] });
  });

  it('a closed market is disabled, an unknown one is 404 with a message', async () => {
    const closed = await seedMarket(h, { tradingEndInSecs: -10, settleInSecs: 1000 });
    const r = (await h.app.inject({ url: `/api/actions/m/${closed.id}` })).json();
    expect(r).toMatchObject({ disabled: true, label: 'Closed' });
    expect(r.error.message).toMatch(/ended/);
    const nf = await h.app.inject({ url: `/api/actions/m/${Keypair.generate().publicKey.toBase58()}` });
    expect(nf.statusCode).toBe(404);
    expect(nf.json().message).toBe('Market not found');
  });
});

describe('POST action', () => {
  const account = Keypair.generate().publicKey.toBase58();
  const post = (qs: string, body: unknown = { account }, headers: Record<string, string> = {}) =>
    h.app.inject({ method: 'POST', url: `/api/actions/m/${m.id}?${qs}`, headers, payload: body as never });

  it('requires the wallet to have accepted the current Terms version', async () => {
    const r = await post('side=above&amount=10');
    expect(r.statusCode).toBe(403);
    expect(r.json().message).toMatch(/Accept the Terms \(version 2026-10-01\)/);
    expect(r.json().error.code).toBe('tos_required');
  });

  it('returns an unsigned transaction with a memo carrying the ToS version', async () => {
    await h.sql`INSERT INTO tos_acceptances (wallet, tos_version, signed_message, signature) VALUES (${account}, '2026-10-01', 'm', 's')`;
    const r = await post('side=below&amount=12.5');
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.type).toBe('transaction');
    expect(j.message).toMatch(/^Buy BELOW: pay \$12\.50/);
    const tx = VersionedTransaction.deserialize(b64tx(j.transaction));
    const keys = tx.message.staticAccountKeys;
    expect(keys[0]!.toBase58()).toBe(account);
    expect(tx.signatures.every((s) => s.every((b) => b === 0))).toBe(true);
    const progs = tx.message.compiledInstructions.map((i) => keys[i.programIdIndex]!.toBase58());
    expect(progs).toContain(PROGRAM_ID.toBase58());
    expect(progs.at(-1)).toBe(MEMO_PROGRAM_ID.toBase58());
    const memo = tx.message.compiledInstructions.at(-1)!;
    expect(Buffer.from(memo.data).toString()).toBe(`groundgraph blink tos:2026-10-01 buy below ${m.id.slice(0, 8)}`);
  });

  it('applies the same responsible-trading, oracle and geofence rules as /tx/buy', async () => {
    await h.sql`UPDATE user_settings SET break_until = ${new Date(h.nowMs() + 3600_000)} WHERE wallet = ${account}`;
    await h.sql`INSERT INTO user_settings (wallet, break_until) VALUES (${account}, ${new Date(h.nowMs() + 3600_000)}) ON CONFLICT (wallet) DO UPDATE SET break_until = EXCLUDED.break_until`;
    const brk = await post('side=above&amount=5');
    expect(brk.statusCode).toBe(403);
    expect(brk.json().error.code).toBe('break_active');
    expect(brk.json().message).toMatch(/trading break/);
    await h.sql`UPDATE user_settings SET break_until = NULL WHERE wallet = ${account}`;
    expect((await post('side=above&amount=0.5')).json().error.code).toBe('below_min_trade');
    expect((await post('side=above&amount=5', { account }, { 'cf-ipcountry': 'US' })).json().error.code).toBe('geo_blocked');
    expect((await post('side=above&amount=5', { account: 'nope' })).statusCode).toBe(400);
    expect((await post('side=maybe&amount=5')).statusCode).toBe(400);
    await h.redis.flushdb();
    expect((await post('side=above&amount=5')).json().error.code).toBe('oracle_stale');
  });
});

describe('GET /og/m/:id', () => {
  it('renders a 1200x630 PNG with the bundled font and no network access', async () => {
    const r = await h.app.inject({ url: `/og/m/${m.id}.png` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['access-control-allow-origin']).toBe('*');
    const png = r.rawPayload;
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
    expect(png.length).toBeGreaterThan(8_000);
    const again = await h.app.inject({ url: `/og/m/${m.id}` });
    expect(again.statusCode).toBe(200);
    expect(again.rawPayload.equals(png)).toBe(true); // served from the 15 s cache
  });
  it('renders resolved and long-question markets too, and 404s unknown ids', async () => {
    const done = await seedMarket(h, { status: 'settled', outcome: 'below', question: 'A very long question about the price of a token at the close of the settlement day, to check wrapping?' });
    expect((await h.app.inject({ url: `/og/m/${done.id}` })).statusCode).toBe(200);
    expect((await h.app.inject({ url: `/og/m/${Keypair.generate().publicKey.toBase58()}` })).statusCode).toBe(404);
  });
});
