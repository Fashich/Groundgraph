/**
 * Deterministic fixtures for the mock API. Every dataset is synthetic and labelled 'demo-synthetic'.
 * Times are relative to server start so countdowns always look alive.
 */
import type {
  FlaggedEntry,
  GraphEdge,
  GraphNode,
  MarketWalletRow,
  RadarSummary,
  Side,
  TradeRow,
  TrackRecord,
  WalletContributions,
  WalletDetail,
  WalletFeatures,
} from '@groundgraph/sdk/api-types';
import { fakeAddress, gauss, hashStr, mulberry32, range } from './rng';
import { seedPool, type Pool } from './amm';

export const DATA_SOURCE = 'demo-synthetic';
export const MODEL_VERSION = 'sage-demo-0.3';
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export interface MockAsset {
  symbol: string;
  feedId: string;
  price: number;
  vol: number;
  ch24: number;
  feed: string;
}

export const ASSETS: MockAsset[] = [
  { symbol: 'SOL', price: 214.32, vol: 0.62, ch24: 2.4 },
  { symbol: 'BTC', price: 118420, vol: 0.42, ch24: 0.8 },
  { symbol: 'ETH', price: 4212, vol: 0.55, ch24: -1.1 },
  { symbol: 'JUP', price: 0.94, vol: 0.9, ch24: 4.6 },
  { symbol: 'JTO', price: 3.18, vol: 0.85, ch24: -2.3 },
  { symbol: 'PYTH', price: 0.47, vol: 0.95, ch24: 1.7 },
  { symbol: 'WIF', price: 2.41, vol: 1.3, ch24: 6.2 },
  { symbol: 'BONK', price: 0.0000318, vol: 1.2, ch24: -3.4 },
  { symbol: 'RAY', price: 4.86, vol: 0.9, ch24: 0.9 },
  { symbol: 'HNT', price: 6.12, vol: 0.8, ch24: -1.8 },
].map((a, i) => ({ ...a, feedId: (hashStr(a.symbol + 'feed').toString(16).padStart(8, '0') + i.toString(16).padStart(2, '0')).repeat(8).slice(0, 64), feed: `${a.symbol}/USD` }));

export const assetBySymbol = (s: string) => ASSETS.find((a) => a.symbol === s);

export const CLUSTERS = [
  { id: 1, name: 'Early LP cohort', smart: 0.5, w: 0.15 },
  { id: 2, name: 'Momentum desks', smart: 0.42, w: 0.14 },
  { id: 3, name: 'MEV searchers', smart: 0.3, w: 0.12 },
  { id: 4, name: 'Treasury rotators', smart: 0.4, w: 0.13 },
  { id: 5, name: 'Retail flow', smart: 0.04, w: 0.26 },
  { id: 6, name: 'Airdrop farmers', smart: 0.03, w: 0.2 },
];

const FEAT_W = { whaleOverlap: 0.31, entryTiming: 0.26, hitRate: 0.2, centrality: 0.13, leadTime: 0.1 };

export interface MockWallet {
  idx: number;
  addr: string;
  cluster: number;
  score: number;
  smart: boolean;
  top: boolean;
  sybil: boolean;
  features: WalletFeatures;
  contributions: WalletContributions;
  reasons: string[];
  tags: string[];
  pos: [number, number, number];
  stats: { markets: number; hitRate: number; medianLeadMin: number; volumeUsd: number };
  labelHidden: boolean;
}

function reasonFor(k: keyof WalletContributions, v: number): string {
  switch (k) {
    case 'whaleOverlap':
      return `Shares ${Math.max(1, Math.round(v * 9))} counterparties with known whale wallets`;
    case 'entryTiming':
      return `Entered ${Math.round(v * 14)} of the last 14 markets before a move larger than 5%`;
    case 'hitRate':
      return `${Math.round(v * 100)}% hit rate on resolved markets (30d)`;
    case 'centrality':
      return `Top ${Math.max(1, Math.round((1 - v) * 40))}% by graph centrality, bridging ${1 + Math.round(v * 3)} clusters`;
    default:
      return `Median lead of ${Math.round(8 + v * 60)} minutes ahead of price moves`;
  }
}

