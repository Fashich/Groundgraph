import { describe, expect, it } from 'vitest';
import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import type { MarketDetail, MarketSummary, Paged, TradeRow } from '@groundgraph/sdk/api-types';
import { applyMarketDelta, applyOracle, applyRadar, applySummaryToList, asSummaryPatches, isTradeRow, meInvalidations, oracleMatches, parseMeEvent, patchSummary, prependTrade } from '@/lib/live';
import { routeMessage } from '@/components/live-provider';
import { qk } from '@/lib/queries';
import { detail, summary } from './helpers';

const list = (items: MarketSummary[]): InfiniteData<Paged<MarketSummary>> => ({ pages: [{ items, nextCursor: null }], pageParams: [null] });

describe('markets:summary', () => {
  it('reads the { markets: [...] } envelope the API sends, and tolerates a bare array or object', () => {
    expect(asSummaryPatches({ markets: [{ id: 'a' }, { id: 'b' }] })).toHaveLength(2);
    expect(asSummaryPatches([{ id: 'a' }])).toHaveLength(1);
    expect(asSummaryPatches({ id: 'a', priceAbove: 0.4 })).toHaveLength(1);
    expect(asSummaryPatches(null)).toEqual([]);
    expect(asSummaryPatches({ markets: [{ nope: 1 }, 7, null] })).toEqual([]);
  });

  it('patches price, keeps implied equal to the price, merges radar fields', () => {
    const base = summary({ id: 'a' });
    const next = patchSummary(base, { id: 'a', priceAbove: 0.61, radar: { ...base.radar, edge: 9 } });
    expect(next.priceAbove).toBe(0.61);
    expect(next.implied).toBe(0.61);
    expect(next.radar.edge).toBe(9);
    expect(next.radar.n).toBe(base.radar.n);
  });

  it('updates matching rows, ignores unknown ids, and returns the same object when nothing changed', () => {
    const old = list([summary({ id: 'a' }), summary({ id: 'b' })]);
    const next = applySummaryToList(old, [{ id: 'b', volume: '5' }, { id: 'zzz', volume: '9' }]);
    expect(next!.pages[0]!.items.map((m) => m.volume)).toEqual([old.pages[0]!.items[0]!.volume, '5']);
    expect(applySummaryToList(old, [{ id: 'zzz' }])).toBe(old);
    expect(applySummaryToList(undefined, [{ id: 'a' }])).toBeUndefined();
  });
});

describe('market:{id} deltas', () => {
  it('moves price, reserves and fee, and extends the chart', () => {
    const d = detail();
    const next = applyMarketDelta(d, { priceAbove: 0.6, reserveAbove: '1', reserveBelow: '2', feeBps: 150, ts: '2026-10-12T13:00:00.000Z' })!;
    expect(next.priceAbove).toBe(0.6);
    expect(next.pool.reserveAbove).toBe('1');
    expect(next.feeBpsNow).toBe(150);
    expect(next.feeBreakdown.totalBps).toBe(150);
    expect(next.history.points.at(-1)).toEqual({ ts: '2026-10-12T13:00:00.000Z', priceAbove: 0.6 });
    expect(d.pool.reserveAbove).not.toBe('1'); // input untouched
  });
  it('does not append a point older than the last one', () => {
    const d = detail();
    const next = applyMarketDelta(d, { priceAbove: 0.3, ts: '2020-01-01T00:00:00.000Z' })!;
    expect(next.history.points).toHaveLength(d.history.points.length);
    expect(next.priceAbove).toBe(0.3);
  });
  it('applies status and outcome when a market settles or is voided', () => {
    const settled = applyMarketDelta(detail(), { status: 'settled', outcome: 'above', priceAbove: 1 })!;
    expect(settled.status).toBe('settled');
    expect(settled.outcome).toBe('above');
    const voided = applyMarketDelta(detail(), { status: 'voided', outcome: null })!;
    expect(voided.status).toBe('voided');
    expect(voided.outcome).toBeNull();
  });
  it('is a no-op without a cached market', () => {
    expect(applyMarketDelta(undefined, { priceAbove: 0.5 })).toBeUndefined();
  });
});

describe('radar and oracle deltas', () => {
  it('merges radar fields', () => {
    expect(applyRadar(detail(), { edge: -4 })!.radar.edge).toBe(-4);
  });
  it('an oracle delta is the full OracleInfo shape', () => {
    const next = applyOracle(detail(), { feedId: 'f', symbol: 'SOL/USD', price: 210, conf: 0.1, publishTs: '2026-10-12T12:00:05.000Z', ageSec: 1, stale: false })!;
    expect(next.oracle.price).toBe(210);
    expect(next.oracle.stale).toBe(false);
  });
  it('matches feeds with or without the 0x prefix, ignoring case', () => {
    const d = detail();
    const f = d.oracle.feedId;
    expect(oracleMatches(d, f)).toBe(true);
    expect(oracleMatches(d, `0x${f.toUpperCase()}`)).toBe(true);
    expect(oracleMatches(d, 'deadbeef')).toBe(false);
  });
});

