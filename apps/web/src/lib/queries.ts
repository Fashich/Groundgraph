'use client';

import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Quote, Side, TradeDir } from '@groundgraph/sdk/api-types';
import { api, isApiError } from './api';

export const qk = {
  session: ['session'] as const,
  me: ['me'] as const,
  markets: (f: MarketFilters) => ['markets', f] as const,
  market: (id: string, tf: string) => ['market', id, tf] as const,
  marketAny: (id: string) => ['market', id] as const,
  wallets: (id: string) => ['marketWallets', id] as const,
  trades: (id: string) => ['trades', id] as const,
  assets: ['assets'] as const,
  radar: ['radar'] as const,
  wallet: (a: string) => ['wallet', a] as const,
  track: ['trackRecord'] as const,
  positions: (t: string) => ['positions', t] as const,
  activity: ['activity'] as const,
  balance: (w: string) => ['balance', w] as const,
  fair: (k: string) => ['fair', k] as const,
};

export interface MarketFilters {
  cat: string;
  lean: 'any' | 'above' | 'below';
  ends: 'any' | '48h' | '2w' | 'long';
  sort: 'signal' | 'gap' | 'ending' | 'volume';
  q: string;
  watch: boolean;
  status: 'open' | 'all';
}

export const DEFAULT_FILTERS: MarketFilters = { cat: 'All', lean: 'any', ends: 'any', sort: 'signal', q: '', watch: false, status: 'open' };

export interface RadarFilters {
  minScore: number;
  cluster: string;
  crowd: boolean;
}

export const DEFAULT_RADAR: RadarFilters = { minScore: 50, cluster: 'all', crowd: true };

export function useSession() {
  return useQuery({
    queryKey: qk.session,
    queryFn: () => api.session(),
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: true,
  });
}

export function useMe(enabled = true) {
  return useQuery({ queryKey: qk.me, queryFn: () => api.me(), enabled, retry: false, staleTime: 15_000 });
}

export function useMarkets(f: MarketFilters, enabled = true) {
  return useInfiniteQuery({
    queryKey: qk.markets(f),
    enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.markets({
        cat: f.cat === 'All' ? undefined : f.cat,
        lean: f.lean === 'any' ? undefined : f.lean,
        ends: f.ends === 'any' ? undefined : f.ends,
        sort: f.sort,
        q: f.q.trim() || undefined,
        watch: f.watch ? true : undefined,
        status: f.status === 'open' ? 'open' : undefined,
        limit: 24,
        cursor: pageParam,
      }),
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
}

export function useMarket(id: string, tf: '1D' | '3D' | '1W' | 'ALL') {
  return useQuery({ queryKey: qk.market(id, tf), queryFn: () => api.market(id, tf), placeholderData: keepPreviousData, staleTime: 8_000, retry: (n, e) => !(isApiError(e) && e.status === 404) && n < 2 });
}

export function useMarketWallets(id: string, enabled = true) {
  return useQuery({ queryKey: qk.wallets(id), queryFn: () => api.marketWallets(id), enabled, staleTime: 30_000 });
}

export function useTrades(id: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: qk.trades(id),
    enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.marketTrades(id, pageParam, 30),
    getNextPageParam: (l) => l.nextCursor,
    staleTime: 15_000,
  });
}

export function useAssets() {
  return useQuery({ queryKey: qk.assets, queryFn: () => api.assets(), staleTime: 20_000, refetchInterval: 30_000 });
}

/** The full graph is fetched once. Score, cluster and crowd filters are applied client side so they respond instantly. */
export function useRadar() {
  return useQuery({ queryKey: qk.radar, queryFn: () => api.radar(), staleTime: 60_000 });
}

export function useWalletDetail(addr: string | null) {
  return useQuery({ queryKey: qk.wallet(addr ?? ''), queryFn: () => api.wallet(addr as string), enabled: !!addr, staleTime: 60_000, retry: (n, e) => !(isApiError(e) && e.status === 404) && n < 2 });
}

export function useTrackRecord() {
  return useQuery({ queryKey: qk.track, queryFn: () => api.trackRecord(), staleTime: 5 * 60_000 });
}

export function usePositions(tab: 'open' | 'redeem' | 'resolved', enabled = true) {
  return useQuery({ queryKey: qk.positions(tab), queryFn: () => api.positions(tab), enabled, staleTime: 10_000 });
}

export function useActivity(enabled = true) {
  return useInfiniteQuery({ queryKey: qk.activity, enabled, initialPageParam: null as string | null, queryFn: ({ pageParam }) => api.activity(pageParam), getNextPageParam: (l) => l.nextCursor, staleTime: 15_000 });
}

export function useFairValue(p: { asset: string; target: number; settleTs: string; kind: string; direction?: string } | null) {
  return useQuery({
    queryKey: qk.fair(p ? JSON.stringify(p) : 'none'),
    queryFn: () => api.fairValue(p!),
    enabled: !!p && p.target > 0,
    staleTime: 20_000,
    placeholderData: keepPreviousData,
    retry: 1,
  });
}

export interface QuoteParams {
  marketId: string;
  side: Side;
  dir: TradeDir;
  amount: string | null;
  slippageBps: number;
}

export function useQuote(p: QuoteParams, enabled: boolean) {
  return useQuery<Quote>({
    queryKey: ['quote', p.marketId, p.side, p.dir, p.amount, p.slippageBps],
    queryFn: ({ signal }) => api.quote(p.marketId, { side: p.side, dir: p.dir, amount: p.amount as string, slippageBps: p.slippageBps }, signal),
    enabled: enabled && !!p.amount && p.amount !== '0',
    staleTime: 4_000,
    placeholderData: keepPreviousData,
    retry: false,
    refetchInterval: 8_000,
  });
}

/** Refetch everything that a settled transaction can change. */
export function useRefreshAccount() {
  const qc = useQueryClient();
  return (marketId?: string) => {
    void qc.invalidateQueries({ queryKey: ['positions'] });
    void qc.invalidateQueries({ queryKey: qk.activity });
    void qc.invalidateQueries({ queryKey: qk.me });
    void qc.invalidateQueries({ queryKey: ['balance'] });
    if (marketId) {
      void qc.invalidateQueries({ queryKey: qk.marketAny(marketId) });
      void qc.invalidateQueries({ queryKey: qk.trades(marketId) });
    }
    void qc.invalidateQueries({ queryKey: ['markets'] });
  };
}

/** Ids of watched markets. The market list itself carries no watch flag, so this reads GET /markets?watch=true. */
export function useWatched(enabled = true) {
  return useQuery({
    queryKey: ['watched'],
    enabled,
    staleTime: 30_000,
    queryFn: async () => new Set((await api.markets({ watch: true, limit: 100 })).items.map((m) => m.id)),
  });
}

export function useSpotlight() {
  return useQuery({
    queryKey: ['spotlight'],
    staleTime: 30_000,
    queryFn: async () => {
      const page = await api.markets({ sort: 'gap', status: 'open', limit: 8 });
      return page.items.find((m) => m.radar.state === 'ready' && m.radar.edge != null) ?? null;
    },
  });
}
