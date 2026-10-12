import type { InfiniteData } from '@tanstack/react-query';
import type { MarketDetail, MarketSummary, OracleInfo, Paged, RadarSummary, TradeRow, WsMarketDelta } from '@groundgraph/sdk/api-types';

/* Pure reducers that apply WebSocket payloads to TanStack Query caches. */

export type SummaryPatch = Partial<MarketSummary> & { id: string };

export function asSummaryPatches(data: unknown): SummaryPatch[] {
  // The API sends { markets: MarketSummary[] }; a bare array or a single patch is tolerated.
  const inner = data && typeof data === 'object' && Array.isArray((data as { markets?: unknown }).markets) ? (data as { markets: unknown[] }).markets : data;
  const list = Array.isArray(inner) ? inner : inner && typeof inner === 'object' ? [inner] : [];
  return list.filter((x): x is SummaryPatch => !!x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string');
}

export function patchSummary(item: MarketSummary, p: SummaryPatch): MarketSummary {
  const next: MarketSummary = { ...item, ...p, radar: p.radar ? { ...item.radar, ...p.radar } : item.radar };
  if (p.priceAbove !== undefined && p.implied === undefined) next.implied = p.priceAbove;
  return next;
}

/** markets:summary delta or snapshot applied to the cached (infinite) market list. Unknown ids are ignored. */
export function applySummaryToList(old: InfiniteData<Paged<MarketSummary>> | undefined, patches: SummaryPatch[]): InfiniteData<Paged<MarketSummary>> | undefined {
  if (!old || patches.length === 0) return old;
  const byId = new Map(patches.map((p) => [p.id, p]));
  let changed = false;
  const pages = old.pages.map((pg) => {
    const items = pg.items.map((it) => {
      const p = byId.get(it.id);
      if (!p) return it;
      changed = true;
      return patchSummary(it, p);
    });
    return { ...pg, items };
  });
  return changed ? { ...old, pages } : old;
}

/** market:{id} delta applied to the cached detail: price, reserves, fee. */
export function applyMarketDelta(d: MarketDetail | undefined, delta: Partial<WsMarketDelta> & { ts?: string; status?: MarketDetail['status']; outcome?: MarketDetail['outcome'] }): MarketDetail | undefined {
  if (!d) return d;
  const next: MarketDetail = { ...d, pool: { ...d.pool } };
  if (typeof delta.priceAbove === 'number') {
    next.priceAbove = delta.priceAbove;
    next.implied = delta.priceAbove;
    const pts = d.history.points;
    const ts = delta.ts ?? new Date().toISOString();
    const last = pts[pts.length - 1];
    if (!last || Date.parse(ts) > Date.parse(last.ts)) next.history = { ...d.history, points: [...pts, { ts, priceAbove: delta.priceAbove }].slice(-400) };
  }
  if (delta.reserveAbove !== undefined) next.pool.reserveAbove = delta.reserveAbove;
  if (delta.reserveBelow !== undefined) next.pool.reserveBelow = delta.reserveBelow;
  if (delta.status) next.status = delta.status;
  if (delta.outcome !== undefined) next.outcome = delta.outcome;
  if (typeof delta.feeBps === 'number') {
    next.feeBpsNow = delta.feeBps;
    next.feeBreakdown = { ...d.feeBreakdown, totalBps: delta.feeBps };
  }
  return next;
}

export function applyRadar(d: MarketDetail | undefined, radar: Partial<RadarSummary>): MarketDetail | undefined {
  if (!d) return d;
  return { ...d, radar: { ...d.radar, ...radar } };
}

export function applyOracle(d: MarketDetail | undefined, o: Partial<OracleInfo>): MarketDetail | undefined {
  if (!d) return d;
  return { ...d, oracle: { ...d.oracle, ...o } };
}

/** Prepend a new trade to the first page of the cached feed (deduplicated by id). */
export function prependTrade(old: InfiniteData<Paged<TradeRow>> | undefined, trade: TradeRow): InfiniteData<Paged<TradeRow>> | undefined {
  if (!old || old.pages.length === 0) return old;
  if (old.pages.some((p) => p.items.some((t) => t.id === trade.id))) return old;
  const [first, ...rest] = old.pages;
  return { ...old, pages: [{ ...first!, items: [trade, ...first!.items].slice(0, 200) }, ...rest] };
}

export function isTradeRow(x: unknown): x is TradeRow {
  const t = x as TradeRow | undefined;
  return !!t && typeof t.id === 'string' && typeof t.wallet === 'string' && typeof t.usdc === 'string';
}

/** The oracle channel is keyed by feed id; applies to every cached detail using that feed. */
export function oracleMatches(d: MarketDetail | undefined, feedId: string): boolean {
  const norm = (h: string) => h.replace(/^0x/i, '').toLowerCase();
  return !!d && norm(d.oracle.feedId) === norm(feedId);
}

/** Events on the `me` channel (the indexer publishes these for the signed-in wallet and for holders of a market). */
export type MeEvent =
  | { kind: 'fill'; marketId: string; txSig?: string; side?: 'above' | 'below'; dir?: 'buy' | 'sell'; usdc?: string; shares?: string; priceAfter?: number }
  | { kind: 'created'; marketId: string; txSig?: string }
  | { kind: 'redeemed'; marketId: string; txSig?: string; side?: 'above' | 'below'; shares?: string; usdc?: string }
  | { kind: 'merged'; marketId: string; txSig?: string; amount?: string }
  | { kind: 'liquidity'; marketId: string; txSig?: string; isAdd?: boolean; lpAmount?: string; usdc?: string }
  | { kind: 'settled'; marketId: string; outcome?: 'above' | 'below' }
  | { kind: 'voided'; marketId: string };

const ME_KINDS = new Set(['fill', 'created', 'redeemed', 'merged', 'liquidity', 'settled', 'voided']);

/** Narrow an unknown `me` payload. Unknown kinds are ignored so a newer server never breaks the page. */
export function parseMeEvent(data: unknown): MeEvent | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (typeof d.kind !== 'string' || !ME_KINDS.has(d.kind)) return null;
  if (typeof d.marketId !== 'string' || d.marketId === '') return null;
  return d as unknown as MeEvent;
}

/**
 * What a `me` event invalidates. Account data always refetches. A new market refreshes the lists; a settled or voided
 * market also refreshes its detail page and the lists, since the status moved.
 */
export function meInvalidations(e: MeEvent | null): ('account' | 'markets' | 'market')[] {
  if (!e) return ['account'];
  switch (e.kind) {
    case 'created':
      return ['account', 'markets'];
    case 'settled':
    case 'voided':
      return ['account', 'markets', 'market'];
    default:
      return ['account'];
  }
}
