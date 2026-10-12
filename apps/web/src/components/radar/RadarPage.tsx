'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { GraphNode, GraphPayload } from '@groundgraph/sdk/api-types';
import { DemoDataLabel, Segmented, Switch, cn, scoreColor } from '@groundgraph/ui';
import { useChannel } from '@/components/live-provider';
import { WalletGraph } from '@/components/graph/WalletGraph';
import { WalletDetailBody } from '@/components/market/WalletDetailPanel';
import { EmptyState, ErrorState, Skeleton } from '@/components/common/states';
import { shortAddr } from '@/lib/format';
import { deriveRadar, type Derived } from '@/lib/radar';
import { useMedia, useIsMobile } from '@/lib/hooks';
import { DEFAULT_RADAR, useRadar, type RadarFilters } from '@/lib/queries';
import { TrackRecordView } from './TrackRecordView';

type View = 'explorer' | 'record';
const VIEWS = [
  { value: 'explorer' as const, label: 'Explorer' },
  { value: 'record' as const, label: 'Track record' },
];
const eyebrow = 'font-mono text-[11px] font-medium leading-none tracking-[0.06em] uppercase text-faint';

export function RadarPage() {
  return (
    <Suspense fallback={null}>
      <RadarInner />
    </Suspense>
  );
}

function ViewToggle({ view, onView }: { view: View; onView: (v: View) => void }) {
  return <Segmented<View> role="tablist" ariaLabel="Radar view" value={view} onChange={onView} options={VIEWS} className="!border-violet/[0.24] bg-[rgba(14,11,24,0.82)] p-[3px] backdrop-blur-[12px]" btnClassName="h-8 px-3.5 text-xs font-semibold" data-component="RadarViewToggle" />;
}

function RadarInner() {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const view: View = sp.get('view') === 'record' ? 'record' : 'explorer';
  const setView = (v: View) => router.replace(v === 'record' ? `${path}?view=record` : path, { scroll: false });
  useChannel('markets:summary');
  if (view === 'record') return <TrackRecordView toggle={<ViewToggle view={view} onView={setView} />} />;
  return <Explorer toggle={<ViewToggle view={view} onView={setView} />} />;
}

