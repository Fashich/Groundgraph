'use client';

import { Segmented, Chip, cn } from '@groundgraph/ui';
import { Modal } from '@/components/common/Modal';
import type { MarketFilters as Filters } from '@/lib/queries';
import { DEFAULT_FILTERS } from '@/lib/queries';

export const CATS = ['All', 'High signal', 'Majors', 'Solana ecosystem'] as const;
export const LEANS = [
  { value: 'any', label: 'Any' },
  { value: 'above', label: 'Above' },
  { value: 'below', label: 'Below' },
] as const;
export const ENDS = [
  { value: 'any', label: 'Any' },
  { value: '48h', label: '< 48h' },
  { value: '2w', label: '< 2w' },
  { value: 'long', label: '2w +' },
] as const;
export const SORTS = [
  { value: 'signal', label: 'Signal' },
  { value: 'gap', label: 'Edge' },
  { value: 'ending', label: 'Ending' },
  { value: 'volume', label: 'Volume' },
] as const;

export function activeFilterCount(f: Filters): number {
  return (f.cat !== 'All' ? 1 : 0) + (f.lean !== 'any' ? 1 : 0) + (f.ends !== 'any' ? 1 : 0) + (f.watch ? 1 : 0) + (f.q ? 1 : 0);
}

export interface FiltersProps {
  f: Filters;
  set: (patch: Partial<Filters>) => void;
  view: 'grid' | 'list';
  setView: (v: 'grid' | 'list') => void;
  mobile: boolean;
  onOpenSheet: () => void;
  watchCount: number;
}

export function MarketFilters({ f, set, view, setView, mobile, onOpenSheet, watchCount }: FiltersProps) {
  const n = (f.lean !== 'any' ? 1 : 0) + (f.ends !== 'any' ? 1 : 0);
  const chipH = mobile ? 'h-11' : 'h-9';
  return (
    <div data-component="MarketFilters" className="mt-7 flex flex-col gap-3">
      <div className={cn('gg-no-scrollbar flex gap-1.5 pb-0.5', mobile ? 'overflow-x-auto' : 'flex-wrap')} role="group" aria-label="Category">
        {CATS.map((c) => (
          <Chip key={c} on={f.cat === c} onClick={() => set({ cat: c })} className={chipH}>
            {c}
          </Chip>
        ))}
        <Chip on={f.watch} onClick={() => set({ watch: !f.watch })} className={cn(chipH, 'ml-auto')}>
          {f.watch ? '★' : '☆'} Watching{watchCount ? ` · ${watchCount}` : ''}
        </Chip>
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        <input
          value={f.q}
          onChange={(e) => set({ q: e.target.value })}
          placeholder="Search asset or question"
          aria-label="Search markets"
          className={cn('min-w-0 max-w-[320px] flex-[1_1_200px] rounded-pill border border-violet/[0.18] bg-white/[0.03] px-4 text-[13px] outline-none transition-[border-color,box-shadow] focus:border-above/70 focus:shadow-[0_0_0_3px_rgba(44,230,214,0.16)]', chipH)}
        />
        {!mobile ? (
          <>
            <Segmented label="Lean" ariaLabel="Smart money lean" value={f.lean} onChange={(v) => set({ lean: v })} options={LEANS.map((o) => ({ value: o.value, label: o.label }))} />
            <Segmented label="Ends" ariaLabel="Ends in" value={f.ends} onChange={(v) => set({ ends: v })} options={ENDS.map((o) => ({ value: o.value, label: o.label }))} />
            <div className="ml-auto flex flex-wrap gap-2.5">
              <Segmented label="Sort" ariaLabel="Sort markets" value={f.sort} onChange={(v) => set({ sort: v })} options={SORTS.map((o) => ({ value: o.value, label: o.label }))} />
              <Segmented ariaLabel="View" data-component="ViewToggle" value={view} onChange={setView} options={[{ value: 'grid', label: '▦ Grid' }, { value: 'list', label: '☰ List' }]} />
            </div>
          </>
        ) : (
          <button type="button" onClick={onOpenSheet} className="h-11 rounded-pill border border-violet/30 bg-violet/[0.08] px-4 text-[13px] font-semibold text-ink">
            Filters{n ? ` · ${n}` : ''}
          </button>
        )}
      </div>
    </div>
  );
}

export function FilterSheet({ open, onClose, f, set, count }: { open: boolean; onClose: () => void; f: Filters; set: (p: Partial<Filters>) => void; count: number }) {
  const group = (label: string, opts: readonly { value: string; label: string }[], cur: string, pick: (v: string) => void) => (
    <div className="flex flex-col gap-2.5">
      <span className="gg-eyebrow">{label}</span>
      <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
        {opts.map((o) => (
          <Chip key={o.value} on={cur === o.value} onClick={() => pick(o.value)} className="h-11 px-[18px] text-sm">
            {label === 'Smart money leans' && o.value !== 'any' ? `Leans ${o.label}` : o.label}
          </Chip>
        ))}
      </div>
    </div>
  );
  return (
    <Modal open={open} onClose={onClose} label="Filters" data-component="FilterSheet" z={75} scrim="bg-[rgba(4,3,8,0.6)]" panelClassName="w-full max-w-[520px] p-4 pb-[calc(20px+env(safe-area-inset-bottom))] flex flex-col gap-[22px]">
      <span className="h-1 w-9 flex-none self-center rounded-sm bg-ink/20" aria-hidden />
      <div className="flex items-center justify-between">
        <span className="font-display text-xl font-semibold leading-none">Filters</span>
        <button type="button" onClick={() => set({ lean: DEFAULT_FILTERS.lean, ends: DEFAULT_FILTERS.ends, sort: DEFAULT_FILTERS.sort })} className="text-sm text-violet-light">
          Reset
        </button>
      </div>
      {group('Smart money leans', LEANS, f.lean, (v) => set({ lean: v as Filters['lean'] }))}
      {group('Ends', ENDS, f.ends, (v) => set({ ends: v as Filters['ends'] }))}
      {group('Sort by', SORTS, f.sort, (v) => set({ sort: v as Filters['sort'] }))}
      <button type="button" onClick={onClose} className="gg-btn gg-btn-primary h-[52px] rounded-[14px] text-[15px]">
        Show {count} markets
      </button>
    </Modal>
  );
}
