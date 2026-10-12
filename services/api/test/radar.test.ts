import { Keypair } from '@solana/web3.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveTags, fallbackPos, normalizeContributions } from '../src/routes/radar';
import { makeHarness, seedEdge, seedMarket, seedScoredPosition, seedWallet, type Harness } from './helpers';

let h: Harness;
let a: string, b: string, c: string, d: string;
let market: Awaited<ReturnType<typeof seedMarket>>;

beforeAll(async () => {
  h = await makeHarness();
});
afterAll(async () => {
  await h.close();
});

describe('empty radar', () => {
  it('is an honest empty payload, not an error', async () => {
    const g = (await h.app.inject({ url: '/radar/wallets' })).json();
    expect(g).toEqual({ nodes: [], edges: [], asOf: null, modelVersion: null, clusters: [], dataSource: 'none' });
  });
});

async function seed() {
  market = await seedMarket(h);
  a = await seedWallet(h, { score: 92, smart: true, top: true, cluster: 1, clusterName: 'Early whales', pos: [0.1, 0.2, 0.3] });
  b = await seedWallet(h, { score: 81, smart: true, cluster: 1, clusterName: 'Early whales' });
  c = await seedWallet(h, { score: 40, smart: false, cluster: 2, clusterName: 'Retail', pos: null });
  d = await seedWallet(h, { score: 15, smart: false, cluster: null, clusterName: null, sybil: true });
  await seedEdge(h, a, b);
  await seedEdge(h, b, a); // duplicate direction collapses into one link
  await seedEdge(h, b, c);
  await seedEdge(h, c, Keypair.generate().publicKey.toBase58()); // outside the node set: dropped
  await seedScoredPosition(h, market.id, a, { side: 'below', entry: 0.2, usdc: 25_000_000n });
  await h.sql`INSERT INTO positions (wallet, market_id, side, shares, cost_basis_usdc) VALUES (${a}, ${market.id}, 'below', 31250000, 25000000)`;
}

const get = (url: string) => h.app.inject({ url });

describe('pure helpers', () => {
  it('fallback layout is deterministic and on a shell around the origin', () => {
    const x = Keypair.generate().publicKey.toBase58();
    const p = fallbackPos(x);
    expect(fallbackPos(x)).toEqual(p);
    expect(fallbackPos(Keypair.generate().publicKey.toBase58())).not.toEqual(p);
    expect(Math.hypot(...p)).toBeGreaterThan(0.9);
    expect(Math.hypot(...p)).toBeLessThan(1.3);
  });
  it('contributions accept snake_case and camelCase json', () => {
    expect(normalizeContributions({ whale_overlap: 10, entry_timing: 20, hit_rate: 30, centrality: 5, lead_time: 7 })).toEqual({ whaleOverlap: 10, entryTiming: 20, hitRate: 30, centrality: 5, leadTime: 7 });
    expect(normalizeContributions({ whaleOverlap: 1, leadTime: 2 })).toMatchObject({ whaleOverlap: 1, leadTime: 2, hitRate: 0 });
    expect(normalizeContributions(null)).toEqual({ whaleOverlap: 0, entryTiming: 0, hitRate: 0, centrality: 0, leadTime: 0 });
  });
  it('tags describe behavior only', () => {
    const tags = deriveTags({ whaleOverlap: 0.7, entryTiming: 0.8, hitRate: 0.7, centrality: 0.9, leadTimeMin: 50, nMarkets: 12 }, true);
    expect(tags).toEqual(['Follows large wallets', 'Early entries', 'High hit rate', 'Well connected', 'Moves before the crowd', 'Linked to a multi-wallet cluster']);
    expect(deriveTags({ whaleOverlap: 0, entryTiming: 0, hitRate: 0.9, centrality: 0, leadTimeMin: 0, nMarkets: 2 }, false)).toEqual(['Few markets so far']);
  });
});

describe('seeded radar', () => {
  it('seeds', async () => {
    await seed();
  });
});

