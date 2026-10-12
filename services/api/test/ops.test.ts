import { CH, RK } from '@groundgraph/svc-core';
import { Keypair } from '@solana/web3.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRedis } from '@groundgraph/svc-core';
import { makeHarness, TEST_REDIS_URL, type Harness } from './helpers';

describe('faucet', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness({ faucet: true, env: { FAUCET_MAX_PER_WALLET_PER_DAY: '3', FAUCET_MAX_PER_IP_PER_DAY: '5' } });
  });
  afterAll(async () => {
    await h.close();
  });
  const claim = (wallet: string, ip = '10.0.0.1') => h.app.inject({ method: 'POST', url: '/faucet/usdc', remoteAddress: ip, payload: { wallet } });

  it('mints 1000 USDC (base units) and caps each wallet at 3 per day', async () => {
    const w = Keypair.generate().publicKey.toBase58();
    for (let i = 0; i < 3; i++) {
      const r = await claim(w, `10.0.1.${i}`);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ txSig: `faucetsig${h.faucetCalls.length}`, amount: '1000000000' });
    }
    const fourth = await claim(w, '10.0.1.9');
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json().error.code).toBe('rate_limited');
    expect(h.faucetCalls.filter((c) => c.wallet === w)).toHaveLength(3);
    expect(h.faucetCalls[0]).toEqual({ wallet: w, amount: 1_000_000_000n });
  });

  it('limits per IP too, and failed mints do not consume the allowance', async () => {
    let n = 0;
    for (let i = 0; i < 5; i++) n += (await claim(Keypair.generate().publicKey.toBase58(), '10.9.9.9')).statusCode === 200 ? 1 : 0;
    expect(n).toBe(5);
    const blocked = await claim(Keypair.generate().publicKey.toBase58(), '10.9.9.9');
    expect(blocked.statusCode).toBe(429);
    const w = Keypair.generate().publicKey.toBase58();
    const orig = h.ctx.faucet!.mint;
    h.ctx.faucet!.mint = async () => {
      throw new Error('rpc down');
    };
    try {
      const f = await claim(w, '10.7.7.7');
      expect(f.statusCode).toBe(503);
      expect(f.json().error.code).toBe('faucet_unavailable');
    } finally {
      h.ctx.faucet!.mint = orig;
    }
    for (let i = 0; i < 3; i++) expect((await claim(w, '10.7.7.7')).statusCode).toBe(200);
  });

  it('validates the wallet address', async () => {
    expect((await claim('0x' + 'a'.repeat(40))).statusCode).toBe(400);
    expect((await claim('0'.repeat(44))).statusCode).toBe(400);
  });
});

describe('faucet availability', () => {
  it('is unavailable without a configured minter and on mainnet', async () => {
    const none = await makeHarness({ faucet: false });
    try {
      const r = await none.app.inject({ method: 'POST', url: '/faucet/usdc', payload: { wallet: Keypair.generate().publicKey.toBase58() } });
      expect(r.statusCode).toBe(503);
      expect(r.json().error.code).toBe('faucet_unavailable');
    } finally {
      await none.close();
    }
    const main = await makeHarness({ faucet: true, env: { SOLANA_CLUSTER: 'mainnet-beta' } });
    try {
      const r = await main.app.inject({ method: 'POST', url: '/faucet/usdc', payload: { wallet: Keypair.generate().publicKey.toBase58() } });
      expect(r.statusCode).toBe(503);
      expect(r.json().error.message).toMatch(/devnet/);
    } finally {
      await main.close();
    }
  });
});

