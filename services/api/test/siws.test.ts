import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSiwsMessage, checkSiwsFields, isValidSolanaAddress, parseSiwsMessage, SiwsError, verifyEd25519 } from '../src/auth/siws';
import { cookieOf, makeHarness, signIn, signMessage, viewIn, type Harness } from './helpers';

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
});
afterAll(async () => {
  await h.close();
});

describe('SIWS message primitives', () => {
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const base = {
    domain: 'localhost:3000', address: wallet, statement: 'I accept the Terms (version v1).', uri: 'http://localhost:3000', version: '1', chainId: 'solana:devnet',
    nonce: 'abcdefgh12345678', issuedAt: new Date().toISOString(), expirationTime: new Date(Date.now() + 300_000).toISOString(), resources: [] as string[],
  };
  const exp = { wallet, domain: 'localhost:3000', uri: 'http://localhost:3000', chainId: 'solana:devnet', tosVersion: 'v1', now: new Date() };

  it('round-trips build and parse', () => {
    expect(parseSiwsMessage(buildSiwsMessage(base))).toEqual(base);
  });
  it('verifies a tweetnacl signature and rejects a flipped bit', () => {
    const msg = Buffer.from(buildSiwsMessage(base));
    const sig = nacl.sign.detached(msg, kp.secretKey);
    expect(verifyEd25519(msg, sig, wallet)).toBe(true);
    const bad = Uint8Array.from(sig);
    bad[3] = bad[3]! ^ 1;
    expect(verifyEd25519(msg, bad, wallet)).toBe(false);
    expect(verifyEd25519(Buffer.from('other'), sig, wallet)).toBe(false);
    expect(verifyEd25519(msg, sig.slice(0, 10), wallet)).toBe(false);
  });
  it('checks every field', () => {
    const ok = buildSiwsMessage(base);
    expect(() => checkSiwsFields(ok, exp)).not.toThrow();
    const cases: [string, Partial<typeof base>, Partial<typeof exp>?][] = [
      ['domain', { domain: 'evil.example' }],
      ['uri', { uri: 'http://evil.example' }],
      ['chain', { chainId: 'solana:mainnet' }],
      ['version', { version: '2' }],
      ['expired', { expirationTime: new Date(Date.now() - 1000).toISOString() }],
      ['future', { issuedAt: new Date(Date.now() + 600_000).toISOString(), expirationTime: new Date(Date.now() + 900_000).toISOString() }],
      ['long lifetime', { expirationTime: new Date(Date.now() + 3 * 3600_000).toISOString() }],
      ['tos version', { statement: 'I accept the Terms (version v0).' }],
      ['address', { address: Keypair.generate().publicKey.toBase58() }],
    ];
    for (const [name, patch] of cases) {
      expect(() => checkSiwsFields(buildSiwsMessage({ ...base, ...patch }), exp), name).toThrow(SiwsError);
    }
  });
  it('validates base58 addresses', () => {
    expect(isValidSolanaAddress(wallet)).toBe(true);
    expect(isValidSolanaAddress('0x' + 'a'.repeat(40))).toBe(false);
    expect(isValidSolanaAddress('short')).toBe(false);
    expect(isValidSolanaAddress('0'.repeat(44))).toBe(false);
  });
});