describe('GET /radar/wallets', () => {
  it('returns nodes, de-duplicated edges with the flag rule, clusters and metadata', async () => {
    const g = (await get('/radar/wallets')).json();
    expect(g.nodes.map((n: { addr: string }) => n.addr)).toEqual([a, b, c, d]); // by score desc
    expect(g.nodes.map((n: { id: number }) => n.id)).toEqual([0, 1, 2, 3]);
    expect(g.nodes[0]).toMatchObject({ score: 92, smart: true, top: true, cluster: 1 });
    expect(g.nodes[0].pos).toEqual([0.1, 0.2, 0.3]);
    expect(g.nodes[2].pos).toHaveLength(3); // fallback layout for a wallet the scorer has not laid out
    expect(g.nodes[3].cluster).toBe(-1);
    expect(g.edges).toHaveLength(2);
    expect(g.edges.find((e: { a: number; b: number }) => [e.a, e.b].sort().join() === '0,1')).toMatchObject({ flag: true });
    expect(g.edges.find((e: { a: number; b: number }) => [e.a, e.b].sort().join() === '1,2')).toMatchObject({ flag: false });
    expect(g.clusters).toEqual(expect.arrayContaining([{ id: 1, name: 'Early whales', size: 2 }, { id: 2, name: 'Retail', size: 1 }, { id: -1, name: 'Unclustered', size: 1 }]));
    expect(g.modelVersion).toBe('gs-test-1');
    expect(g.dataSource).toBe('onchain');
    expect(Date.parse(g.asOf)).toBeLessThan(h.nowMs());
  });
  it('filters by minScore, cluster and crowd=false', async () => {
    expect((await get('/radar/wallets?minScore=50')).json().nodes).toHaveLength(2);
    expect((await get('/radar/wallets?cluster=2')).json().nodes.map((n: { addr: string }) => n.addr)).toEqual([c]);
    const smartOnly = (await get('/radar/wallets?crowd=false')).json();
    expect(smartOnly.nodes.map((n: { addr: string }) => n.addr)).toEqual([a, b]);
    expect(smartOnly.edges).toHaveLength(1);
    expect((await get('/radar/wallets?minScore=500')).statusCode).toBe(400);
  });
});

describe('GET /wallets/:addr', () => {
  it('returns score, features, contributions, reasons, tags, stats and open positions', async () => {
    const w = (await get(`/wallets/${a}`)).json();
    expect(w).toMatchObject({ address: a, score: 92, smart: true, top: true, sybil: false, labelHidden: false, modelVersion: 'gs-test-1', cluster: { id: 1, name: 'Early whales' } });
    expect(w.features).toEqual({ whaleOverlap: 0.6, entryTiming: 0.7, hitRate: 0.65, centrality: 0.8, leadTimeMin: 42, nMarkets: 12 });
    expect(w.contributions).toEqual({ whaleOverlap: 20, entryTiming: 20, hitRate: 15, centrality: 15, leadTime: 22 });
    expect(w.reasons).toHaveLength(3);
    expect(w.tags).toContain('Follows large wallets');
    expect(w.stats).toMatchObject({ markets: 12, hitRate: 0.65, medianLeadMin: 42, volumeUsd: 25 });
    expect(w.openPositions).toEqual([{ marketId: market.id, question: expect.any(String), side: 'below', shares: '31250000', entryPrice: 0.8 }]);
  });
  it('flags sybil wallets, 404s unscored wallets, 400s malformed addresses', async () => {
    expect((await get(`/wallets/${d}`)).json()).toMatchObject({ sybil: true, cluster: null });
    expect((await get(`/wallets/${Keypair.generate().publicKey.toBase58()}`)).statusCode).toBe(404);
    expect((await get('/wallets/not-an-address-but-long-enough-to-pass-the-length-check')).statusCode).toBe(400);
  });
});

describe('GET /track-record/latest', () => {
  it('serves the latest servable run with calibration and rows, and Building below the minimum', async () => {
    const [run] = await h.sql`INSERT INTO track_record_runs (window_start, window_end, data_source, n_markets, brier_radar, brier_market, hit_rate_radar, hit_rate_market,
      median_lead_min, edge_realized_cents, calibration, lead_hist, model_version)
      VALUES (${new Date(h.nowMs() - 30 * 86400_000)}, ${new Date(h.nowMs())}, 'helius-mainnet-backfill', 3, 0.19, 0.22, 0.61, 0.55, 48, 3.2,
        ${h.sql.json([{ bin: 0.1, predicted: 0.12, observed: 0.1, n: 5 }])}, ${h.sql.json([{ bucket_min: 30, count: 4 }])}, 'gs-1') RETURNING id`;
    await h.sql`INSERT INTO track_record_rows (run_id, market_id, question, radar_t24, market_t24, outcome, closer) VALUES (${run!.id}, ${market.id}, 'SOL above or below $250?', 0.3, 0.2, 'above', 'radar')`;
    const early = (await get('/track-record/latest')).json();
    expect(early).toMatchObject({ state: 'building', nMarkets: 3, dataSource: 'helius-mainnet-backfill', modelVersion: 'gs-1' });
    expect(early.brier).toEqual({ radar: 0.19, market: 0.22 });
    expect(early.calibration).toEqual([{ bin: 0.1, predicted: 0.12, observed: 0.1, n: 5 }]);
    expect(early.leadHistogram).toEqual([{ bucketMin: 30, count: 4 }]);
    expect(early.rows).toEqual([{ marketId: market.id, question: 'SOL above or below $250?', radarT24: 0.3, marketT24: 0.2, outcome: 'above', closer: 'radar' }]);
    await h.sql`UPDATE track_record_runs SET n_markets = 25 WHERE id = ${run!.id}`;
    expect((await get('/track-record/latest')).json().state).toBe('ready');
  });
});
