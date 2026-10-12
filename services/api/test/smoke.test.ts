import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from './helpers';

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
});
afterAll(async () => {
  await h.close();
});

describe('smoke', () => {
  it('serves health, assets, docs and a 404 body', async () => {
    const health = await h.app.inject({ url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, db: true, redis: true, rpc: true, indexerLagSlots: null, keeper: { ok: false, ageSec: null } });
    const assets = await h.app.inject({ url: '/api/assets' });
    expect(assets.statusCode).toBe(200);
    expect(assets.json()).toHaveLength(6);
    const docs = await h.app.inject({ url: '/docs/json' });
    expect(docs.statusCode).toBe(200);
    expect(Object.keys(docs.json().paths).length).toBeGreaterThan(20);
    const nf = await h.app.inject({ url: '/nope' });
    expect(nf.statusCode).toBe(404);
    expect(nf.json().error.code).toBe('not_found');
  });
});
