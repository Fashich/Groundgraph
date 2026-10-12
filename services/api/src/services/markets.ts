import { notDemo, type MarketRow } from '@groundgraph/db';
import { assetByFeedId, feeBpsNow, numericToBigInt, priceAbove, RK } from '@groundgraph/svc-core';
import type {
  FairValueInfo,
  FlaggedEntry,
  MarketDetail,
  MarketStatus,
  MarketSummary,
  MarketWalletRow,
  Paged,
  RadarSummary,
  Side,
  TradeRow,
} from '@groundgraph/sdk/api-types';
import type { AppContext } from '../context';
import { ApiHttpError } from '../errors';
import { oracleInfo, readOracle } from './oracle';
import { fairValueForMarket } from './fairvalue';

export const MAX_FEE_BPS = 300;
const SPARK_POINTS = 48;
const SPARK_BUCKET_SECS = 1800;

/* ------------------------------ helpers ------------------------------ */

export function effectiveStatusOf(status: string, tradingEndTs: Date, now: Date): MarketStatus {
  if (status === 'settled' || status === 'voided') return status;
  return now.getTime() >= tradingEndTs.getTime() ? 'trading_closed' : 'open';
}

export function poolPrice(reserveAbove: string | bigint, reserveBelow: string | bigint): number {
  return priceAbove({ reserveAbove: numericToBigInt(reserveAbove), reserveBelow: numericToBigInt(reserveBelow) });
}

export function sidePrice(side: Side, abovePrice: number): number {
  return side === 'above' ? abovePrice : 1 - abovePrice;
}

export function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export function feeStateOf(r: Pick<MarketRow, 'baseFeeBps' | 'dynamicFee' | 'emaImpactBps' | 'emaTs' | 'settleTs'>, maxFeeBps = MAX_FEE_BPS) {
  return {
    baseFeeBps: r.baseFeeBps,
    dynamicFee: r.dynamicFee,
    emaImpactBps: r.emaImpactBps,
    emaTs: r.emaTs,
    settleTs: Math.floor(r.settleTs.getTime() / 1000),
    maxFeeBps,
  };
}

/* ------------------------------ radar ------------------------------ */

export function buildingRadar(n = 0): RadarSummary {
  return { state: 'building', p: null, ci: null, n, edge: null, modelVersion: null, ts: null };
}

/** Latest market_radar row per market (demo rows hidden unless DEMO_MODE), with a flagged-wallet count for the Building state. */
export async function radarSummaries(ctx: AppContext, ids: string[]): Promise<Map<string, RadarSummary>> {
  const out = new Map<string, RadarSummary>();
  if (ids.length === 0) return out;
  const sql = ctx.db.sql;
  const demo = ctx.cfg.DEMO_MODE;
  const rows = await sql<
    { marketId: string; ts: Date; pAbove: string; ciPts: number; nFlagged: number; edgeCents: number; modelVersion: string; state: string }[]
  >`SELECT DISTINCT ON (market_id) market_id, ts, p_above, ci_pts, n_flagged, edge_cents, model_version, state
    FROM market_radar WHERE market_id = ANY(${ids}) AND ${notDemo(sql, demo)}
    ORDER BY market_id, ts DESC`;
  for (const r of rows) {
    if (r.state === 'ready') {
      out.set(r.marketId, {
        state: 'ready',
        p: Number(r.pAbove),
        ci: r.ciPts,
        n: r.nFlagged,
        edge: r.edgeCents,
        modelVersion: r.modelVersion,
        ts: r.ts.toISOString(),
      });
    } else {
      out.set(r.marketId, { ...buildingRadar(r.nFlagged), modelVersion: r.modelVersion, ts: r.ts.toISOString() });
    }
  }
  const missing = ids.filter((id) => !out.has(id));
  if (missing.length) {
    const counts = await sql<{ marketId: string; n: number }[]>`SELECT sp.market_id, count(*)::int AS n
      FROM scored_positions sp
      WHERE sp.market_id = ANY(${missing}) AND ${notDemo(sql, demo, 'sp.data_source')}
        AND COALESCE((SELECT s.smart FROM wallet_scores s WHERE s.address = sp.wallet AND ${notDemo(sql, demo, 's.data_source')}
                      ORDER BY s.as_of DESC LIMIT 1), false)
        AND NOT COALESCE((SELECT w.label_hidden FROM wallets w WHERE w.address = sp.wallet), false)
      GROUP BY sp.market_id`;
    const byId = new Map(counts.map((c) => [c.marketId, c.n]));
    for (const id of missing) out.set(id, buildingRadar(byId.get(id) ?? 0));
  }
  return out;
}

