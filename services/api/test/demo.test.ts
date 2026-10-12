import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeHarness, seedEdge, seedMarket, seedRadar, seedScoredPosition, seedWallet, type Harness } from './helpers';

/** DEMO_MODE filtering: rows with data_source='demo-synthetic' are served only when DEMO_MODE=true. */

async function seedMixed(h: Harness) {
  const market = await seedMarket(h);
  const real = await seedWallet(h, { score: 91, source: 'onchain' });
  const real2 = await seedWallet(h, { score: 85, source: 'onchain' });
  const demo = await seedWallet(h, { score: 99, source: 'demo-synthetic' });
  const demo2 = await seedWallet(h, { score: 95, source: 'demo-synthetic' });
  await seedEdge(h, real, real2, 'onchain');
  await seedEdge(h, demo, demo2, 'demo-synthetic');
  await seedEdge(h, real, demo, 'demo-synthetic');
  await seedScoredPosition(h, market.id, real, { source: 'onchain' });
  await seedScoredPosition(h, market.id, demo, { source: 'demo-synthetic' });
  await seedRadar(h, market.id, { source: 'demo-synthetic', p: 0.4, n: 9 });
  await h.sql`INSERT INTO track_record_runs (window_start, window_end, data_source, n_markets, model_version, brier_radar, brier_market)
    VALUES (now() - interval '30 days', now(), 'demo-synthetic', 40, 'demo-1', 0.18, 0.21)`;
  return { market, real, real2, demo, demo2 };
}

describe('DEMO_MODE=false hides synthetic rows everywhere', () => {
  let h: Harness;
  let s: Awaited<ReturnType<typeof seedMixed>>;
  beforeAll(async () => {
    h = await makeHarness({ env: { DEMO_MODE: 'false' } });
    s = await seedMixed(h);
  });
  afterAll(async () => {
    await h.close();
  });

  it('radar graph contains only onchain wallets and edges', async () => {
    const g = (await h.app.inject({ url: '/radar/wallets' })).json();
    expect(g.nodes.map((n: { addr: string }) => n.addr).sort()).toEqual([s.real, s.real2].sort());
    expect(g.edges).toHaveLength(1);
    expect(g.dataSource).toBe('onchain');
  });
  it('wallet detail of a demo wallet is 404, of a real wallet is served', async () => {
    expect((await h.app.inject({ url: `/wallets/${s.demo}` })).statusCode).toBe(404);
    expect((await h.app.inject({ url: `/wallets/${s.real}` })).statusCode).toBe(200);
  });
  it('market wallets, flagged entries and radar summary exclude demo data', async () => {
    const w = (await h.app.inject({ url: `/markets/${s.market.id}/wallets` })).json();
    expect(w.map((r: { address: string }) => r.address)).toEqual([s.real]);
    const d = (await h.app.inject({ url: `/markets/${s.market.id}` })).json();
    expect(d.flaggedEntries.map((e: { wallet: string }) => e.wallet)).toEqual([s.real]);
    expect(d.radar.state).toBe('building'); // the only radar row is synthetic
    expect(d.radar.p).toBeNull();
  });
  it('track record shows the honest Building state', async () => {
    const t = (await h.app.inject({ url: '/track-record/latest' })).json();
    expect(t.state).toBe('building');
    expect(t.dataSource).toBe('none');
    expect(t.brier).toEqual({ radar: null, market: null });
  });
});

describe('DEMO_MODE=true serves synthetic rows and labels the data source', () => {
  let h: Harness;
  let s: Awaited<ReturnType<typeof seedMixed>>;
  beforeAll(async () => {
    h = await makeHarness({ env: { DEMO_MODE: 'true' } });
    s = await seedMixed(h);
  });
  afterAll(async () => {
    await h.close();
  });

  it('graph includes demo wallets and reports demo-synthetic', async () => {
    const g = (await h.app.inject({ url: '/radar/wallets' })).json();
    expect(g.nodes).toHaveLength(4);
    expect(g.dataSource).toBe('demo-synthetic');
    expect(g.edges.length).toBeGreaterThanOrEqual(2);
  });
  it('wallet, market wallets, radar and track record are served', async () => {
    expect((await h.app.inject({ url: `/wallets/${s.demo}` })).statusCode).toBe(200);
    const w = (await h.app.inject({ url: `/markets/${s.market.id}/wallets` })).json();
    expect(w).toHaveLength(2);
    const d = (await h.app.inject({ url: `/markets/${s.market.id}` })).json();
    expect(d.radar).toMatchObject({ state: 'ready', p: 0.4, n: 9 });
    const t = (await h.app.inject({ url: '/track-record/latest' })).json();
    expect(t).toMatchObject({ state: 'ready', dataSource: 'demo-synthetic', nMarkets: 40 });
  });
});