export function buildWallets(): { wallets: MockWallet[]; edges: GraphEdge[] } {
  const r = mulberry32(20261012);
  const wallets: MockWallet[] = [];
  const centers = CLUSTERS.map((_, i) => {
    const y = 1 - ((i + 0.5) / CLUSTERS.length) * 2;
    const rad = Math.sqrt(1 - y * y);
    const th = i * 2.399963;
    return [Math.cos(th) * rad * 1.15, y * 0.85, Math.sin(th) * rad * 1.15] as [number, number, number];
  });
  for (let i = 0; i < 184; i++) {
    const p = r();
    let acc = 0;
    let ci = 0;
    for (let j = 0; j < CLUSTERS.length; j++) {
      acc += CLUSTERS[j]!.w;
      ci = j;
      if (p <= acc) break;
    }
    const cand = r() < CLUSTERS[ci]!.smart;
    const f = cand
      ? { whaleOverlap: range(r, 0.62, 0.99), entryTiming: range(r, 0.55, 0.97), hitRate: range(r, 0.58, 0.94), centrality: range(r, 0.4, 0.95), leadTime: range(r, 0.5, 0.98) }
      : { whaleOverlap: range(r, 0.04, 0.5), entryTiming: range(r, 0.05, 0.55), hitRate: range(r, 0.25, 0.6), centrality: range(r, 0.05, 0.6), leadTime: range(r, 0.02, 0.5) };
    const contributions: WalletContributions = {
      whaleOverlap: Math.round(FEAT_W.whaleOverlap * f.whaleOverlap * 100),
      entryTiming: Math.round(FEAT_W.entryTiming * f.entryTiming * 100),
      hitRate: Math.round(FEAT_W.hitRate * f.hitRate * 100),
      centrality: Math.round(FEAT_W.centrality * f.centrality * 100),
      leadTime: Math.round(FEAT_W.leadTime * f.leadTime * 100),
    };
    const score = Object.values(contributions).reduce((a, b) => a + b, 0);
    const c = centers[ci]!;
    const spread = cand ? 0.26 : 0.36;
    let pos: [number, number, number] = [c[0] + gauss(r) * spread, c[1] + gauss(r) * spread * 0.8, c[2] + gauss(r) * spread];
    if (cand) pos = pos.map((x) => x * 0.82) as [number, number, number];
    const sorted = (Object.keys(contributions) as (keyof WalletContributions)[]).sort((a, b) => contributions[b] - contributions[a]);
    const reasons = sorted.slice(0, 3).map((k) => reasonFor(k, k === 'leadTime' ? f.leadTime : f[k]));
    const tags: string[] = [];
    if (f.entryTiming > 0.7) tags.push('Early entrant');
    if (f.whaleOverlap > 0.75) tags.push('Whale-adjacent');
    if (f.hitRate > 0.75) tags.push('High hit rate');
    if (f.centrality > 0.75) tags.push('Bridge wallet');
    const smart = score >= 70;
    wallets.push({
      idx: i,
      addr: fakeAddress(r),
      cluster: CLUSTERS[ci]!.id,
      score,
      smart,
      top: score >= 86,
      sybil: smart && r() < 0.06,
      features: { ...f, leadTimeMin: Math.round(8 + f.leadTime * 60), nMarkets: Math.round(range(r, 6, 60)) },
      contributions,
      reasons,
      tags,
      pos,
      stats: { markets: Math.round(range(r, 6, 60)), hitRate: f.hitRate, medianLeadMin: Math.round(8 + f.leadTime * 60), volumeUsd: Math.round(cand ? range(r, 18000, 420000) : range(r, 200, 28000)) },
      labelHidden: false,
    });
  }
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const add = (a: number, b: number, flag: boolean) => {
    const k = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(k) || a === b) return;
    seen.add(k);
    edges.push({ a, b, flag });
  };
  const d2 = (p: number[], q: number[]) => (p[0]! - q[0]!) ** 2 + (p[1]! - q[1]!) ** 2 + (p[2]! - q[2]!) ** 2;
  wallets.forEach((w, i) => {
    const near = wallets.filter((o, j) => j !== i && o.cluster === w.cluster).map((o) => [d2(w.pos, o.pos), o.idx] as const).sort((x, y) => x[0] - y[0]);
    near.slice(0, 2).forEach((n) => add(i, n[1], w.smart && wallets[n[1]]!.smart));
    if (w.smart && r() < 0.8) {
      let best = -1;
      let bd = 1e9;
      for (const o of wallets) {
        if (o.smart && o.cluster !== w.cluster) {
          const dd = d2(w.pos, o.pos) + r() * 0.6;
          if (dd < bd) {
            bd = dd;
            best = o.idx;
          }
        }
      }
      if (best >= 0) add(i, best, true);
    } else if (r() < 0.12) add(i, Math.floor(r() * wallets.length), false);
  });
  return { wallets, edges };
}