describe('health, metrics, webhook, rate limiting', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness({ env: { HELIUS_WEBHOOK_SECRET: 'whsec_test_secret', METRICS_TOKEN: 'metrics-token' } });
  });
  afterAll(async () => {
    await h.close();
  });
  afterEach(() => {
    h.chain.slot = 1_000_000;
  });

  it('GET /health reports indexer lag and keeper freshness from the heartbeats', async () => {
    await h.redis.set(RK.heartbeatIndexer, JSON.stringify({ service: 'indexer', ts: h.nowMs(), indexedSlot: 999_940 }), 'EX', 60);
    await h.redis.set(RK.heartbeatKeeper, JSON.stringify({ service: 'keeper', ts: h.nowMs() - 5_000 }), 'EX', 60);
    const r = await h.app.inject({ url: '/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, db: true, redis: true, rpc: true, indexerLagSlots: 60, keeper: { ok: true, ageSec: 5 }, demoMode: false });
    await h.redis.set(RK.heartbeatKeeper, JSON.stringify({ service: 'keeper', ts: h.nowMs() - 120_000 }), 'EX', 60);
    expect((await h.app.inject({ url: '/health' })).json().keeper).toEqual({ ok: false, ageSec: 120 });
  });

  it('GET /health is 503 when the RPC is down', async () => {
    const orig = h.chain.getSlot;
    h.chain.getSlot = async () => {
      throw new Error('down');
    };
    try {
      const r = await h.app.inject({ url: '/health' });
      expect(r.statusCode).toBe(503);
      expect(r.json()).toMatchObject({ ok: false, rpc: false, db: true, redis: true });
    } finally {
      h.chain.getSlot = orig;
    }
  });

  it('GET /metrics needs the bearer token and exposes prometheus text', async () => {
    expect((await h.app.inject({ url: '/metrics' })).statusCode).toBe(401);
    const r = await h.app.inject({ url: '/metrics', headers: { authorization: 'Bearer metrics-token' } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/plain');
    expect(r.body).toContain('gg_http_request_duration_seconds');
    expect(r.body).toContain('gg_ws_clients');
    expect(r.body).toContain('service="api-test"');
  });

  it('POST /webhooks/helius authenticates by header, nudges the indexer and answers 204', async () => {
    const sub = createRedis(TEST_REDIS_URL, 'wh-sub');
    const got: string[] = [];
    sub.on('message', (_c, m) => got.push(m));
    await sub.subscribe(CH.indexerNudge);
    try {
      expect((await h.app.inject({ method: 'POST', url: '/webhooks/helius', payload: [] })).statusCode).toBe(401);
      expect((await h.app.inject({ method: 'POST', url: '/webhooks/helius', headers: { authorization: 'nope' }, payload: [] })).statusCode).toBe(401);
      const ok = await h.app.inject({ method: 'POST', url: '/webhooks/helius', headers: { authorization: 'whsec_test_secret' }, payload: [{ signature: 'abc' }, { signature: 'def' }, { other: 1 }] });
      expect(ok.statusCode).toBe(204);
      await new Promise((r) => setTimeout(r, 100));
      expect(JSON.parse(got[0]!)).toEqual({ source: 'helius', sigs: ['abc', 'def'] });
    } finally {
      sub.disconnect();
    }
  });

  it('the webhook is disabled (404) without a configured secret', async () => {
    const plain = await makeHarness();
    try {
      expect((await plain.app.inject({ method: 'POST', url: '/webhooks/helius', headers: { authorization: 'x' }, payload: [] })).statusCode).toBe(404);
    } finally {
      await plain.close();
    }
  });

  it('rate limits per IP (429 rate_limited) through Redis', async () => {
    const limited = await makeHarness({ env: { RATE_LIMIT_PER_MINUTE: '10' } });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 14; i++) codes.push((await limited.app.inject({ url: '/assets', remoteAddress: '10.5.5.5' })).statusCode);
      expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
      expect(codes.slice(10).every((c) => c === 429)).toBe(true);
      const r = await limited.app.inject({ url: '/assets', remoteAddress: '10.5.5.5' });
      expect(r.json().error.code).toBe('rate_limited');
      expect((await limited.app.inject({ url: '/assets', remoteAddress: '10.6.6.6' })).statusCode).toBe(200); // other IPs unaffected
      expect((await limited.app.inject({ url: '/health', remoteAddress: '10.5.5.5' })).statusCode).toBe(200); // health is exempt
    } finally {
      await limited.close();
    }
  });
});