describe('POST /auth/nonce + /auth/verify', () => {
  it('issues a nonce with the ToS statement and signs in with a valid ed25519 signature', async () => {
    const kp = Keypair.generate();
    const s = await signMessage(h, kp);
    expect(s.nonce).toMatchObject({ domain: 'localhost:3000', uri: 'http://localhost:3000', chainId: 'solana:devnet', tosVersion: '2026-10-01' });
    expect(s.nonce.statement).toContain('2026-10-01');
    expect(Date.parse(s.nonce.expirationTime) - Date.parse(s.nonce.issuedAt)).toBe(300_000);
    const res = await h.app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: s.wallet, signedMessage: s.signedMessage, signature: s.signature, tosAccepted: true, walletName: 'Phantom' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ wallet: s.wallet, mode: 'sign', walletName: 'Phantom', tosVersion: '2026-10-01', tosAccepted: true });
    const [tos] = await h.sql`SELECT tos_version, signature, signed_message FROM tos_acceptances WHERE wallet = ${s.wallet}`;
    expect(tos).toMatchObject({ tosVersion: '2026-10-01', signature: s.signature });
    const [row] = await h.sql`SELECT used FROM auth_nonces WHERE nonce = ${s.nonce.nonce}`;
    expect(row!.used).toBe(true);
  });

  it('sets an httpOnly, SameSite=Lax cookie by default (no Secure on http)', async () => {
    const { res } = await signIn(h);
    const c = res.cookies.find((x) => x.name === 'gg_session')!;
    expect(c.httpOnly).toBe(true);
    expect(String(c.sameSite).toLowerCase()).toBe('lax');
    expect(c.secure).toBeFalsy();
    expect(c.path).toBe('/');
    expect(c.expires).toBeInstanceOf(Date);
  });

  it('nonces are single use', async () => {
    const s = await signMessage(h, Keypair.generate());
    const payload = { wallet: s.wallet, signedMessage: s.signedMessage, signature: s.signature, tosAccepted: true };
    expect((await h.app.inject({ method: 'POST', url: '/auth/verify', payload })).statusCode).toBe(200);
    const again = await h.app.inject({ method: 'POST', url: '/auth/verify', payload });
    expect(again.statusCode).toBe(401);
    expect(again.json().error.code).toBe('unauthorized');
  });

  it('rejects a nonce older than 5 minutes', async () => {
    const s = await signMessage(h, Keypair.generate());
    h.advance(5 * 60_000 + 1000);
    try {
      const res = await h.app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: s.wallet, signedMessage: s.signedMessage, signature: s.signature, tosAccepted: true } });
      expect(res.statusCode).toBe(400); // message expiration is checked before the nonce store
      expect(res.json().error.message).toMatch(/expired/);
    } finally {
      h.advance(-(5 * 60_000 + 1000));
    }
  });

  it('rejects a wrong signature, a signature by another key and a tampered message', async () => {
    const kp = Keypair.generate();
    const s = await signMessage(h, kp);
    const other = Buffer.from(nacl.sign.detached(Buffer.from(s.message), Keypair.generate().secretKey)).toString('base64');
    const r1 = await h.app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: s.wallet, signedMessage: s.signedMessage, signature: other, tosAccepted: true } });
    expect(r1.statusCode).toBe(401);
    // a failed attempt must not burn the nonce for the legitimate owner
    const r2 = await h.app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: s.wallet, signedMessage: s.signedMessage, signature: s.signature, tosAccepted: true } });
    expect(r2.statusCode).toBe(200);
    const s2 = await signMessage(h, Keypair.generate());
    const tampered = Buffer.from(s2.message.replace('Chain ID: solana:devnet', 'Chain ID: solana:mainnet')).toString('base64');
    const r3 = await h.app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: s2.wallet, signedMessage: tampered, signature: s2.signature, tosAccepted: true } });
    expect(r3.statusCode).toBe(400);
  });

  it('rejects wrong domain, a nonce issued to another wallet, and missing ToS acceptance', async () => {
    const kp = Keypair.generate();
    const wrongDomain = await signMessage(h, kp, (m) => m.replace('localhost:3000 wants', 'evil.example wants'));
    expect((await h.app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: wrongDomain.wallet, signedMessage: wrongDomain.signedMessage, signature: wrongDomain.signature, tosAccepted: true } })).statusCode).toBe(400);

    const victim = Keypair.generate();
    const attacker = Keypair.generate();
    const nonce = (await h.app.inject({ method: 'POST', url: '/auth/nonce', payload: { wallet: victim.publicKey.toBase58() } })).json();
    const msg = buildSiwsMessage({ domain: nonce.domain, address: attacker.publicKey.toBase58(), statement: nonce.statement, uri: nonce.uri, version: '1', chainId: nonce.chainId, nonce: nonce.nonce, issuedAt: nonce.issuedAt, expirationTime: nonce.expirationTime, resources: [] });
    const sig = Buffer.from(nacl.sign.detached(Buffer.from(msg), attacker.secretKey)).toString('base64');
    const stolen = await h.app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: attacker.publicKey.toBase58(), signedMessage: Buffer.from(msg).toString('base64'), signature: sig, tosAccepted: true } });
    expect(stolen.statusCode).toBe(401);

    const s = await signMessage(h, Keypair.generate());
    const noTos = await h.app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: s.wallet, signedMessage: s.signedMessage, signature: s.signature, tosAccepted: false } });
    expect(noTos.statusCode).toBe(403);
    expect(noTos.json().error.code).toBe('tos_required');
  });

  it('refuses a message that accepts a different Terms version', async () => {
    const s = await signMessage(h, Keypair.generate(), (m) => m.replace('(version 2026-10-01)', '(version 2025-01-01)'));
    const res = await h.app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: s.wallet, signedMessage: s.signedMessage, signature: s.signature, tosAccepted: true } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/Terms version/);
  });

  it('geo-blocks sign in from a blocked country', async () => {
    const s = await signMessage(h, Keypair.generate());
    const res = await h.app.inject({ method: 'POST', url: '/auth/verify', headers: { 'cf-ipcountry': 'US' }, payload: { wallet: s.wallet, signedMessage: s.signedMessage, signature: s.signature, tosAccepted: true } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('geo_blocked');
  });
});

describe('cookie flags from config', () => {
  it('uses SameSite=Strict and Secure when configured', async () => {
    const strict = await makeHarness({ env: { COOKIE_STRICT: 'true', COOKIE_SECURE: 'true' } });
    try {
      const { res } = await signIn(strict);
      const c = res.cookies.find((x) => x.name === 'gg_session')!;
      expect(String(c.sameSite).toLowerCase()).toBe('strict');
      expect(c.secure).toBe(true);
      expect(c.httpOnly).toBe(true);
      expect(res.headers['strict-transport-security']).toBeTruthy();
    } finally {
      await strict.close();
    }
  });
});