/* ------------------------------ spark lines ------------------------------ */

/** 48 points of ABOVE price (30 minute buckets, last value per bucket, forward filled) for each market. */
export async function sparklines(ctx: AppContext, rows: { id: string; price: number; price24h: number | null }[], now: Date): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (rows.length === 0) return out;
  const ids = rows.map((r) => r.id);
  const nowSec = Math.floor(now.getTime() / 1000);
  const lastBucket = nowSec - (nowSec % SPARK_BUCKET_SECS);
  const firstBucket = lastBucket - (SPARK_POINTS - 1) * SPARK_BUCKET_SECS;
  const ticks = await ctx.db.sql<{ marketId: string; bucket: Date; priceAbove: string }[]>`
    SELECT DISTINCT ON (market_id, bucket) market_id, bucket, price_above FROM (
      SELECT market_id, ts, price_above,
             date_bin(interval '30 minutes', ts, TIMESTAMPTZ '1970-01-01 00:00:00+00') AS bucket
      FROM market_ticks WHERE market_id = ANY(${ids}) AND ts >= ${new Date(firstBucket * 1000)} AND ts <= ${now}
    ) s ORDER BY market_id, bucket, ts DESC`;
  const byMarket = new Map<string, Map<number, number>>();
  for (const t of ticks) {
    const m = byMarket.get(t.marketId) ?? new Map<number, number>();
    m.set(Math.floor(t.bucket.getTime() / 1000), Number(t.priceAbove));
    byMarket.set(t.marketId, m);
  }
  for (const r of rows) {
    const m = byMarket.get(r.id);
    const series: number[] = [];
    let last: number | null = r.price24h;
    if (!m || m.size === 0) {
      out.set(r.id, [r.price]);
      continue;
    }
    for (let i = 0; i < SPARK_POINTS; i++) {
      const v = m.get(firstBucket + i * SPARK_BUCKET_SECS);
      if (v !== undefined) last = v;
      series.push(last ?? Number.NaN);
    }
    // back-fill leading gaps with the first known value, pin the final point to the live price
    const firstKnown = series.find((v) => !Number.isNaN(v)) ?? r.price;
    const filled = series.map((v) => (Number.isNaN(v) ? firstKnown : v));
    filled[filled.length - 1] = r.price;
    out.set(r.id, filled.map((v) => round(v, 4)));
  }
  return out;
}

/* ------------------------------ list + summary ------------------------------ */

interface ListRow extends MarketRow {
  effStatus: MarketStatus;
  volume: string;
  traders: number;
  price24h: string | null;
  firstPrice: string | null;
}

export interface ListOptions {
  cat?: string | undefined;
  lean?: 'any' | 'above' | 'below' | undefined;
  ends?: 'any' | '48h' | '2w' | 'long' | undefined;
  sort?: 'signal' | 'gap' | 'ending' | 'volume' | 'newest' | undefined;
  q?: string | undefined;
  watchWallet?: string | undefined;
  status?: string | undefined;
  limit: number;
  offset: number;
  ids?: string[] | undefined;
  includeHidden?: boolean | undefined;
}

