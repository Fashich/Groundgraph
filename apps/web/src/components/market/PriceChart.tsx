'use client';

import { useId, useMemo, useRef, useState } from 'react';
import type { FlaggedEntry, MarketDetail } from '@groundgraph/sdk/api-types';
import { Segmented, cn } from '@groundgraph/ui';
import { cents, fmtDT, shortAddr, signedPP } from '@/lib/format';
import { useFlash } from '@/lib/hooks';
import { CHART_H, CHART_W, chartGeometry, pointAtFraction } from '@/lib/market';

export type Tf = '1D' | '3D' | '1W' | 'ALL';
const TFS: { value: Tf; label: string }[] = [
  { value: '1D', label: '1D' },
  { value: '3D', label: '3D' },
  { value: '1W', label: '1W' },
  { value: 'ALL', label: 'ALL' },
];

export function PriceChart({
  m,
  tf,
  onTf,
  insight,
  onPickWallet,
  loading,
}: {
  m: MarketDetail;
  tf: Tf;
  onTf: (t: Tf) => void;
  insight: string | null;
  onPickWallet: (addr: string) => void;
  loading?: boolean;
}) {
  const gid = useId().replace(/:/g, '');
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const flash = useFlash(m.priceAbove);
  const fair = m.fairValue?.pAbove ?? null;
  const geom = useMemo(() => chartGeometry(m.history.points, fair, m.flaggedEntries), [m.history.points, fair, m.flaggedEntries]);
  const hp = hover != null ? pointAtFraction(m.history.points, hover) : null;
  const up = m.ch24 >= 0;

  const onMove = (e: React.PointerEvent) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const plotW = r.width - 36;
    setHover(Math.max(0, Math.min(1, (e.clientX - r.left) / plotW)));
  };

  return (
    <section
      data-component="PriceChart"
      aria-label="Price history"
      className="flex flex-col gap-[18px] rounded-[22px] border border-violet/[0.14] p-[clamp(16px,2.4vw,28px)]"
      style={{ background: 'var(--gg-surface)' }}
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-[11px] font-medium leading-none tracking-[0.06em] text-faint">ABOVE · {Math.round(m.priceAbove * 100)}% implied</span>
            <span className={cn('gg-flash-target font-display text-5xl font-semibold leading-[0.9] tracking-[-0.03em] text-ink', flash && 'gg-flash')} data-testid="price-above">
              {cents(m.priceAbove)}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-[11px] font-medium leading-none tracking-[0.06em] text-faint">BELOW · {Math.round((1 - m.priceAbove) * 100)}% implied</span>
            <span className="font-display text-[28px] font-semibold leading-[0.9] text-muted" data-testid="price-below">
              {cents(1 - m.priceAbove)}
            </span>
          </div>
          {fair != null ? (
            <div data-component="FairValue" title="Digital option fair value from the oracle spot price and recent volatility" className="flex flex-col gap-1.5 border-l border-violet/[0.18] pl-5">
              <span className="font-mono text-[11px] font-medium leading-none tracking-[0.06em] text-faint">MODEL FAIR</span>
              <span className="font-display text-[28px] font-semibold leading-[0.9] text-violet-pale">{cents(fair)}</span>
            </div>
          ) : null}
          <span className="pb-1 font-mono text-[13px] font-medium leading-none" style={{ color: up ? '#2CE6D6' : '#E046F0' }}>
            {signedPP(m.ch24)} 24h
          </span>
        </div>
        <Segmented<Tf> ariaLabel="Chart range" value={tf} onChange={onTf} options={TFS} />
      </div>

      {geom ? (
        <div
          ref={box}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          className={cn('relative h-[clamp(200px,26vw,280px)] cursor-crosshair touch-pan-y transition-opacity', loading && 'opacity-60')}
          role="img"
          aria-label={`ABOVE price ${cents(m.priceAbove)} over ${tf}. ${geom.marks.length} flagged wallet entries marked.`}
        >
          <div className="pointer-events-none absolute inset-0 flex flex-col justify-between">
            {geom.grid.map((g) => (
              <div key={g.label} className="flex items-center gap-2">
                <span className="h-px flex-1 bg-violet/[0.08]" />
                <span className="w-7 text-right font-mono text-[10px] leading-none text-faint">{g.label}</span>
              </div>
            ))}
          </div>
          <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" className="pointer-events-none absolute left-0 top-0 block h-full w-[calc(100%-36px)] overflow-visible" aria-hidden>
            <defs>
              <linearGradient id={`${gid}a`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="rgba(44,230,214,0.26)" />
                <stop offset="1" stopColor="rgba(44,230,214,0)" />
              </linearGradient>
              <linearGradient id={`${gid}l`} x1="0" x2="1">
                <stop offset="0" stopColor="#9B6BFF" />
                <stop offset="1" stopColor="#2CE6D6" />
              </linearGradient>
            </defs>
            <path d={geom.area} fill={`url(#${gid}a)`} />
            <path d={geom.line} fill="none" stroke={`url(#${gid}l)`} strokeWidth="2.2" vectorEffect="non-scaling-stroke" />
          </svg>
          <div className="pointer-events-none absolute left-0 top-0 h-full w-[calc(100%-36px)]">
            {hp ? (
              <>
                <span className="absolute bottom-0 top-0 w-px bg-body/[0.22]" style={{ left: `${hp.xPct}%` }} />
                <span className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-above bg-bg shadow-[0_0_10px_rgba(44,230,214,0.6)]" style={{ left: `${hp.xPct}%`, top: `${hp.yPct}%` }} />
                <div
                  data-component="ChartTooltip"
                  className="absolute top-1 z-[2] flex flex-col gap-[5px] whitespace-nowrap rounded-[10px] border border-violet/[0.28] bg-[rgba(14,11,24,0.92)] px-2.5 py-2"
                  style={{ left: `${hp.xPct}%`, transform: hp.xPct > 70 ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)' }}
                >
                  <span className="font-display text-[15px] font-semibold leading-none text-ink">
                    {cents(hp.priceAbove)} <span className="font-mono text-[10px] font-medium text-faint">ABOVE</span>
                  </span>
                  <span className="font-mono text-[11px] leading-none text-dim">{fmtDT(hp.ts)}</span>
                </div>
              </>
            ) : null}
            {geom.fairYPct != null && fair != null ? (
              <>
                <span data-component="FairValueLine" className="absolute left-0 right-0 border-t border-dashed border-violet-pale/50" style={{ top: `${geom.fairYPct}%` }} />
                <span className="absolute left-2 -translate-y-[130%] font-mono text-[10px] font-medium leading-none text-violet-pale" style={{ top: `${geom.fairYPct}%` }}>
                  MODEL FAIR {cents(fair)}
                </span>
              </>
            ) : null}
            {geom.marks.map((k) => (
              <FlagMark key={`${k.entry.wallet}-${k.entry.ts}`} entry={k.entry} x={k.xPct} y={k.yPct} onPick={onPickWallet} />
            ))}
            <span className="absolute right-0 h-2.5 w-2.5 translate-x-1/2 -translate-y-1/2 animate-gg-pulse rounded-full bg-above" style={{ top: `${geom.lastYPct}%` }} />
          </div>
        </div>
      ) : (
        <div className="grid h-[clamp(200px,26vw,280px)] place-items-center rounded-2xl border border-dashed border-violet/20 px-6 text-center text-sm text-dim">
          {loading ? 'Loading price history' : 'Price history is building. The chart appears after the first trades.'}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5 text-[13px] text-muted">
        <span className="flex items-center gap-2">
          <span aria-hidden className="h-2.5 w-2.5 rounded-full border-2 border-below" />
          Flagged-wallet entries · click to inspect
        </span>
        {insight ? <span className="text-ink-2">{insight}</span> : null}
      </div>
    </section>
  );
}

function FlagMark({ entry, x, y, onPick }: { entry: FlaggedEntry; x: number; y: number; onPick: (a: string) => void }) {
  const title = `${shortAddr(entry.wallet)} entered ${entry.side.toUpperCase()} at ${cents(entry.priceAtEntry)} · score ${entry.score}`;
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      data-testid="flag-mark"
      onClick={() => onPick(entry.wallet)}
      className="pointer-events-auto absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-below bg-below/25 p-0 shadow-[0_0_14px_rgba(224,70,240,0.7)] transition-transform hover:scale-[1.35]"
      style={{ left: `${x}%`, top: `${y}%` }}
    />
  );
}
