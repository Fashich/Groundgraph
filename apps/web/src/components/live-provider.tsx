'use client';

import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import type { MarketDetail, MarketSummary, Paged, RadarSummary, TradeRow, WsMarketDelta, OracleInfo } from '@groundgraph/sdk/api-types';
import { LiveSocket, type ChannelMsg } from '@/lib/ws';
import { resolveWsUrl } from '@/lib/env';
import { useNet, useUi } from '@/lib/stores';
import { qk, useSession } from '@/lib/queries';
import {
  applyMarketDelta,
  applyOracle,
  applyRadar,
  applySummaryToList,
  asSummaryPatches,
  isTradeRow,
  meInvalidations,
  oracleMatches,
  parseMeEvent,
  prependTrade,
} from '@/lib/live';

interface LiveApi {
  subscribe: (channel: string) => () => void;
  reconnect: () => void;
}

const LiveContext = createContext<LiveApi | null>(null);

/** Apply one server message to the query caches. Exported for tests. */
export function routeMessage(qc: QueryClient, m: ChannelMsg) {
  const [kind, ...rest] = m.ch.split(':');
  const id = rest.join(':');
  if (m.ch === 'markets:summary') {
    const patches = asSummaryPatches(m.data);
    qc.setQueriesData<InfiniteData<Paged<MarketSummary>>>({ queryKey: ['markets'] }, (old) => applySummaryToList(old, patches));
    // keep open market detail pages in step with list level fields
    for (const p of patches) {
      qc.setQueriesData<MarketDetail>({ queryKey: qk.marketAny(p.id) }, (d) => (d ? { ...d, ...pickSummary(p), radar: p.radar ? { ...d.radar, ...p.radar } : d.radar } : d));
    }
    return;
  }
  if (kind === 'market') {
    if (m.type === 'snapshot' && m.data && typeof m.data === 'object' && 'question' in (m.data as object)) {
      qc.setQueriesData<MarketDetail>({ queryKey: qk.marketAny(id) }, (d) => (d ? { ...d, ...(m.data as Partial<MarketDetail>) } : d));
      return;
    }
    const delta = m.data as Partial<WsMarketDelta>;
    qc.setQueriesData<MarketDetail>({ queryKey: qk.marketAny(id) }, (d) => applyMarketDelta(d, { ...delta, ts: m.ts }));
    if (delta?.trade && isTradeRow(delta.trade)) {
      const trade = delta.trade as TradeRow;
      qc.setQueryData<InfiniteData<Paged<TradeRow>>>(qk.trades(id), (old) => prependTrade(old, trade));
    }
    return;
  }
  if (kind === 'radar') {
    qc.setQueriesData<MarketDetail>({ queryKey: qk.marketAny(id) }, (d) => applyRadar(d, m.data as Partial<RadarSummary>));
    qc.setQueriesData<InfiniteData<Paged<MarketSummary>>>({ queryKey: ['markets'] }, (old) => applySummaryToList(old, [{ id, radar: m.data as RadarSummary }]));
    void qc.invalidateQueries({ queryKey: qk.wallets(id) });
    return;
  }
  if (kind === 'oracle') {
    const o = m.data as Partial<OracleInfo>;
    qc.setQueriesData<MarketDetail>({ queryKey: ['market'] }, (d) => (oracleMatches(d, id) ? applyOracle(d, o) : d));
    return;
  }
  if (kind === 'me') {
    const e = parseMeEvent(m.data);
    const what = meInvalidations(e);
    if (what.includes('account')) {
      void qc.invalidateQueries({ queryKey: ['positions'] });
      void qc.invalidateQueries({ queryKey: qk.activity });
      void qc.invalidateQueries({ queryKey: qk.me });
      void qc.invalidateQueries({ queryKey: ['balance'] });
    }
    if (what.includes('markets')) void qc.invalidateQueries({ queryKey: ['markets'] });
    if (e && what.includes('market')) {
      if (e.kind === 'settled') qc.setQueriesData<MarketDetail>({ queryKey: qk.marketAny(e.marketId) }, (d) => applyMarketDelta(d, { status: 'settled', outcome: e.outcome ?? null, ts: m.ts }));
      void qc.invalidateQueries({ queryKey: qk.marketAny(e.marketId) });
      useUi.getState().toast({
        tone: 'info',
        title: e.kind === 'settled' ? `A market you hold settled${e.outcome ? ` ${e.outcome.toUpperCase()}` : ''}` : 'A market you hold was voided',
        body: e.kind === 'settled' ? 'Open Positions to redeem what you are owed.' : 'Open Positions to redeem your USDC.',
      });
    }
  }
}

function pickSummary(p: Partial<MarketSummary>): Partial<MarketDetail> {
  const { id: _id, spark: _spark, ...rest } = p;
  void _id;
  void _spark;
  return rest as Partial<MarketDetail>;
}

function resync(qc: QueryClient, channels: string[]) {
  for (const ch of channels) {
    const [kind, ...rest] = ch.split(':');
    const id = rest.join(':');
    if (ch === 'markets:summary') void qc.invalidateQueries({ queryKey: ['markets'] });
    else if (kind === 'market') {
      void qc.invalidateQueries({ queryKey: qk.marketAny(id) });
      void qc.invalidateQueries({ queryKey: qk.trades(id) });
    } else if (kind === 'radar') {
      void qc.invalidateQueries({ queryKey: qk.marketAny(id) });
      void qc.invalidateQueries({ queryKey: qk.wallets(id) });
    } else if (kind === 'oracle') void qc.invalidateQueries({ queryKey: ['market'] });
    else if (kind === 'me') resync(qc, []);
  }
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const sockRef = useRef<LiveSocket | null>(null);

  const api = useMemo<LiveApi>(
    () => ({
      subscribe: (channel) => {
        if (typeof window === 'undefined') return () => undefined;
        if (!sockRef.current) {
          sockRef.current = new LiveSocket({
            url: resolveWsUrl,
            onMessage: (m) => routeMessage(qc, m),
            onState: (s) => useNet.getState().setWs(s),
            onLag: (ms) => useNet.getState().setLag(ms),
            onResync: (chs) => resync(qc, chs),
          });
        }
        return sockRef.current.subscribe(channel);
      },
      reconnect: () => sockRef.current?.reconnectNow(),
    }),
    [qc],
  );

  useEffect(() => () => sockRef.current?.close(), []);

  // The API reads the session cookie once, when the socket upgrades, and only then allows the `me` channel. After a
  // sign-in, sign-out or switch of wallet the open socket still carries the old identity, so open a fresh one.
  const { data: session, isPending } = useSession();
  const who = isPending ? undefined : session ? `${session.mode}:${session.wallet}` : null;
  const lastWho = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (who === undefined) return;
    const prev = lastWho.current;
    lastWho.current = who;
    if (prev !== undefined && prev !== who) sockRef.current?.reconnectNow();
  }, [who]);

  return <LiveContext.Provider value={api}>{children}</LiveContext.Provider>;
}

/** Subscribe to a live channel while mounted. Pass null to skip. */
export function useChannel(channel: string | null) {
  const live = useContext(LiveContext);
  useEffect(() => {
    if (!live || !channel) return;
    return live.subscribe(channel);
  }, [live, channel]);
}

export function useLiveControls() {
  const live = useContext(LiveContext);
  return { reconnect: () => live?.reconnect() };
}