function normCat(cat: string | undefined): 'all' | 'high-signal' | 'majors' | 'solana-ecosystem' | 'none' {
  const c = (cat ?? 'all').toLowerCase().trim().replace(/\s+/g, '-');
  if (c === '' || c === 'all') return 'all';
  if (c === 'high-signal') return 'high-signal';
  if (c === 'majors') return 'majors';
  if (c === 'solana-ecosystem' || c === 'solana') return 'solana-ecosystem';
  return 'none'; // e.g. "Ratios" is not available in this version
}

export async function loadMarketRows(ctx: AppContext, opts: ListOptions): Promise<ListRow[]> {
  const sql = ctx.db.sql;
  const now = ctx.now();
  const status = (opts.status ?? 'active').toLowerCase();
  const statusFilter =
    status === 'all'
      ? sql`true`
      : status === 'active'
        ? sql`m.eff_status IN ('open','trading_closed')`
        : status === 'resolved'
          ? sql`m.eff_status IN ('settled','voided')`
          : sql`m.eff_status = ${status}`;
  const cat = normCat(opts.cat);
  const catFilter =
    cat === 'majors'
      ? sql`m.asset_symbol IN ('BTC','ETH','SOL')`
      : cat === 'solana-ecosystem'
        ? sql`m.asset_symbol NOT IN ('BTC','ETH','SOL')`
        : cat === 'none'
          ? sql`false`
          : sql`true`;
  const ends = opts.ends ?? 'any';
  const endsFilter =
    ends === '48h'
      ? sql`m.settle_ts < ${new Date(now.getTime() + 48 * 3600_000)}`
      : ends === '2w'
        ? sql`m.settle_ts < ${new Date(now.getTime() + 14 * 86_400_000)}`
        : ends === 'long'
          ? sql`m.settle_ts >= ${new Date(now.getTime() + 14 * 86_400_000)}`
          : sql`true`;
  const qFilter = opts.q ? sql`(m.question ILIKE ${'%' + opts.q.replace(/[%_\\]/g, '\\$&') + '%'} OR m.asset_symbol ILIKE ${opts.q.replace(/[%_\\]/g, '\\$&')})` : sql`true`;
  const watchFilter = opts.watchWallet
    ? sql`EXISTS (SELECT 1 FROM watchlist w WHERE w.wallet = ${opts.watchWallet} AND w.market_id = m.id)`
    : sql`true`;
  const idFilter = opts.ids ? sql`m.id = ANY(${opts.ids})` : sql`true`;
  const hiddenFilter = opts.includeHidden ? sql`true` : sql`m.hidden = false`;
  return sql<ListRow[]>`
    SELECT m.*, COALESCE(t.volume, 0)::text AS volume, COALESCE(t.traders, 0) AS traders,
      (SELECT k.price_above::text FROM market_ticks k WHERE k.market_id = m.id AND k.ts <= ${new Date(now.getTime() - 86_400_000)} ORDER BY k.ts DESC LIMIT 1) AS price24h,
      (SELECT k.price_above::text FROM market_ticks k WHERE k.market_id = m.id ORDER BY k.ts ASC LIMIT 1) AS first_price
    FROM (SELECT mm.*, CASE WHEN mm.status = 'open' AND ${now} >= mm.trading_end_ts THEN 'trading_closed' ELSE mm.status END AS eff_status FROM markets mm) m
    LEFT JOIN LATERAL (SELECT sum(usdc) AS volume, count(DISTINCT wallet)::int AS traders FROM trades WHERE market_id = m.id) t ON true
    WHERE ${hiddenFilter} AND ${statusFilter} AND ${catFilter} AND ${endsFilter} AND ${qFilter} AND ${watchFilter} AND ${idFilter}
    ORDER BY m.created_at DESC
    LIMIT 500`;
}