describe('trades', () => {
  const trade: TradeRow = { id: 't1', ts: '2026-10-12T12:00:00.000Z', wallet: 'W', side: 'above', dir: 'buy', usdc: '1', shares: '2', feeUsdc: '0', priceAfter: 0.5, txSig: 's', flagged: false };
  const feed = (items: TradeRow[]): InfiniteData<Paged<TradeRow>> => ({ pages: [{ items, nextCursor: null }], pageParams: [null] });
  it('prepends once and ignores duplicates', () => {
    const a = prependTrade(feed([]), trade)!;
    expect(a.pages[0]!.items).toHaveLength(1);
    expect(prependTrade(a, trade)).toBe(a);
    expect(prependTrade(undefined, trade)).toBeUndefined();
  });
  it('recognises trade rows', () => {
    expect(isTradeRow(trade)).toBe(true);
    expect(isTradeRow({ id: 1 })).toBe(false);
    expect(isTradeRow(null)).toBe(false);
  });
});

describe('me channel', () => {
  it('accepts the seven kinds the indexer publishes and ignores the rest', () => {
    for (const kind of ['fill', 'created', 'redeemed', 'merged', 'liquidity', 'settled', 'voided']) expect(parseMeEvent({ kind, marketId: 'm' })?.kind).toBe(kind);
    expect(parseMeEvent({ kind: 'balance', marketId: 'm' })).toBeNull();
    expect(parseMeEvent({ kind: 'fill' })).toBeNull();
    expect(parseMeEvent({})).toBeNull();
    expect(parseMeEvent('x')).toBeNull();
  });
  it('decides what to refresh', () => {
    expect(meInvalidations(null)).toEqual(['account']);
    expect(meInvalidations({ kind: 'fill', marketId: 'm' })).toEqual(['account']);
    expect(meInvalidations({ kind: 'created', marketId: 'm' })).toContain('markets');
    expect(meInvalidations({ kind: 'settled', marketId: 'm' })).toEqual(['account', 'markets', 'market']);
    expect(meInvalidations({ kind: 'voided', marketId: 'm' })).toContain('market');
  });
});

describe('routeMessage applies server messages to the query cache', () => {
  const msg = (ch: string, data: unknown, seq = 1, type: 'snapshot' | 'delta' = 'delta') => ({ ch, type, seq, ts: '2026-10-12T13:00:00.000Z', data });

  it('markets:summary updates the list and open detail pages', () => {
    const qc = new QueryClient();
    const id = 'MKT1111111111111111111111111111111111111111';
    qc.setQueryData(['markets', { sort: 'signal' }], list([summary({ id })]));
    qc.setQueryData(qk.market(id, '1D'), detail({ id }));
    routeMessage(qc, msg('markets:summary', { markets: [{ id, priceAbove: 0.7, volume: '99' }] }));
    const l = qc.getQueryData<InfiniteData<Paged<MarketSummary>>>(['markets', { sort: 'signal' }])!;
    expect(l.pages[0]!.items[0]!.priceAbove).toBe(0.7);
    const d = qc.getQueryData<MarketDetail>(qk.market(id, '1D'))!;
    expect(d.priceAbove).toBe(0.7);
    expect(d.volume).toBe('99');
  });

  it('market delta with settle info flips status and outcome', () => {
    const qc = new QueryClient();
    const id = 'MKT1111111111111111111111111111111111111111';
    qc.setQueryData(qk.market(id, '1D'), detail({ id }));
    routeMessage(qc, msg(`market:${id}`, { priceAbove: 1, reserveAbove: '1', reserveBelow: '1', feeBps: 100, status: 'settled', outcome: 'above' }));
    const d = qc.getQueryData<MarketDetail>(qk.market(id, '1D'))!;
    expect(d.status).toBe('settled');
    expect(d.outcome).toBe('above');
  });

  it('oracle delta reaches every cached market on that feed', () => {
    const qc = new QueryClient();
    const d = detail();
    qc.setQueryData(qk.market('MKT1111111111111111111111111111111111111111', '1D'), d);
    routeMessage(qc, msg(`oracle:${d.oracle.feedId}`, { ...d.oracle, price: 333 }));
    expect(qc.getQueryData<MarketDetail>(qk.market('MKT1111111111111111111111111111111111111111', '1D'))!.oracle.price).toBe(333);
  });

  it('a me fill refreshes account queries; created also refreshes markets', () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.positions('open'), []);
    qc.setQueryData(['markets', 'x'], list([]));
    routeMessage(qc, msg('me', { kind: 'fill', marketId: 'm' }));
    expect(qc.getQueryState(qk.positions('open'))!.isInvalidated).toBe(true);
    expect(qc.getQueryState(['markets', 'x'])!.isInvalidated).toBe(false);
    routeMessage(qc, msg('me', { kind: 'created', marketId: 'm' }));
    expect(qc.getQueryState(['markets', 'x'])!.isInvalidated).toBe(true);
  });
});