export interface MockMember {
  wallet: number;
  side: Side;
  entryPrice: number;
  usdc: bigint;
  ts: number;
}

export interface MockMarket {
  id: string;
  asset: string;
  category: string;
  kind: 'close' | 'touch';
  /** For touch markets: which way the level has to be crossed. Close markets use 'above'. */
  dir: 'above' | 'below';
  target: number;
  createdAt: number;
  settleTs: number;
  tradingEndsTs: number;
  status: 'open' | 'trading_closed' | 'settled' | 'voided';
  outcome: Side | null;
  pool: Pool;
  completeSets: bigint;
  feeFeePool: bigint;
  baseFeeBps: number;
  dynamicFee: boolean;
  volume: bigint;
  traders: number;
  creator: string;
  featured?: boolean;
  oracleStale?: boolean;
  /** 15-minute samples of priceAbove for 14 days, oldest first. */
  series: number[];
  members: MockMember[];
  flaggedAt: number[];
  question: string;
}

export function fmtTarget(v: number): string {
  if (v >= 1000) return '$' + v.toLocaleString('en-US');
  if (v < 0.001) return '$' + v.toFixed(7);
  if (v < 10) return '$' + v.toFixed(2);
  return '$' + v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const dateLabel = (ms: number) => `${MONTHS[new Date(ms).getUTCMonth()]} ${new Date(ms).getUTCDate()}`;

export function makeQuestion(m: Pick<MockMarket, 'asset' | 'kind' | 'dir' | 'target' | 'settleTs'>): string {
  const t = fmtTarget(m.target);
  const d = dateLabel(m.settleTs);
  if (m.kind === 'close') return `${m.asset} above or below ${t} at the ${d} close?`;
  return m.dir === 'above' ? `${m.asset} before ${d}: breaks above ${t} or stays below?` : `${m.asset} before ${d}: holds above ${t} or breaks below?`;
}

export function ruleText(m: Pick<MockMarket, 'asset' | 'kind' | 'dir' | 'target' | 'settleTs'>): { text: string; settleRule: string } {
  const t = fmtTarget(m.target);
  const d = dateLabel(m.settleTs);
  const feed = `${m.asset}/USD`;
  if (m.kind === 'close') {
    return { text: `This price market settles ABOVE if the Pyth ${feed} price at ${d} 23:59 UTC is strictly above ${t}, otherwise it settles BELOW. Each winning share settles at $1 and each losing share at $0. You can redeem winning shares after settlement, and sell or merge before it.`, settleRule: 'Settlement uses a fully verified Pyth price published within 60 seconds after the settlement time, with a confidence interval of at most 0.5% of the price. If no valid price arrives within 1 hour, the market is voided and every share redeems at $0.50.' };
  }
  return m.dir === 'below'
    ? { text: `Settles BELOW if any valid Pyth ${feed} price (confidence under 0.5%) at or below ${t} is published before ${d}, 00:00 UTC. Otherwise settles ABOVE.`, settleRule: 'touch-down' }
    : { text: `Settles ABOVE if any valid Pyth ${feed} price (confidence under 0.5%) at or above ${t} is published before ${d}, 00:00 UTC. Otherwise settles BELOW.`, settleRule: 'touch-up' };
}

interface Seed {
  asset: string;
  kind: 'close' | 'touch';
  dir: 'above' | 'below';
  target: number;
  hours: number;
  p: number;
  vol: number;
  liq: number;
  cat: string;
  featured?: boolean;
  stale?: boolean;
  status?: MockMarket['status'];
  outcome?: Side;
}

const SEEDS: Seed[] = [
  { asset: 'SOL', kind: 'close', dir: 'above', target: 250, hours: 29 * 24 + 6, p: 0.21, vol: 1284000, liq: 412000, cat: 'Majors', featured: true },
  { asset: 'JUP', kind: 'touch', dir: 'above', target: 1.2, hours: 13 * 24 + 2, p: 0.19, vol: 642000, liq: 188000, cat: 'Solana ecosystem' },
  { asset: 'BTC', kind: 'close', dir: 'above', target: 140000, hours: 59 * 24, p: 0.17, vol: 2210000, liq: 930000, cat: 'Majors' },
  { asset: 'ETH', kind: 'touch', dir: 'below', target: 3800, hours: 18 * 24 + 9, p: 0.64, vol: 880000, liq: 301000, cat: 'Majors' },
  { asset: 'PYTH', kind: 'close', dir: 'above', target: 0.6, hours: 36 * 24 + 4, p: 0.18, vol: 188000, liq: 64000, cat: 'Solana ecosystem' },
  { asset: 'JTO', kind: 'close', dir: 'above', target: 4, hours: 29 * 24 + 6, p: 0.15, vol: 214000, liq: 76000, cat: 'Solana ecosystem' },
  { asset: 'BONK', kind: 'touch', dir: 'above', target: 0.00004, hours: 23 * 24 + 15, p: 0.44, vol: 503000, liq: 142000, cat: 'Solana ecosystem', stale: true },
  { asset: 'SOL', kind: 'touch', dir: 'below', target: 180, hours: 7 * 24 + 20, p: 0.92, vol: 298000, liq: 98000, cat: 'Majors' },
  { asset: 'WIF', kind: 'close', dir: 'above', target: 3, hours: 16 * 24 + 12, p: 0.17, vol: 412000, liq: 133000, cat: 'Solana ecosystem' },
  { asset: 'BTC', kind: 'touch', dir: 'above', target: 125000, hours: 12, p: 0.03, vol: 1630000, liq: 540000, cat: 'Majors' },
  { asset: 'HNT', kind: 'touch', dir: 'below', target: 5, hours: 22 * 24 + 12, p: 0.69, vol: 128000, liq: 52000, cat: 'Solana ecosystem' },
  { asset: 'RAY', kind: 'close', dir: 'above', target: 6, hours: 30 * 24 + 12, p: 0.2, vol: 96000, liq: 41000, cat: 'Solana ecosystem' },
  { asset: 'SOL', kind: 'close', dir: 'above', target: 230, hours: 36, p: 0.06, vol: 734000, liq: 220000, cat: 'Majors' },
  // settled so the Redeem flow has something to redeem
  { asset: 'SOL', kind: 'close', dir: 'above', target: 200, hours: -30, p: 0.99, vol: 905000, liq: 300000, cat: 'Majors', status: 'settled', outcome: 'above' },
  { asset: 'ETH', kind: 'close', dir: 'above', target: 4400, hours: -52, p: 0.01, vol: 402000, liq: 150000, cat: 'Majors', status: 'settled', outcome: 'below' },
];

export function buildMarkets(wallets: MockWallet[], now: number): MockMarket[] {
  const r = mulberry32(551177);
  const out: MockMarket[] = [];
  SEEDS.forEach((s, mi) => {
    const settleTs = now + s.hours * HOUR;
    const id = fakeAddress(mulberry32(1000 + mi), 44);
    const series: number[] = [];
    let v = Math.min(0.97, Math.max(0.03, s.p + range(r, -0.16, 0.16)));
    const n = 14 * 96;
    for (let i = 0; i < n; i++) {
      v += gauss(r) * 0.006 + (s.p - v) * 0.004;
      v = Math.max(0.03, Math.min(0.97, v));
      series.push(v);
    }
    const d = s.p - series[n - 1]!;
    for (let i = 0; i < n; i++) series[i] = Math.max(0.01, Math.min(0.99, series[i]! + (d * i) / (n - 1)));
    const liq = BigInt(Math.round(s.liq)) * 1_000_000n;
    const pool = seedPool(liq, s.p);
    const m: MockMarket = {
      id,
      asset: s.asset,
      category: s.cat,
      kind: s.kind,
      dir: s.dir,
      target: s.target,
      createdAt: now - Math.round(range(r, 4, 24)) * DAY,
      settleTs,
      tradingEndsTs: settleTs - (s.kind === 'close' ? 30 * 60_000 : 0),
      status: s.status ?? 'open',
      outcome: s.outcome ?? null,
      pool,
      completeSets: liq,
      feeFeePool: BigInt(Math.round(s.vol * 0.004)) * 1_000_000n,
      baseFeeBps: [50, 100, 100, 200][mi % 4]!,
      dynamicFee: mi % 3 !== 1,
      volume: BigInt(s.vol) * 1_000_000n,
      traders: Math.round(s.vol / range(r, 900, 2400)),
      creator: fakeAddress(r),
      featured: s.featured,
      oracleStale: s.stale,
      series,
      members: [],
      flaggedAt: [],
      question: '',
    };
    m.question = makeQuestion(m);
    // members: smart wallets lean the way the market is priced, crowd is random
    const lean: Side = s.p >= 0.5 ? 'above' : 'below';
    for (const w of wallets) {
      const prob = w.smart ? 0.13 : 0.06;
      if (r() > prob) continue;
      const side: Side = w.smart ? (r() < 0.82 ? lean : lean === 'above' ? 'below' : 'above') : r() < 0.5 ? 'above' : 'below';
      const usdc = BigInt(Math.round(w.smart ? range(r, 4000, 120000) : range(r, 40, 3200))) * 1_000_000n;
      const ts = now - Math.round(range(r, 1, 80)) * HOUR;
      const idx = Math.max(0, n - 1 - Math.round(((now - ts) / (15 * 60_000))));
      const px = series[Math.min(n - 1, idx)]!;
      m.members.push({ wallet: w.idx, side, usdc, ts, entryPrice: side === 'above' ? px : 1 - px });
    }
    m.flaggedAt = m.members.filter((x) => wallets[x.wallet]!.smart).map((x) => x.ts).sort((a, b) => a - b);
    out.push(m);
  });
  return out;
}

export function radarFor(m: MockMarket, wallets: MockWallet[], price: number): RadarSummary {
  if (m.status !== 'open') return { state: 'building', p: null, ci: null, n: 0, edge: null, modelVersion: null, ts: null };
  const flagged = m.members.filter((x) => wallets[x.wallet]!.smart);
  const n = flagged.length;
  if (n < 3) return { state: 'building', p: null, ci: null, n, edge: null, modelVersion: MODEL_VERSION, ts: null };
  let up = 0;
  let tot = 0;
  for (const x of flagged) {
    const w = (Number(x.usdc) / 1e6) * (wallets[x.wallet]!.score / 100);
    tot += w;
    if (x.side === 'above') up += w;
  }
  const imb = tot ? (up / tot) * 2 - 1 : 0;
  const p = Math.min(0.97, Math.max(0.03, 0.5 + 0.43 * imb * Math.min(1, 0.5 + n / 12) + (price - 0.5) * 0.15));
  const ci = Math.max(3, Math.round(34 / Math.sqrt(n)));
  return { state: 'ready', p: Math.round(p * 1000) / 1000, ci, n, edge: Math.round(100 * (p - price)), modelVersion: MODEL_VERSION, ts: new Date().toISOString() };
}

export function marketWalletRows(m: MockMarket, wallets: MockWallet[]): MarketWalletRow[] {
  return m.members
    .map((x) => {
      const w = wallets[x.wallet]!;
      return { address: w.addr, score: w.score, smart: w.smart, top: w.top, side: x.side, entryPrice: x.entryPrice, usdc: x.usdc.toString(), features: w.features, sybil: w.sybil };
    })
    .sort((a, b) => b.score - a.score);
}

export function flaggedEntries(m: MockMarket, wallets: MockWallet[]): FlaggedEntry[] {
  return m.members
    .filter((x) => wallets[x.wallet]!.smart)
    .sort((a, b) => a.ts - b.ts)
    .slice(0, 12)
    .map((x) => ({ ts: new Date(x.ts).toISOString(), wallet: wallets[x.wallet]!.addr, side: x.side, priceAtEntry: x.entryPrice, usdc: x.usdc.toString(), score: wallets[x.wallet]!.score }));
}

export function seededTrades(m: MockMarket, wallets: MockWallet[], now: number): TradeRow[] {
  const r = mulberry32(hashStr(m.id));
  const rows: TradeRow[] = [];
  const members = m.members.length ? m.members : [];
  const sig = () => fakeAddress(r, 88);
  for (let i = 0; i < 70; i++) {
    const mem = members[Math.floor(r() * members.length)];
    const w = mem ? wallets[mem.wallet]! : wallets[Math.floor(r() * wallets.length)]!;
    const side: Side = mem && r() < 0.8 ? mem.side : r() < 0.5 ? 'above' : 'below';
    const dir = r() < 0.78 ? 'buy' : 'sell';
    const usdc = BigInt(Math.round(w.smart ? range(r, 800, 40000) : range(r, 5, 1500))) * 1_000_000n;
    const ts = now - Math.round(i * 31 * 60_000 * range(r, 0.6, 1.6));
    const pa = m.series[Math.max(0, m.series.length - 1 - Math.round((now - ts) / (15 * 60_000)))]!;
    const px = side === 'above' ? pa : 1 - pa;
    rows.push({
      id: `${m.id.slice(0, 6)}-${i}`,
      ts: new Date(ts).toISOString(),
      wallet: w.addr,
      side,
      dir,
      usdc: usdc.toString(),
      shares: BigInt(Math.round(Number(usdc) / Math.max(0.02, px))).toString(),
      feeUsdc: ((usdc * BigInt(m.baseFeeBps)) / 10000n).toString(),
      priceAfter: pa,
      txSig: sig(),
      flagged: w.smart,
    });
  }
  return rows;
}

export function walletDetail(w: MockWallet, clusterName: string, openPositions: WalletDetail['openPositions']): WalletDetail {
  return {
    address: w.addr,
    score: w.score,
    smart: w.smart,
    top: w.top,
    sybil: w.sybil,
    cluster: { id: w.cluster, name: clusterName },
    features: w.features,
    contributions: w.contributions,
    reasons: w.reasons,
    tags: w.tags,
    stats: w.stats,
    openPositions,
    asOf: new Date().toISOString(),
    modelVersion: MODEL_VERSION,
    labelHidden: w.labelHidden,
  };
}

export function trackRecord(now: number, building: boolean): TrackRecord {
  const start = new Date(now - 30 * DAY).toISOString();
  const end = new Date(now).toISOString();
  if (building) {
    return { window: { start, end }, runAt: end, dataSource: DATA_SOURCE, nMarkets: 0, brier: { radar: null, market: null }, hitRate: { radar: null, market: null }, medianLeadMin: null, edgeRealizedCents: null, calibration: [], leadHistogram: [], rows: [], modelVersion: MODEL_VERSION, state: 'building' };
  }
  const r = mulberry32(777);
  const calibration = Array.from({ length: 10 }, (_, i) => {
    const bin = i;
    const predicted = (i + 0.5) / 10;
    const n = Math.round(range(r, 6, 40));
    return { bin, predicted, observed: Math.min(1, Math.max(0, predicted + range(r, -0.07, 0.07))), n };
  });
  const leadHistogram = [0, 10, 20, 30, 40, 50, 60, 90].map((b) => ({ bucketMin: b, count: Math.max(1, Math.round(range(r, 2, 26) * (b > 60 ? 0.4 : 1))) }));
  const rows = Array.from({ length: 12 }, (_, i) => {
    const asset = ASSETS[i % ASSETS.length]!;
    const ts = now - (3 + i * 2) * DAY;
    const outcome: Side = r() < 0.45 ? 'above' : 'below';
    const target = +(asset.price * (outcome === 'above' ? range(r, 0.96, 1.0) : range(r, 1.02, 1.12))).toPrecision(3);
    const q = makeQuestion({ asset: asset.symbol, kind: 'close', dir: 'above', target, settleTs: ts });
    const truth = outcome === 'above' ? 1 : 0;
    const rad = Math.min(0.97, Math.max(0.03, (outcome === 'above' ? 0.62 : 0.34) + range(r, -0.2, 0.2)));
    const mkt = Math.min(0.97, Math.max(0.03, 0.5 + range(r, -0.3, 0.3)));
    const closer: 'radar' | 'market' | 'tie' = i === 4 ? 'tie' : Math.abs(truth - rad) < Math.abs(truth - mkt) ? 'radar' : 'market';
    return { marketId: fakeAddress(mulberry32(5000 + i)), question: q, radarT24: rad, marketT24: mkt, outcome, closer };
  });
  return { window: { start, end }, runAt: end, dataSource: DATA_SOURCE, nMarkets: 112, brier: { radar: 0.181, market: 0.204 }, hitRate: { radar: 0.64, market: 0.58 }, medianLeadMin: 34, edgeRealizedCents: 4, calibration, leadHistogram, rows, modelVersion: MODEL_VERSION, state: 'ready' };
}

export function nodesFor(wallets: MockWallet[]): GraphNode[] {
  return wallets.map((w) => ({ id: w.idx, addr: w.addr, score: w.score, smart: w.smart, top: w.top, cluster: w.cluster, pos: w.pos }));
}