export function toSummary(r: ListRow, spark: number[], radar: RadarSummary, nowSec: number): MarketSummary {
  const price = poolPrice(r.reserveAbove, r.reserveBelow);
  const ref = r.price24h !== null ? Number(r.price24h) : r.firstPrice !== null ? Number(r.firstPrice) : price;
  const fee = feeBpsNow(feeStateOf(r), nowSec);
  return {
    id: r.id,
    question: r.question,
    kind: r.kind,
    direction: r.direction,
    assetSymbol: r.assetSymbol,
    category: r.category === 'crypto' ? categoryOf(r.assetSymbol) : r.category,
    targetPrice: Number(r.targetPrice),
    status: r.effStatus,
    outcome: r.outcome,
    priceAbove: price,
    implied: price,
    ch24: round((price - ref) * 100, 1),
    spark,
    radar,
    feeBpsNow: fee.totalBps,
    baseFeeBps: r.baseFeeBps,
    dynamicFee: r.dynamicFee,
    endsAt: r.settleTs.toISOString(),
    tradingEndsAt: r.tradingEndTs.toISOString(),
    volume: numericToBigInt(r.volume).toString(),
    liquidity: numericToBigInt(r.completeSets).toString(),
    traders: r.traders,
    creator: r.creator,
  };
}

function categoryOf(sym: string): string {
  return ['BTC', 'ETH', 'SOL'].includes(sym.toUpperCase()) ? 'Majors' : 'Solana ecosystem';
}

export async function summarize(ctx: AppContext, rows: ListRow[]): Promise<MarketSummary[]> {
  const now = ctx.now();
  const nowSec = Math.floor(now.getTime() / 1000);
  const radar = await radarSummaries(ctx, rows.map((r) => r.id));
  const sparks = await sparklines(
    ctx,
    rows.map((r) => ({ id: r.id, price: poolPrice(r.reserveAbove, r.reserveBelow), price24h: r.price24h !== null ? Number(r.price24h) : r.firstPrice !== null ? Number(r.firstPrice) : null })),
    now,
  );
  return rows.map((r) => toSummary(r, sparks.get(r.id) ?? [poolPrice(r.reserveAbove, r.reserveBelow)], radar.get(r.id) ?? buildingRadar(), nowSec));
}

function sortSummaries(items: MarketSummary[], sort: ListOptions['sort'], now: Date): MarketSummary[] {
  const abs = (n: number | null) => (n === null ? -1 : Math.abs(n));
  const copy = [...items];
  const activeFirst = (m: MarketSummary) => (m.status === 'open' || m.status === 'trading_closed' ? 0 : 1);
  switch (sort) {
    case 'gap':
      copy.sort((a, b) => abs(b.radar.edge) - abs(a.radar.edge) || Number(BigInt(b.volume) - BigInt(a.volume)));
      break;
    case 'ending':
      copy.sort((a, b) => activeFirst(a) - activeFirst(b) || Date.parse(a.endsAt) - Date.parse(b.endsAt));
      break;
    case 'volume':
      copy.sort((a, b) => (BigInt(b.volume) > BigInt(a.volume) ? 1 : BigInt(b.volume) < BigInt(a.volume) ? -1 : 0));
      break;
    case 'newest':
      break; // already created_at DESC
    case 'signal':
    default:
      copy.sort(
        (a, b) =>
          (b.radar.state === 'ready' ? 1 : 0) - (a.radar.state === 'ready' ? 1 : 0) ||
          b.radar.n - a.radar.n ||
          abs(b.radar.edge) - abs(a.radar.edge) ||
          (BigInt(b.volume) > BigInt(a.volume) ? 1 : -1),
      );
  }
  void now;
  return copy;
}

