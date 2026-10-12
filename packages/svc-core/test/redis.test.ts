import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CH, createRedis, readHeartbeat, RK, writeHeartbeat, type Redis } from '../src/redis';
import { startMetricsServer, createRegistry } from '../src/metrics';
import { boolEnv, commonEnv, intEnv, parseEnv } from '../src/env';
import { z } from 'zod';

let r: Redis;
beforeAll(() => {
  r = createRedis('redis://127.0.0.1:6379/2', 'svc-core-test');
});
afterAll(() => r.disconnect());

describe('redis helpers', () => {
  it('key and channel names are stable (other services and the web app depend on them)', () => {
    expect(RK.oracle('ab')).toBe('oracle:ab');
    expect(RK.vol('ab')).toBe('vol:ab');
    expect(RK.fairValue('m')).toBe('fv:m');
    expect(RK.heartbeatKeeper).toBe('hb:keeper');
    expect(RK.heartbeatIndexer).toBe('hb:indexer');
    expect(RK.pendingSpend('w')).toBe('rt:pending:w');
    expect(RK.pendingQuestion('m')).toBe('q:pending:m');
    expect(RK.settleLock('m')).toBe('lock:settle:m');
    expect(CH.market('m')).toBe('gg:ch:market:m');
    expect(CH.me('w')).toBe('gg:ch:me:w');
    expect(CH.oracle('f')).toBe('gg:ch:oracle:f');
    expect(CH.indexerNudge).toBe('gg:indexer:nudge');
  });

  it('heartbeat round trips and expires', async () => {
    await writeHeartbeat(r, 'hb:test', { service: 'keeper', ts: 5, extra: 1 }, 1);
    expect(await readHeartbeat(r, 'hb:test')).toEqual({ service: 'keeper', ts: 5, extra: 1 });
    await r.set('hb:test', 'not json');
    expect(await readHeartbeat(r, 'hb:test')).toBeNull();
    await r.del('hb:test');
    expect(await readHeartbeat(r, 'hb:test')).toBeNull();
  });
});

describe('env helpers', () => {
  it('boolEnv understands the usual spellings', () => {
    const s = z.object({ A: boolEnv(false), B: boolEnv(true), C: boolEnv(false) });
    expect(s.parse({ A: 'TRUE', B: 'off', C: undefined })).toEqual({ A: true, B: false, C: false });
    expect(s.parse({})).toEqual({ A: false, B: true, C: false });
  });
  it('intEnv enforces bounds and defaults', () => {
    const s = z.object({ N: intEnv(5, 1, 10) });
    expect(s.parse({})).toEqual({ N: 5 });
    expect(s.parse({ N: '7' })).toEqual({ N: 7 });
    expect(() => s.parse({ N: '11' })).toThrow();
    expect(() => s.parse({ N: 'x' })).toThrow();
  });
  it('parseEnv reports every bad variable by name', () => {
    expect(() => parseEnv({ ...commonEnv }, { RPC_URL: 'nope', LOG_LEVEL: 'loud' })).toThrow(/RPC_URL[\s\S]*LOG_LEVEL|LOG_LEVEL[\s\S]*RPC_URL/);
  });
  it('commonEnv defaults point at the public devnet', () => {
    const e = parseEnv({ ...commonEnv }, {});
    expect(e).toMatchObject({ SOLANA_CLUSTER: 'devnet', RPC_URL: 'https://api.devnet.solana.com', DEMO_MODE: false, PYTH_HERMES_URL: 'https://hermes.pyth.network' });
    expect(e.PYTH_API_KEY).toBeUndefined();
  });
});

describe('metrics server', () => {
  it('serves /metrics, /healthz and enforces the bearer token on /metrics only', async () => {
    const reg = createRegistry('t');
    const srv = startMetricsServer(reg, 0, '127.0.0.1', () => ({ ok: false, why: 'x' }), 'tok');
    await new Promise((res) => srv.once('listening', res));
    const port = (srv.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    expect((await fetch(`${base}/metrics`)).status).toBe(401);
    expect((await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    const ok = await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer tok' } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('process_cpu');
    const h = await fetch(`${base}/healthz`);
    expect(h.status).toBe(503);
    expect(await h.json()).toEqual({ ok: false, why: 'x' });
    expect((await fetch(`${base}/other`)).status).toBe(404);
    srv.close();
  });
});
