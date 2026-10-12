import { createHash } from 'node:crypto';
import { notDemo } from '@groundgraph/db';
import { numericToBigInt } from '@groundgraph/svc-core';
import type { GraphPayload, TrackRecord, WalletContributions, WalletDetail, WalletFeatures } from '@groundgraph/sdk/api-types';
import type { FastifyPluginAsync } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { isValidSolanaAddress } from '../auth/siws';
import type { AppContext } from '../context';
import { fail } from '../errors';
import { GraphPayloadSchema, TrackRecordSchema, WalletDetailSchema } from '../schemas';
import { round, sidePrice } from '../services/markets';

const MAX_NODES = 3000;
const MAX_EDGES = 8000;
/** A track record built on fewer resolved markets than this is shown as 'building' instead of a number. */
export const TRACK_RECORD_MIN_MARKETS = 5;

const boolQ = z.preprocess((v) => (v === undefined ? undefined : v === true || v === 'true' || v === '1'), z.boolean().optional());

/** Deterministic point on a sphere for wallets the scorer has not laid out yet, so every client draws the same graph. */
export function fallbackPos(address: string): [number, number, number] {
  const h = createHash('sha256').update(address).digest();
  const u = h.readUInt32BE(0) / 0xffffffff;
  const v = h.readUInt32BE(4) / 0xffffffff;
  const theta = 2 * Math.PI * u;
  const phi = Math.acos(2 * v - 1);
  const r = 1 + (h.readUInt32BE(8) / 0xffffffff) * 0.25;
  return [round(r * Math.sin(phi) * Math.cos(theta), 4), round(r * Math.sin(phi) * Math.sin(theta), 4), round(r * Math.cos(phi), 4)];
}

const pick = (o: Record<string, unknown> | null | undefined, ...keys: string[]): number => {
  if (!o) return 0;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return 0;
};

/** scorer writes snake_case keys inside jsonb; accept camelCase too. */
export function normalizeContributions(j: unknown): WalletContributions {
  const o = (j && typeof j === 'object' ? j : null) as Record<string, unknown> | null;
  return {
    whaleOverlap: pick(o, 'whale_overlap', 'whaleOverlap'),
    entryTiming: pick(o, 'entry_timing', 'entryTiming'),
    hitRate: pick(o, 'hit_rate', 'hitRate'),
    centrality: pick(o, 'centrality'),
    leadTime: pick(o, 'lead_time', 'leadTime', 'lead_time_min'),
  };
}

/** Plain-language tags derived from the feature vector. Descriptive of on-chain behavior only. */
export function deriveTags(f: WalletFeatures, sybil: boolean): string[] {
  const tags: string[] = [];
  if (f.whaleOverlap >= 0.5) tags.push('Follows large wallets');
  if (f.entryTiming >= 0.7) tags.push('Early entries');
  if (f.hitRate >= 0.6 && f.nMarkets >= 5) tags.push('High hit rate');
  if (f.centrality >= 0.8) tags.push('Well connected');
  if (f.leadTimeMin >= 30) tags.push('Moves before the crowd');
  if (f.nMarkets < 5) tags.push('Few markets so far');
  if (sybil) tags.push('Linked to a multi-wallet cluster');
  return tags;
}

const asStrArray = (j: unknown): string[] => (Array.isArray(j) ? j.filter((x): x is string => typeof x === 'string') : []);