export async function listMarkets(ctx: AppContext, opts: ListOptions): Promise<Paged<MarketSummary>> {
  const rows = await loadMarketRows(ctx, opts);
  let items = await summarize(ctx, rows);
  const cat = normCat(opts.cat);
  if (cat === 'high-signal') items = items.filter((m) => m.radar.state === 'ready' && m.radar.n >= 3 && Math.abs(m.radar.edge ?? 0) >= 3);
  if (opts.lean === 'above') items = items.filter((m) => m.radar.state === 'ready' && (m.radar.edge ?? 0) > 0);
  if (opts.lean === 'below') items = items.filter((m) => m.radar.state === 'ready' && (m.radar.edge ?? 0) < 0);
  items = sortSummaries(items, opts.sort, ctx.now());
  const page = items.slice(opts.offset, opts.offset + opts.limit);
  const next = opts.offset + opts.limit < items.length ? `o:${opts.offset + opts.limit}` : null;
  return { items: page, nextCursor: next };
}

export async function getMarketSummary(ctx: AppContext, id: string): Promise<MarketSummary | null> {
  const rows = await loadMarketRows(ctx, { ids: [id], status: 'all', includeHidden: true, limit: 1, offset: 0 });
  if (rows.length === 0) return null;
  return (await summarize(ctx, rows))[0] ?? null;
}

export async function getMarketRow(ctx: AppContext, id: string): Promise<MarketRow | null> {
  const rows = await ctx.db.sql<MarketRow[]>`SELECT * FROM markets WHERE id = ${id}`;
  return rows[0] ?? null;
}

/* ------------------------------ detail ------------------------------ */

type Tf = '1D' | '3D' | '1W' | 'ALL';

async function history(ctx: AppContext, r: MarketRow, tf: Tf, currentPrice: number): Promise<{ ts: string; priceAbove: number }[]> {
  const now = ctx.now();
  let from: Date;
  let bucket: number;
  if (tf === '1D') [from, bucket] = [new Date(now.getTime() - 86_400_000), 600];
  else if (tf === '3D') [from, bucket] = [new Date(now.getTime() - 3 * 86_400_000), 1800];
  else if (tf === '1W') [from, bucket] = [new Date(now.getTime() - 7 * 86_400_000), 3600];
  else {
    from = r.openTs;
    bucket = Math.max(600, Math.ceil((now.getTime() - r.openTs.getTime()) / 1000 / 300 / 60) * 60);
  }
  const rows = await ctx.db.sql<{ ts: Date; priceAbove: string }[]>`
    SELECT DISTINCT ON (bucket) bucket AS ts, price_above FROM (
      SELECT date_bin(make_interval(secs => ${bucket}::int), ts, TIMESTAMPTZ '1970-01-01 00:00:00+00') AS bucket, ts, price_above
      FROM market_ticks WHERE market_id = ${r.id} AND ts >= ${from} AND ts <= ${now}
    ) s ORDER BY bucket, ts DESC`;
  const points = rows.map((p) => ({ ts: p.ts.toISOString(), priceAbove: Number(p.priceAbove) }));
  const live = r.status === 'open' || r.status === 'settled' || r.status === 'voided';
  if (live && (points.length === 0 || Date.parse(points[points.length - 1]!.ts) < now.getTime())) {
    points.push({ ts: now.toISOString(), priceAbove: currentPrice });
  }
  return points;
}

export async function flaggedEntries(ctx: AppContext, marketId: string): Promise<FlaggedEntry[]> {
  const sql = ctx.db.sql;
  const demo = ctx.cfg.DEMO_MODE;
  const rows = await sql<{ ts: Date; wallet: string; side: Side; entryPrice: string; usdc: string; score: number }[]>`
    SELECT sp.ts, sp.wallet, sp.side, sp.entry_price, sp.usdc, ws.score
    FROM scored_positions sp
    JOIN LATERAL (SELECT s.score, s.smart FROM wallet_scores s WHERE s.address = sp.wallet AND ${notDemo(sql, demo, 's.data_source')}
                  ORDER BY s.as_of DESC LIMIT 1) ws ON ws.smart
    LEFT JOIN wallets w ON w.address = sp.wallet
    WHERE sp.market_id = ${marketId} AND ${notDemo(sql, demo, 'sp.data_source')} AND COALESCE(w.label_hidden, false) = false
    ORDER BY sp.ts DESC LIMIT 100`;
  return rows.map((r) => ({
    ts: r.ts.toISOString(),
    wallet: r.wallet,
    side: r.side,
    priceAtEntry: round(sidePrice(r.side, Number(r.entryPrice)), 4),
    usdc: numericToBigInt(r.usdc).toString(),
    score: r.score,
  }));
}