describe('sessions', () => {
  it('GET /auth/session returns the session, 401 without one, and logout invalidates it', async () => {
    expect((await h.app.inject({ url: '/auth/session' })).statusCode).toBe(401);
    const { cookie, wallet } = await signIn(h);
    const ok = await h.app.inject({ url: '/auth/session', headers: { cookie } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ wallet, mode: 'sign', tosAccepted: true });
    const out = await h.app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });
    expect(out.json()).toEqual({ ok: true });
    expect((await h.app.inject({ url: '/auth/session', headers: { cookie } })).statusCode).toBe(401);
  });

  it('rejects a forged or unsigned cookie value', async () => {
    const { cookie } = await signIn(h);
    const raw = decodeURIComponent(cookie.split('=')[1]!);
    const id = raw.split('.')[0]!;
    expect((await h.app.inject({ url: '/auth/session', headers: { cookie: `gg_session=${id}` } })).statusCode).toBe(401);
    expect((await h.app.inject({ url: '/auth/session', headers: { cookie: `gg_session=${id}.AAAA` } })).statusCode).toBe(401);
  });

  it('expires sessions', async () => {
    const { cookie } = await signIn(h);
    h.advance(8 * 24 * 3600_000);
    try {
      expect((await h.app.inject({ url: '/auth/session', headers: { cookie } })).statusCode).toBe(401);
    } finally {
      h.advance(-8 * 24 * 3600_000);
    }
  });

  it('blocks cross-origin mutating requests that carry the session cookie', async () => {
    const { cookie } = await signIn(h);
    const bad = await h.app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie, origin: 'https://evil.example' } });
    expect(bad.statusCode).toBe(403);
    const good = await h.app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie, origin: 'http://localhost:3000' } });
    expect(good.statusCode).toBe(200);
  });

  it('answers CORS preflight with credentials for the web origin only', async () => {
    const pre = await h.app.inject({ method: 'OPTIONS', url: '/auth/verify', headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'POST' } });
    expect(pre.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(pre.headers['access-control-allow-credentials']).toBe('true');
    const evil = await h.app.inject({ method: 'OPTIONS', url: '/auth/verify', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('POST /auth/view', () => {
  it('creates a view-only session for a base58 address', async () => {
    const addr = Keypair.generate().publicKey.toBase58();
    const { res, cookie } = await viewIn(h, addr);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ wallet: addr, mode: 'view', tosAccepted: false, tosVersion: null });
    expect(cookie).not.toBe('');
  });
  it('rejects 0x addresses with a helpful message and garbage input', async () => {
    const evm = await h.app.inject({ method: 'POST', url: '/auth/view', payload: { address: '0x' + 'ab'.repeat(20) } });
    expect(evm.statusCode).toBe(400);
    expect(evm.json().error.message).toMatch(/Ethereum/);
    expect(evm.json().error.details).toMatchObject({ reason: 'evm_address' });
    for (const bad of ['', 'abc', 'x'.repeat(50), '0'.repeat(40), 'l'.repeat(44)]) {
      const r = await h.app.inject({ method: 'POST', url: '/auth/view', payload: { address: bad } });
      expect(r.statusCode, bad).toBe(400);
    }
  });
});

describe('POST /auth/tos', () => {
  it('records acceptance of a newer version for an existing sign session', async () => {
    const { cookie, wallet } = await signIn(h);
    const bumped = await makeHarness({ env: { TOS_VERSION: '2026-12-01' } });
    try {
      // same database: the session exists, the new version is not accepted yet
      const cookieValue = cookie;
      const before = await bumped.app.inject({ url: '/auth/session', headers: { cookie: cookieValue } });
      expect(before.statusCode).toBe(401); // the bumped harness truncated the tables, so start fresh there
      const s = await signIn(bumped);
      await bumped.sql`DELETE FROM tos_acceptances WHERE wallet = ${s.wallet}`;
      const sess = await bumped.app.inject({ url: '/auth/session', headers: { cookie: s.cookie } });
      expect(sess.json()).toMatchObject({ tosAccepted: false, tosVersion: null });
      const wrong = await bumped.app.inject({ method: 'POST', url: '/auth/tos', headers: { cookie: s.cookie }, payload: { tosVersion: '1999' } });
      expect(wrong.statusCode).toBe(400);
      const ok = await bumped.app.inject({ method: 'POST', url: '/auth/tos', headers: { cookie: s.cookie }, payload: { tosVersion: '2026-12-01' } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ tosAccepted: true, tosVersion: '2026-12-01' });
      const rows = await bumped.sql`SELECT tos_version FROM tos_acceptances WHERE wallet = ${s.wallet}`;
      expect(rows).toHaveLength(1);
    } finally {
      await bumped.close();
    }
    void wallet;
  });
  it('is not available to view sessions', async () => {
    const { cookie } = await viewIn(h, Keypair.generate().publicKey.toBase58());
    const r = await h.app.inject({ method: 'POST', url: '/auth/tos', headers: { cookie }, payload: { tosVersion: '2026-10-01' } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('view_only');
  });
});

void cookieOf;