function Explorer({ toggle }: { toggle: React.ReactNode }) {
  const q = useRadar();
  const compact = useMedia('(max-width: 899px)');
  const lite = useIsMobile();
  const [f, setF] = useState<RadarFilters>(DEFAULT_RADAR);
  const [sel, setSel] = useState<string | null>(null);
  const set = (p: Partial<RadarFilters>) => setF((x) => ({ ...x, ...p }));
  const data = q.data;
  const empty = !!data && data.nodes.length === 0;
  const d = useMemo(() => deriveRadar(data, f), [data, f]);
  const total = data?.nodes.length ?? 0;
  const count = `${d.flagged.length} flagged of ${d.pass.length} wallets in view`;

  // Clear a selection that no longer passes the filters.
  useEffect(() => {
    if (sel && data && !data.nodes.some((n) => n.addr === sel)) setSel(null);
  }, [sel, data]);

  const state = q.isPending ? 'loading' : empty ? 'empty' : sel ? 'selected' : 'idle';
  const graph = (
    <WalletGraph data={data} mode="explorer" lite={lite} state={state} selected={sel} minScore={f.minScore} cluster={f.cluster} showCrowd={f.crowd} align={compact ? 'center' : 'right'} onSelect={setSel} label="Smart money wallet graph. Select a node for its breakdown." className="absolute inset-0" />
  );

  const filters = <FilterPanel f={f} set={set} data={data} count={count} d={d} sel={sel} onSel={setSel} />;

  const emptyNote = (
    <div className="pointer-events-none absolute inset-0 grid place-items-center px-6">
      <EmptyState title="The wallet graph is building" className="pointer-events-auto max-w-md bg-bg/70 backdrop-blur-md">
        The scorer has not published a run yet, so there are no scored wallets to draw. Check back after the next scoring run.
      </EmptyState>
    </div>
  );

  if (!compact) {
    return (
      <section data-component="RadarExplorer" className="relative h-[calc(100vh-64px)] min-h-[620px] overflow-hidden" style={{ background: 'radial-gradient(60% 70% at 50% 50%,rgba(91,44,143,0.28),#07060C 75%)' }}>
        {graph}
        {empty ? emptyNote : null}
        {q.isError ? (
          <div className="absolute inset-0 grid place-items-center">
            <ErrorState title="Could not load the wallet graph" onRetry={() => void q.refetch()} />
          </div>
        ) : null}
        <div className="absolute left-1/2 top-5 z-[3] -translate-x-1/2">{toggle}</div>
        <div data-component="RadarFilters" className="absolute bottom-5 left-5 top-5 flex w-[300px] flex-col gap-[22px] overflow-auto rounded-[20px] border border-violet/[0.18] bg-[rgba(14,11,24,0.78)] p-5 backdrop-blur-[16px]">
          {filters}
        </div>
        <Legend d={d} className="absolute bottom-6 left-[340px]" />
        {sel ? (
          <aside aria-label="Wallet details" className="absolute bottom-5 right-5 top-5 z-[4] flex w-[360px] animate-gg-sheet flex-col overflow-auto rounded-[20px] border border-above/[0.22] bg-[rgba(14,11,24,0.86)] p-[22px] backdrop-blur-[16px]">
            <WalletDetailBody addr={sel} onClose={() => setSel(null)} variant="radar" />
          </aside>
        ) : (
          <div className="absolute right-7 top-7 font-mono text-[11px] font-medium leading-none tracking-[0.06em] text-faint">CLICK ANY NODE FOR ITS FULL BREAKDOWN</div>
        )}
      </section>
    );
  }

  return (
    <section data-component="RadarExplorerMobile" className="flex flex-col">
      <div className="flex flex-col gap-3 px-4 pb-3 pt-5">
        {toggle}
        <div className="flex items-end justify-between gap-3">
          <h1 className="font-display text-[26px] font-semibold leading-none tracking-[-0.02em]">Radar</h1>
          <span className="font-mono text-[11px] font-medium leading-none text-faint">
            {d.flagged.length} / {total} flagged
          </span>
        </div>
        <DemoDataLabel source={data?.dataSource} className="self-start" />
        <div className="gg-no-scrollbar flex gap-1.5 overflow-x-auto pb-0.5">
          {[0, 50, 70, 90].map((v) => (
            <button key={v} type="button" aria-pressed={f.minScore === v} onClick={() => set({ minScore: v })} className={cn('h-[34px] flex-none rounded-pill border px-3 font-mono text-xs font-medium', f.minScore === v ? 'border-above/50 bg-above/10 text-white' : 'border-violet/[0.18] bg-transparent text-muted')}>
              ≥{v}
            </button>
          ))}
          {[{ id: 'all', name: 'All' }, ...(data?.clusters ?? [])].map((c) => {
            const id = String(c.id);
            return (
              <button key={id} type="button" aria-pressed={f.cluster === id} onClick={() => set({ cluster: id })} className={cn('h-[34px] flex-none rounded-pill border px-3 font-sans text-xs font-medium', f.cluster === id ? 'border-above/50 bg-above/10 text-white' : 'border-violet/[0.18] bg-transparent text-muted')}>
                {c.name}
              </button>
            );
          })}
        </div>
      </div>
      <div className="relative h-[52vh] min-h-[320px]" style={{ background: 'radial-gradient(70% 70% at 50% 50%,rgba(91,44,143,0.3),#07060C 80%)' }}>
        {graph}
        {empty ? emptyNote : null}
        <span className="pointer-events-none absolute bottom-3 left-4 font-mono text-[10px] font-medium leading-none text-faint">{lite ? `LITE 2.5D · ${Math.min(70, d.pass.length)} NODES · TAP A NODE` : 'TAP A NODE'}</span>
      </div>
      {sel ? (
        <div data-component="WalletDetailSheet" className="relative mx-3 -mt-6 animate-gg-sheet rounded-[20px] border border-above/25 bg-[rgba(14,11,24,0.95)] p-[18px]">
          <WalletDetailBody addr={sel} onClose={() => setSel(null)} variant="radar" />
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5 px-4 py-5">
        <span className={eyebrow}>Top flagged</span>
        <TopList d={d} sel={sel} onSel={setSel} data={data} mobile />
        {q.isPending ? <Skeleton className="h-[52px] rounded-xl" /> : null}
      </div>
    </section>
  );
}

function FilterPanel({ f, set, data, count, d, sel, onSel }: { f: RadarFilters; set: (p: Partial<RadarFilters>) => void; data: GraphPayload | undefined; count: string; d: Derived; sel: string | null; onSel: (a: string) => void }) {
  const chips = [{ id: 'all', name: 'All' }, ...(data?.clusters ?? [])];
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <h1 className="font-display text-2xl font-semibold leading-[1.1] tracking-[-0.02em]">Smart Money Radar</h1>
        <span className="text-[13px] text-dim" data-testid="radar-count">
          {data ? count : 'Loading the graph'}
        </span>
        <DemoDataLabel source={data?.dataSource} className="mt-1 self-start" />
      </div>
      <div className="flex flex-col gap-2.5">
        <div className={cn(eyebrow, 'flex justify-between')}>
          <label htmlFor="min-score">Min score</label>
          <span className="text-above">{f.minScore}</span>
        </div>
        <input id="min-score" type="range" min={0} max={100} value={f.minScore} onChange={(e) => set({ minScore: Number(e.target.value) })} className="w-full" />
      </div>
      <div className="flex flex-col gap-2.5">
        <span className={eyebrow}>Cluster</span>
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => {
            const id = String(c.id);
            const on = f.cluster === id;
            return (
              <button key={id} type="button" aria-pressed={on} onClick={() => set({ cluster: id })} className={cn('h-[30px] rounded-pill border px-2.5 font-sans text-xs font-medium', on ? 'border-above/50 bg-above/10 text-white' : 'border-violet/[0.18] bg-transparent text-muted hover:border-violet/40')}>
                {c.name}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex items-center justify-between text-[13px] text-ink-2">
        <span id="crowd-label">Show crowd wallets</span>
        <Switch on={f.crowd} onChange={(v) => set({ crowd: v })} label="Show crowd wallets" />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className={eyebrow}>Top flagged</span>
        <TopList d={d} sel={sel} onSel={onSel} data={data} />
      </div>
    </>
  );
}

function TopList({ d, sel, onSel, data, mobile }: { d: Derived; sel: string | null; onSel: (a: string) => void; data: GraphPayload | undefined; mobile?: boolean }) {
  const clusterName = (id: number) => data?.clusters.find((c) => c.id === id)?.name ?? '';
  if (d.top.length === 0) return <span className="py-2 text-xs text-dim">No flagged wallets match these filters.</span>;
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0" data-testid="top-flagged">
      {d.top.map((n) => {
        const c = scoreColor(n);
        return (
          <li key={n.addr}>
            <button
              type="button"
              onClick={() => onSel(n.addr)}
              aria-pressed={sel === n.addr}
              className={cn('flex w-full items-center gap-3 rounded-[10px] border text-left transition-colors hover:bg-violet/10', mobile ? 'min-h-[52px] border-violet/10 px-3' : 'border-transparent p-2.5', sel === n.addr ? 'bg-above/[0.08]' : 'bg-transparent')}
            >
              <span aria-hidden className="h-2 w-2 flex-none rounded-full" style={{ background: c, boxShadow: `0 0 8px ${c}` }} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-mono text-xs font-medium leading-none">{shortAddr(n.addr)}</span>
                <span className="text-[11px] text-faint">{clusterName(n.cluster)}</span>
              </span>
              <span className="font-display text-base font-semibold leading-none" style={{ color: c }}>
                {n.score}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Legend({ d, className }: { d: Derived; className?: string }) {
  return (
    <div data-component="GraphLegend" className={cn('flex flex-wrap gap-[18px] rounded-pill border border-violet/[0.14] bg-[rgba(14,11,24,0.7)] px-4 py-2.5 font-mono text-[11px] font-medium leading-none text-muted backdrop-blur-[10px]', className)}>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-crowd" />
        Crowd
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="h-2 w-2 rounded-full bg-above shadow-[0_0_8px_#2CE6D6]" />
        Smart money{d.minSmart != null ? ` ≥${d.minSmart}` : ''}
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="h-2 w-2 rounded-full bg-below shadow-[0_0_8px_#E046F0]" />
        Top tier{d.minTop != null ? ` ≥${d.minTop}` : ''}
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="h-px w-3.5 bg-above" />
        Smart-money link
      </span>
      <span className="text-faint">Drag to orbit · scroll to zoom</span>
    </div>
  );
}

