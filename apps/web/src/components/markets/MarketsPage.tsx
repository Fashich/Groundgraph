'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Button, MarketCardSkeleton } from '@groundgraph/ui';
import { ErrorState } from '@/components/common/states';
import { useChannel } from '@/components/live-provider';
import { DEFAULT_FILTERS, useMarkets, useSpotlight, useWatched, type MarketFilters as Filters } from '@/lib/queries';
import { useDebounced, useIsMobile, useNow } from '@/lib/hooks';
import { MarketCard } from './MarketCard';
import { MarketTable } from './MarketTable';
import { FilterSheet, MarketFilters, activeFilterCount } from './MarketFilters';
import { SignalSpotlight } from './SignalSpotlight';
import { useWatch } from './useWatch';

const KEYS: (keyof Filters)[] = ['cat', 'lean', 'ends', 'sort', 'q', 'watch'];

function readUrl(): { f: Filters; view: 'grid' | 'list' } {
  const p = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
  const f: Filters = { ...DEFAULT_FILTERS };
  const cat = p.get('cat');
  if (cat) f.cat = cat;
  if (['above', 'below'].includes(p.get('lean') ?? '')) f.lean = p.get('lean') as Filters['lean'];
  if (['48h', '2w', 'long'].includes(p.get('ends') ?? '')) f.ends = p.get('ends') as Filters['ends'];
  if (['signal', 'gap', 'ending', 'volume'].includes(p.get('sort') ?? '')) f.sort = p.get('sort') as Filters['sort'];
  f.q = p.get('q') ?? '';
  f.watch = p.get('watch') === '1';
  return { f, view: p.get('view') === 'list' ? 'list' : 'grid' };
}

export function MarketsPage() {
  const [init] = useState(readUrl);
  const [f, setF] = useState<Filters>(init.f);
  const [view, setView] = useState<'grid' | 'list'>(init.view);
  const [sheet, setSheet] = useState(false);
  const mobile = useIsMobile();
  const now = useNow(15_000);
  const dq = useDebounced(f.q, 250);
  const applied = useMemo(() => ({ ...f, q: dq }), [f, dq]);
  const q = useMarkets(applied);
  const spotlight = useSpotlight();
  const watched = useWatched();
  const { toggle } = useWatch();
  useChannel('markets:summary');

  useEffect(() => {
    const p = new URLSearchParams();
    for (const k of KEYS) {
      const v = f[k];
      if (v !== DEFAULT_FILTERS[k] && v !== '') p.set(k, v === true ? '1' : String(v));
    }
    if (view === 'list') p.set('view', 'list');
    const s = p.toString();
    window.history.replaceState(null, '', s ? `?${s}` : window.location.pathname);
  }, [f, view]);

  const set = (patch: Partial<Filters>) => setF((cur) => ({ ...cur, ...patch }));
  const reset = () => setF({ ...DEFAULT_FILTERS });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  // a market that settles while the page is open stays on the card (as Settled) until the next refetch, but is no longer "live"
  const counted = f.status === 'open' ? items.filter((m) => m.status === 'open' || m.status === 'trading_closed') : items;
  const flagged = counted.reduce((a, m) => a + (m.radar.n || 0), 0);
  const nFilt = activeFilterCount(f);
  const loading = q.isPending;

  return (
    <div data-component="MarketsPage" className="gg-page animate-gg-in">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div className="flex flex-col gap-2.5">
          <h1 className="font-display text-[clamp(32px,4vw,48px)] font-semibold leading-none tracking-[-0.03em]">Markets</h1>
          <span className="flex items-center gap-2 text-sm text-dim">
            <span aria-hidden className="gg-dot" />
            {loading ? 'Loading markets' : `${counted.length} ${f.status === 'open' ? 'live' : ''} markets · ${flagged} flagged wallet positions · prices update live`}
          </span>
        </div>
        <Link href="/create" className="gg-btn gg-btn-primary h-11 px-5 text-sm text-white hover:text-white">
          + Create market
        </Link>
      </div>

      {spotlight.data ? <SignalSpotlight m={spotlight.data} /> : null}

      <MarketFilters f={f} set={set} view={view} setView={setView} mobile={mobile} onOpenSheet={() => setSheet(true)} watchCount={watched.data?.size ?? 0} />
      {nFilt > 0 && !loading ? (
        <div className="mt-3 flex items-center gap-3 text-[13px] text-dim" aria-live="polite">
          {items.length} result{items.length === 1 ? '' : 's'}
          <button type="button" onClick={reset} className="text-violet-light hover:text-above">
            Clear filters
          </button>
        </div>
      ) : null}

      {q.isError ? (
        <ErrorState className="mt-5" title="Could not load markets" message={(q.error as Error).message} onRetry={() => void q.refetch()} />
      ) : loading ? (
        <div className="mt-5 grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-4">
          {Array.from({ length: 6 }, (_, i) => (
            <MarketCardSkeleton key={i} delay={`${i * 0.08}s`} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div data-component="EmptyState" className="mt-5 rounded-[20px] border border-dashed border-violet/20 px-6 py-16 text-center text-dim">
          No markets match these filters.{' '}
          <button type="button" onClick={reset} className="text-violet-light hover:text-above">
            Clear filters
          </button>{' '}
          or{' '}
          <Link href="/create" className="text-violet-light hover:text-above">
            create one
          </Link>
          .
        </div>
      ) : view === 'grid' || mobile ? (
        <div className="mt-5 grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-4">
          {items.map((m) => (
            <MarketCard key={m.id} m={m} now={now} watched={watched.data?.has(m.id) ?? false} onWatch={() => void toggle(m.id)} />
          ))}
        </div>
      ) : (
        <MarketTable items={items} now={now} />
      )}

      {q.hasNextPage ? (
        <div className="mt-8 flex justify-center">
          <Button variant="quiet" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
            {q.isFetchingNextPage ? 'Loading' : 'Load more markets'}
          </Button>
        </div>
      ) : null}

      <FilterSheet open={sheet && mobile} onClose={() => setSheet(false)} f={f} set={set} count={items.length} />
    </div>
  );
}