function rulesFor(r: MarketRow, symbol: string) {
  const when = r.settleTs.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const target = Number(r.targetPrice);
  return {
    text:
      `This price market settles ABOVE if the Pyth ${symbol} price at ${when} is strictly above $${target.toLocaleString('en-US', { maximumFractionDigits: 8 })}, ` +
      `otherwise it settles BELOW. Each winning share settles at $1 and each losing share at $0. You can redeem winning shares after settlement, ` +
      `and sell or merge before it.`,
    settleRule:
      `Settlement uses a fully verified Pyth price published within 60 seconds after the settlement time, with a confidence interval of at most 0.5% of the price. ` +
      `If no valid price arrives within 1 hour, the market is voided and every share redeems at $0.50.`,
    oracleFeedId: r.feedId,
  };
}

export async function getMarketDetail(ctx: AppContext, id: string, tf: Tf): Promise<MarketDetail | null> {
  const summary = await getMarketSummary(ctx, id);
  if (!summary) return null;
  const r = (await getMarketRow(ctx, id))!;
  const now = ctx.now();
  const nowSec = Math.floor(now.getTime() / 1000);
  const snap = await readOracle(ctx, r.feedId);
  const fee = feeBpsNow(feeStateOf(r), nowSec);
  const asset = assetByFeedId(r.feedId);
  const symbol = asset?.pair ?? `${r.assetSymbol}/USD`;
  const [pts, flagged, fv] = await Promise.all([
    history(ctx, r, tf, summary.priceAbove),
    flaggedEntries(ctx, id),
    fairValueForMarket(ctx, r),
  ]);
  return {
    ...summary,
    history: { tf, points: pts },
    flaggedEntries: flagged,
    fairValue: fv,
    oracle: oracleInfo(ctx, r.feedId, snap, now.getTime()),
    rules: rulesFor(r, symbol),
    pool: {
      reserveAbove: numericToBigInt(r.reserveAbove).toString(),
      reserveBelow: numericToBigInt(r.reserveBelow).toString(),
      completeSets: numericToBigInt(r.completeSets).toString(),
      feePool: numericToBigInt(r.feePool).toString(),
      vault: r.vault,
      aboveMint: r.aboveMint,
      belowMint: r.belowMint,
      lpMint: r.lpMint,
    },
    feeBreakdown: { baseBps: fee.baseBps, nearBps: fee.nearBps, flowBps: fee.flowBps, totalBps: fee.totalBps, capBps: MAX_FEE_BPS },
    settlePrice: r.settlePrice === null ? null : Number(r.settlePrice),
    settlePublishTs: r.settlePublishTs ? r.settlePublishTs.toISOString() : null,
  };
}

/* ------------------------------ wallets and trades of a market ------------------------------ */