export const radarRoutes = (ctx: AppContext): FastifyPluginAsync => async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const sql = ctx.db.sql;
  const demo = ctx.cfg.DEMO_MODE;

  /* ------------------------------ graph ------------------------------ */

  app.get(
    '/radar/wallets',
    {
      schema: {
        tags: ['radar'],
        querystring: z.object({
          minScore: z.coerce.number().min(0).max(100).default(0),
          cluster: z.coerce.number().int().optional(),
          crowd: boolQ,
        }),
        response: { 200: GraphPayloadSchema },
      },
    },
    async (req): Promise<GraphPayload> => {
      const { minScore, cluster } = req.query;
      const crowd = req.query.crowd ?? true;
      const latest = await sql<{ asOf: Date | null }[]>`SELECT max(as_of) AS as_of FROM wallet_scores WHERE ${notDemo(sql, demo)}`;
      const asOf = latest[0]?.asOf ?? null;
      const empty: GraphPayload = { nodes: [], edges: [], asOf: null, modelVersion: null, clusters: [], dataSource: 'none' };
      if (!asOf) return empty;

      const rows = await sql<
        { address: string; score: number; smart: boolean; top: boolean; modelVersion: string; dataSource: string; clusterId: number | null; clusterName: string | null; x: number | null; y: number | null; z: number | null }[]
      >`SELECT s.address, s.score, s.smart, s."top", s.model_version, s.data_source, w.cluster_id, w.cluster_name, g.x, g.y, g.z
        FROM wallet_scores s
        LEFT JOIN wallets w ON w.address = s.address
        LEFT JOIN graph_layout g ON g.address = s.address AND ${notDemo(sql, demo, 'g.data_source')}
        WHERE s.as_of = ${asOf} AND ${notDemo(sql, demo, 's.data_source')}
          AND COALESCE(w.label_hidden, false) = false
          AND s.score >= ${minScore}
          AND (${crowd}::boolean OR s.smart)
          AND (${cluster ?? null}::int IS NULL OR w.cluster_id = ${cluster ?? null}::int)
        ORDER BY s.score DESC, s.address ASC
        LIMIT ${MAX_NODES}`;
      if (rows.length === 0) return { ...empty, asOf: asOf.toISOString() };

      const nodes = rows.map((r, i) => ({
        id: i,
        addr: r.address,
        score: r.score,
        smart: r.smart,
        top: r.top,
        cluster: r.clusterId ?? -1,
        pos: (r.x !== null && r.y !== null && r.z !== null ? [r.x, r.y, r.z] : fallbackPos(r.address)) as [number, number, number],
      }));
      const index = new Map(nodes.map((n) => [n.addr, n.id]));
      const addrs = nodes.map((n) => n.addr);
      const edgeRows = await sql<{ a: string; b: string }[]>`
        SELECT DISTINCT LEAST(src, dst) AS a, GREATEST(src, dst) AS b FROM wallet_edges
        WHERE src = ANY(${addrs}) AND dst = ANY(${addrs}) AND src <> dst AND ${notDemo(sql, demo)}
        LIMIT ${MAX_EDGES}`;
      const edges = edgeRows.flatMap((e) => {
        const a = index.get(e.a);
        const b = index.get(e.b);
        if (a === undefined || b === undefined) return [];
        return [{ a, b, flag: nodes[a]!.smart && nodes[b]!.smart }];
      });

      const clusterMap = new Map<number, { id: number; name: string; size: number }>();
      rows.forEach((r, i) => {
        const id = nodes[i]!.cluster;
        const c = clusterMap.get(id) ?? { id, name: r.clusterName ?? (id < 0 ? 'Unclustered' : `Cluster ${id}`), size: 0 };
        c.size += 1;
        clusterMap.set(id, c);
      });
      const sources = new Set(rows.map((r) => r.dataSource));
      return {
        nodes,
        edges,
        asOf: asOf.toISOString(),
        modelVersion: rows[0]!.modelVersion,
        clusters: [...clusterMap.values()].sort((x, y) => y.size - x.size),
        dataSource: sources.has('demo-synthetic') ? 'demo-synthetic' : [...sources][0]!,
      };
    },
  );

  /* ------------------------------ wallet detail ------------------------------ */

  app.get(
    '/wallets/:addr',
    { schema: { tags: ['radar'], params: z.object({ addr: z.string().min(32).max(44) }), response: { 200: WalletDetailSchema } } },
    async (req): Promise<WalletDetail> => {
      const addr = req.params.addr;
      if (!isValidSolanaAddress(addr)) return fail('bad_request', 'Not a valid Solana address');
      const scores = await sql<
        { asOf: Date; score: number; smart: boolean; top: boolean; contributions: unknown; reasons: unknown; modelVersion: string }[]
      >`SELECT as_of, score, smart, "top", contributions, reasons, model_version FROM wallet_scores
        WHERE address = ${addr} AND ${notDemo(sql, demo)} ORDER BY as_of DESC LIMIT 1`;
      const s = scores[0];
      const wrows = await sql<{ clusterId: number | null; clusterName: string | null; sybilClusterId: number | null; labelHidden: boolean }[]>`
        SELECT cluster_id, cluster_name, sybil_cluster_id, label_hidden FROM wallets WHERE address = ${addr}`;
      const w = wrows[0];
      if (!s) return fail('not_found', 'This wallet has not been scored yet');
      const zeroFeatures: WalletFeatures = { whaleOverlap: 0, entryTiming: 0, hitRate: 0, centrality: 0, leadTimeMin: 0, nMarkets: 0 };
      if (w?.labelHidden) {
        // the owner opted out of the label: nothing about the wallet's score or behavior is served
        return {
          address: addr, score: 0, smart: false, top: false, sybil: false, cluster: null, features: zeroFeatures,
          contributions: { whaleOverlap: 0, entryTiming: 0, hitRate: 0, centrality: 0, leadTime: 0 },
          reasons: [], tags: [], stats: { markets: 0, hitRate: 0, medianLeadMin: 0, volumeUsd: 0 }, openPositions: [],
          asOf: s.asOf.toISOString(), modelVersion: s.modelVersion, labelHidden: true,
        };
      }
      const frows = await sql<{ whaleOverlap: string; entryTiming: string; hitRate: string; centrality: string; leadTimeMin: string; nMarkets: number }[]>`
        SELECT whale_overlap, entry_timing, hit_rate, centrality, lead_time_min, n_markets FROM wallet_features
        WHERE address = ${addr} ORDER BY as_of DESC LIMIT 1`;
      const f = frows[0];
      const features: WalletFeatures = f
        ? { whaleOverlap: Number(f.whaleOverlap), entryTiming: Number(f.entryTiming), hitRate: Number(f.hitRate), centrality: Number(f.centrality), leadTimeMin: Number(f.leadTimeMin), nMarkets: f.nMarkets }
        : zeroFeatures;
      const sybil = w?.sybilClusterId != null;

      const vol = await sql<{ tradeUsdc: string | null; scoredUsdc: string | null; marketsTraded: number }[]>`
        SELECT (SELECT sum(usdc) FROM trades WHERE wallet = ${addr}) AS trade_usdc,
               (SELECT sum(usdc) FROM scored_positions WHERE wallet = ${addr} AND ${notDemo(sql, demo)}) AS scored_usdc,
               (SELECT count(DISTINCT market_id)::int FROM scored_positions WHERE wallet = ${addr} AND ${notDemo(sql, demo)}) AS markets_traded`;
      const v = vol[0]!;
      const volumeBase = numericToBigInt(v.tradeUsdc ?? '0') > 0n ? numericToBigInt(v.tradeUsdc ?? '0') : numericToBigInt(v.scoredUsdc ?? '0');

      const open = await sql<
        { marketId: string; question: string; side: 'above' | 'below'; usdc: string; entryPrice: string; shares: string | null; status: string; tradingEndTs: Date }[]
      >`SELECT sp.market_id, m.question, sp.side, sp.usdc, sp.entry_price, p.shares::text AS shares, m.status, m.trading_end_ts
        FROM scored_positions sp
        JOIN markets m ON m.id = sp.market_id AND m.hidden = false
        LEFT JOIN positions p ON p.wallet = sp.wallet AND p.market_id = sp.market_id AND p.side = sp.side
        WHERE sp.wallet = ${addr} AND ${notDemo(sql, demo, 'sp.data_source')} AND m.status = 'open'
        ORDER BY sp.ts DESC LIMIT 20`;
      const openPositions = open.map((o) => {
        const sideEntry = sidePrice(o.side, Number(o.entryPrice));
        const est = sideEntry > 0 ? BigInt(Math.round(Number(numericToBigInt(o.usdc)) / sideEntry)) : 0n;
        const shares = o.shares !== null && numericToBigInt(o.shares) > 0n ? numericToBigInt(o.shares) : est;
        return { marketId: o.marketId, question: o.question, side: o.side, shares: shares.toString(), entryPrice: round(sideEntry, 4) };
      });

      return {
        address: addr,
        score: s.score,
        smart: s.smart,
        top: s.top,
        sybil,
        cluster: w?.clusterId != null ? { id: w.clusterId, name: w.clusterName ?? `Cluster ${w.clusterId}` } : null,
        features,
        contributions: normalizeContributions(s.contributions),
        reasons: asStrArray(s.reasons),
        tags: deriveTags(features, sybil),
        stats: { markets: Math.max(features.nMarkets, v.marketsTraded), hitRate: features.hitRate, medianLeadMin: features.leadTimeMin, volumeUsd: round(Number(volumeBase) / 1e6, 2) },
        openPositions,
        asOf: s.asOf.toISOString(),
        modelVersion: s.modelVersion,
        labelHidden: false,
      };
    },
  );

  /* ------------------------------ track record ------------------------------ */

  app.get('/track-record/latest', { schema: { tags: ['radar'], response: { 200: TrackRecordSchema } } }, async (): Promise<TrackRecord> => {
    const runs = await sql<
      {
        id: number; runAt: Date; windowStart: Date; windowEnd: Date; dataSource: string; nMarkets: number;
        brierRadar: string | null; brierMarket: string | null; hitRateRadar: string | null; hitRateMarket: string | null;
        medianLeadMin: string | null; edgeRealizedCents: string | null; calibration: unknown; leadHist: unknown; modelVersion: string;
      }[]
    >`SELECT * FROM track_record_runs WHERE ${notDemo(sql, demo)} ORDER BY run_at DESC, id DESC LIMIT 1`;
    const run = runs[0];
    const now = ctx.now().toISOString();
    if (!run) {
      return {
        window: { start: now, end: now }, runAt: now, dataSource: 'none', nMarkets: 0,
        brier: { radar: null, market: null }, hitRate: { radar: null, market: null }, medianLeadMin: null, edgeRealizedCents: null,
        calibration: [], leadHistogram: [], rows: [], modelVersion: 'none', state: 'building',
      };
    }
    const rows = await sql<{ marketId: string; question: string | null; radarT24: string | null; marketT24: string | null; outcome: string | null; closer: string | null }[]>`
      SELECT market_id, question, radar_t24, market_t24, outcome, closer FROM track_record_rows WHERE run_id = ${run.id}
      ORDER BY market_id LIMIT 500`;
    const num = (x: string | null) => (x === null ? null : Number(x));
    const arr = (j: unknown): Record<string, unknown>[] => (Array.isArray(j) ? (j as Record<string, unknown>[]) : []);
    return {
      window: { start: run.windowStart.toISOString(), end: run.windowEnd.toISOString() },
      runAt: run.runAt.toISOString(),
      dataSource: run.dataSource,
      nMarkets: run.nMarkets,
      brier: { radar: num(run.brierRadar), market: num(run.brierMarket) },
      hitRate: { radar: num(run.hitRateRadar), market: num(run.hitRateMarket) },
      medianLeadMin: num(run.medianLeadMin),
      edgeRealizedCents: num(run.edgeRealizedCents),
      calibration: arr(run.calibration).map((c) => ({ bin: pick(c, 'bin'), predicted: pick(c, 'predicted'), observed: pick(c, 'observed'), n: pick(c, 'n') })),
      leadHistogram: arr(run.leadHist).map((h) => ({ bucketMin: pick(h, 'bucket_min', 'bucketMin'), count: pick(h, 'count') })),
      rows: rows.map((r) => ({
        marketId: r.marketId,
        question: r.question,
        radarT24: num(r.radarT24),
        marketT24: num(r.marketT24),
        outcome: r.outcome === 'above' || r.outcome === 'below' ? r.outcome : null,
        closer: r.closer === 'radar' || r.closer === 'market' || r.closer === 'tie' ? r.closer : null,
      })),
      modelVersion: run.modelVersion,
      state: run.nMarkets >= TRACK_RECORD_MIN_MARKETS ? 'ready' : 'building',
    };
  });
};
