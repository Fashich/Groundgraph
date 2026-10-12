import type { FlaggedEntry, MarketDetail, MarketWalletRow, OracleInfo, Side } from '@groundgraph/sdk/api-types';
import { clamp, fromBase, spotFmt } from './format';

/** Display scale for the lead time bar: a wallet that leads the market by this many minutes fills the bar. */
export const LEAD_FULL_MIN = 90;
export const leadFill = (min: number) => clamp(min / LEAD_FULL_MIN, 0, 1);

export interface Lean {
  aboveUsdc: number;
  belowUsdc: number;
  total: number;
  abovePct: number;
  belowPct: number;
  n: number;
}

/** Positioned volume of flagged (smart) wallets, split by side. Computed from GET /markets/:id/wallets. */
export function flaggedLean(rows: MarketWalletRow[] | undefined): Lean | null {
  if (!rows) return null;
  const smart = rows.filter((r) => r.smart && !r.sybil);
  if (smart.length === 0) return null;
  let a = 0;
  let b = 0;
  for (const r of smart) {
    const v = fromBase(r.usdc);
    if (r.side === 'above') a += v;
    else b += v;
  }
  const total = a + b;
  if (total <= 0) return null;
  return { aboveUsdc: a, belowUsdc: b, total, abovePct: Math.round((a / total) * 100), belowPct: 100 - Math.round((a / total) * 100), n: smart.length };
}

/** Median of the flagged wallets' historical lead time in minutes, or null when there are none. */
export function medianLead(rows: MarketWalletRow[] | undefined): number | null {
  const v = (rows ?? []).filter((r) => r.smart && r.features.leadTimeMin > 0).map((r) => r.features.leadTimeMin).sort((x, y) => x - y);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return Math.round(v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2);
}

export const sortWallets = (rows: MarketWalletRow[]) => [...rows].sort((a, b) => b.score - a.score);

/* ------------------------------ chart geometry ------------------------------ */

export const CHART_W = 800;
export const CHART_H = 240;

export interface ChartMark {
  entry: FlaggedEntry;
  xPct: number;
  yPct: number;
}
export interface ChartGeom {
  line: string;
  area: string;
  grid: { label: string; yPct: number }[];
  lastYPct: number;
  fairYPct: number | null;
  marks: ChartMark[];
  xOf: (t: number) => number;
  yOf: (p: number) => number;
  t0: number;
  t1: number;
  lo: number;
  hi: number;
}

type Pt = { ts: string; priceAbove: number };