export async function marketWallets(ctx: AppContext, marketId: string): Promise<MarketWalletRow[]> {
  const sql = ctx.db.sql;
  const demo = ctx.cfg.DEMO_MODE;
  const rows = await sql<
    {
      address: string; side: Side; entryPrice: string; usdc: string; score: number; smart: boolean; top: boolean;
      whaleOverlap: string | null; entryTiming: string | null; hitRate: string | null; centrality: string | null; leadTimeMin: string | null; nMarkets: number | null;
      sybil: boolean;
    }[]
  >`SELECT sp.wallet AS address, sp.side, sp.entry_price, sp.usdc, ws.score, ws.smart, ws.top,
           f.whale_overlap, f.entry_timing, f.hit_rate, f.centrality, f.lead_time_min, f.n_markets,
           (w.sybil_cluster_id IS NOT NULL) AS sybil
    FROM scored_positions sp
    JOIN LATERAL (SELECT s.score, s.smart, s.top FROM wallet_scores s WHERE s.address = sp.wallet AND ${notDemo(sql, demo, 's.data_source')}
                  ORDER BY s.as_of DESC LIMIT 1) ws ON true
    LEFT JOIN LATERAL (SELECT * FROM wallet_features f2 WHERE f2.address = sp.wallet ORDER BY f2.as_of DESC LIMIT 1) f ON true
    LEFT JOIN wallets w ON w.address = sp.wallet
    WHERE sp.market_id = ${marketId} AND ${notDemo(sql, demo, 'sp.data_source')} AND COALESCE(w.label_hidden, false) = false
    ORDER BY ws.score DESC, sp.usdc DESC LIMIT 100`;
  return rows.map((r) => ({
    address: r.address,
    score: r.score,
    smart: r.smart,
    top: r.top,
    side: r.side,
    entryPrice: round(sidePrice(r.side, Number(r.entryPrice)), 4),
    usdc: numericToBigInt(r.usdc).toString(),
    features: {
      whaleOverlap: Number(r.whaleOverlap ?? 0),
      entryTiming: Number(r.entryTiming ?? 0),
      hitRate: Number(r.hitRate ?? 0),
      centrality: Number(r.centrality ?? 0),
      leadTimeMin: Number(r.leadTimeMin ?? 0),
      nMarkets: r.nMarkets ?? 0,
    },
    sybil: r.sybil,
  }));
}

export async function marketTrades(ctx: AppContext, marketId: string, cursor: string | null, limit: number): Promise<Paged<TradeRow>> {
  const sql = ctx.db.sql;
  const demo = ctx.cfg.DEMO_MODE;
  // keyset on (ts, id): chronological even when a backfill inserts older trades after newer ones
  const m = cursor ? /^(\d{10,16}):(\d{1,18})$/.exec(cursor) : null;
  if (cursor && !m) throw new ApiHttpError('bad_request', 'Invalid cursor');
  const curTs = m ? new Date(Number(m[1])) : null;
  const curId = m ? Number(m[2]) : null;
  const rows = await sql<
    { id: number; ts: Date; wallet: string; side: Side; direction: 'buy' | 'sell'; usdc: string; shares: string; feeUsdc: string; priceAfter: string; txSig: string; flagged: boolean }[]
  >`SELECT t.id, date_trunc('milliseconds', t.ts) AS ts, t.wallet, t.side, t.direction, t.usdc, t.shares, t.fee_usdc, t.price_after, t.tx_sig,
           (COALESCE((SELECT s.smart FROM wallet_scores s WHERE s.address = t.wallet AND ${notDemo(sql, demo, 's.data_source')} ORDER BY s.as_of DESC LIMIT 1), false)
            AND NOT COALESCE((SELECT w.label_hidden FROM wallets w WHERE w.address = t.wallet), false)) AS flagged
    FROM trades t
    WHERE t.market_id = ${marketId}
      AND (${curTs}::timestamptz IS NULL OR (date_trunc('milliseconds', t.ts), t.id) < (${curTs}::timestamptz, ${curId}::bigint))
    ORDER BY t.ts DESC, t.id DESC LIMIT ${limit + 1}`;
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((t) => ({
      id: String(t.id),
      ts: t.ts.toISOString(),
      wallet: t.wallet,
      side: t.side,
      dir: t.direction,
      usdc: numericToBigInt(t.usdc).toString(),
      shares: numericToBigInt(t.shares).toString(),
      feeUsdc: numericToBigInt(t.feeUsdc).toString(),
      priceAfter: Number(t.priceAfter),
      txSig: t.txSig,
      flagged: t.flagged,
    })),
    nextCursor: hasMore && last ? `${last.ts.getTime()}:${last.id}` : null,
  };
}

export type { FairValueInfo };
export { RK };