/** Build the SVG paths and overlay positions for the price chart. Prices are 0..1, positions are fractions of the plot. */
export function chartGeometry(points: Pt[], fair: number | null, flagged: FlaggedEntry[], maxMarks = 12): ChartGeom | null {
  const pts = points
    .map((p) => ({ t: new Date(p.ts).getTime(), p: p.priceAbove }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.p))
    .sort((a, b) => a.t - b.t);
  if (pts.length < 2) return null;
  const t0 = pts[0]!.t;
  const t1 = pts[pts.length - 1]!.t;
  const span = Math.max(1, t1 - t0);
  const vals = pts.map((p) => p.p);
  if (fair != null) vals.push(fair);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const pad = Math.max(0.02, (hi - lo) * 0.12);
  lo = clamp(lo - pad, 0, 1);
  hi = clamp(hi + pad, 0, 1);
  if (hi - lo < 0.06) {
    const mid = (hi + lo) / 2;
    lo = clamp(mid - 0.03, 0, 1);
    hi = clamp(mid + 0.03, 0, 1);
  }
  const xf = (t: number) => clamp((t - t0) / span, 0, 1);
  const yf = (p: number) => 1 - clamp((p - lo) / (hi - lo), 0, 1);
  const xOf = (t: number) => xf(t) * CHART_W;
  const yOf = (p: number) => yf(p) * CHART_H;
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${xOf(p.t).toFixed(1)} ${yOf(p.p).toFixed(1)}`).join(' ');
  const area = `${line} L${CHART_W} ${CHART_H} L0 ${CHART_H} Z`;
  const grid = [0, 1, 2, 3].map((i) => {
    const p = hi - ((hi - lo) * i) / 3;
    return { label: `${Math.round(p * 100)}¢`, yPct: (i / 3) * 100 };
  });
  const priceAt = (t: number) => {
    let best = pts[0]!;
    for (const p of pts) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    return best.p;
  };
  const marks = [...flagged]
    .filter((f) => {
      const t = new Date(f.ts).getTime();
      return t >= t0 && t <= t1;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxMarks)
    .map((entry) => {
      const t = new Date(entry.ts).getTime();
      return { entry, xPct: xf(t) * 100, yPct: yf(priceAt(t)) * 100 };
    });
  return { line, area, grid, lastYPct: yf(pts[pts.length - 1]!.p) * 100, fairYPct: fair != null ? yf(fair) * 100 : null, marks, xOf, yOf, t0, t1, lo, hi };
}

/** Nearest point to a horizontal fraction of the plot, for the crosshair. */
export function pointAtFraction(points: Pt[], frac: number): { ts: string; priceAbove: number; xPct: number; yPct: number; geom: ChartGeom } | null {
  const g = chartGeometry(points, null, []);
  if (!g) return null;
  const t = g.t0 + clamp(frac, 0, 1) * (g.t1 - g.t0);
  let best = points[0]!;
  let bd = Infinity;
  for (const p of points) {
    const d = Math.abs(new Date(p.ts).getTime() - t);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  const xPct = ((new Date(best.ts).getTime() - g.t0) / Math.max(1, g.t1 - g.t0)) * 100;
  const yPct = (1 - (best.priceAbove - g.lo) / (g.hi - g.lo)) * 100;
  return { ...best, xPct, yPct, geom: g };
}

/* ------------------------------ oracle ------------------------------ */

export interface OracleView {
  label: string;
  title: string;
  tone: 'ok' | 'stale' | 'unknown';
}

export function oracleView(o: OracleInfo): OracleView {
  const sym = o.symbol.replace('/USD', '');
  if (o.price == null) return { label: `${o.symbol} price unavailable`, title: 'The oracle has not published a price for this feed yet.', tone: 'unknown' };
  const conf = o.conf != null && o.price > 0 ? ` ±${((o.conf / o.price) * 100).toFixed(2)}%` : '';
  const age = o.ageSec != null ? ` · ${o.ageSec < 10 ? o.ageSec.toFixed(1) : Math.round(o.ageSec)}s` : '';
  if (o.stale) return { label: `${sym} oracle stale · ${spotFmt(o.price)}${age}`, title: 'The price is older than 60 seconds. Buys are paused, selling and merging still work.', tone: 'stale' };
  return { label: `Pyth ${spotFmt(o.price)}${conf}${age}`, title: 'Oracle price used to settle this market. Buys pause when it is older than 60 seconds.', tone: 'ok' };
}

/* ------------------------------ fee bar ------------------------------ */

export function feeSegments(f: MarketDetail['feeBreakdown']): { key: 'base' | 'near' | 'flow'; label: string; bps: number; pct: number; color: string }[] {
  const total = Math.max(1, f.baseBps + f.nearBps + f.flowBps);
  return [
    { key: 'base' as const, label: 'Base', bps: f.baseBps, color: '#9B6BFF' },
    { key: 'near' as const, label: 'Near resolution', bps: f.nearBps, color: '#5FA8F0' },
    { key: 'flow' as const, label: 'Recent flow', bps: f.flowBps, color: '#E046F0' },
  ].map((s) => ({ ...s, pct: (s.bps / total) * 100 }));
}

export const bpsPct = (bps: number) => `${(bps / 100).toFixed(2)}%`;

/* ------------------------------ trade helpers ------------------------------ */

export type TradeTab = 'buy' | 'sell' | 'merge';
export const SLIPPAGE_OPTIONS = [50, 100, 200] as const;
export const MIN_TRADE_USDC = 1;

/** Parse a user-typed decimal. Returns null for empty or invalid input. */
export function parseAmount(s: string): number | null {
  const t = s.trim().replace(/,/g, '');
  if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Whether the buy size is large against the wallet's USDC. Used for the risk note. */
export function largeVsBalance(amountUsdc: number, balanceUsdc: number | null, threshold = 0.25): number | null {
  if (balanceUsdc == null || balanceUsdc <= 0 || amountUsdc <= 0) return null;
  const share = amountUsdc / balanceUsdc;
  return share > threshold ? Math.round(share * 100) : null;
}

/** Whether the radar favors ABOVE (edge > 0), BELOW (edge < 0) or neither. */
export function radarFavors(edge: number | null): Side | null {
  if (edge == null || edge === 0) return null;
  return edge > 0 ? 'above' : 'below';
}

export const marketUrl = (origin: string, id: string) => `${origin}/markets/${id}`;
/** Blink: a Solana Action URL wrapped by dial.to so any Blink-aware client renders buttons. */
export function blinkUrl(origin: string, id: string): string {
  return `https://dial.to/?action=solana-action:${origin}/api/actions/m/${id}`;
}
