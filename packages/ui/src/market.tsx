'use client';

import type { ReactNode } from 'react';
import { cn } from './cn';

export type SideKey = 'above' | 'below';

export function sideLabel(side: SideKey): 'ABOVE' | 'BELOW' {
  return side === 'above' ? 'ABOVE' : 'BELOW';
}

/** ABOVE / BELOW label. The word is always present so color is never the only signal. */
export function SideBadge({ side, className }: { side: SideKey; className?: string }) {
  return (
    <span
      className={cn(
        'inline-block rounded-md px-2 py-1 font-mono text-[11px] font-semibold leading-none',
        side === 'above' ? 'bg-above/12 text-above' : 'bg-below/12 text-below',
        className,
      )}
    >
      {sideLabel(side)}
    </span>
  );
}

export function AssetMonogram({ symbol, size = 34 }: { symbol: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="grid flex-none place-items-center font-display font-semibold leading-none text-white"
      style={{
        width: size,
        height: size,
        borderRadius: size >= 40 ? 12 : 10,
        fontSize: size >= 50 ? 14 : size >= 40 ? 12 : 11,
        background: 'linear-gradient(135deg,rgba(91,44,143,0.9),rgba(44,230,214,0.35))',
      }}
    >
      {symbol.slice(0, 4)}
    </span>
  );
}

/** Time to resolution. Markets ending within 48h turn cyan ("urgent"). */
export function CountdownPill({ label, urgent, prefix = '⏱', className }: { label: string; urgent?: boolean; prefix?: string; className?: string }) {
  return (
    <span
      data-component="CountdownPill"
      className={cn(
        'flex-none rounded-pill border px-2.5 py-[5px] font-mono text-[11px] font-medium leading-none tabular-nums',
        urgent ? 'border-above/40 bg-above/[0.08] text-above-text' : 'border-white/[0.06] bg-white/[0.04] text-muted',
        className,
      )}
    >
      {prefix} {label}
    </span>
  );
}

export function WatchToggle({ on, onToggle, variant = 'icon', className }: { on: boolean; onToggle: () => void; variant?: 'icon' | 'pill'; className?: string }) {
  if (variant === 'pill') {
    return (
      <button
        type="button"
        data-component="WatchToggle"
        aria-pressed={on}
        onClick={onToggle}
        className={cn(
          'h-11 rounded-pill border bg-transparent px-3.5 font-mono text-xs font-medium transition-all md:h-[34px]',
          on ? 'border-violet/50 text-violet-pale' : 'border-violet/20 text-muted',
          className,
        )}
      >
        {on ? '★ Watching' : '☆ Watch'}
      </button>
    );
  }
  return (
    <button
      type="button"
      data-component="WatchToggle"
      aria-pressed={on}
      aria-label={on ? 'Remove from watchlist' : 'Add to watchlist'}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={cn(
        'ml-auto grid h-[30px] w-[30px] flex-none place-items-center rounded-lg border border-white/[0.06] bg-transparent text-sm leading-none transition-colors hover:border-violet/35',
        on ? 'text-violet-pale' : 'text-faint',
        className,
      )}
    >
      {on ? '★' : '☆'}
    </button>
  );
}

/* ------------------------------ Sparkline ------------------------------ */

export function sparkPath(values: number[], w: number, h: number, pad = 4, lo?: number, hi?: number) {
  if (values.length === 0) return { line: '', area: '', pts: [] as [number, number][], min: 0, max: 0 };
  const mn = lo ?? Math.min(...values);
  const mx = hi ?? Math.max(...values);
  const rg = mx - mn || 0.01;
  const pts: [number, number][] = values.map((v, i) => [(i / Math.max(1, values.length - 1)) * w, h - pad - ((v - mn) / rg) * (h - pad * 2)]);
  const line = 'M' + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L');
  return { line, area: `${line} L${w},${h} L0,${h} Z`, pts, min: mn, max: mx };
}

export function Sparkline({ values, up, width = 200, height = 56, strokeWidth = 1.6, className }: { values: number[]; up: boolean; width?: number; height?: number; strokeWidth?: number; className?: string }) {
  const { line, area } = sparkPath(values, width, height, 4);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden className={cn('block min-w-0', className)}>
      <path d={area} fill={up ? 'rgba(44,230,214,0.10)' : 'rgba(224,70,240,0.10)'} />
      <path d={line} fill="none" stroke={up ? '#2CE6D6' : '#E046F0'} strokeWidth={strokeWidth} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/* ------------------------------ Radar meter ------------------------------ */

export interface SmartMoneyMeterProps {
  state: 'ready' | 'building';
  /** calibrated P(above), 0..1 */
  p: number | null;
  /** CI half-width in percentage points */
  ci: number | null;
  n: number;
  /** edge in cents */
  edge: number | null;
  /** market price of ABOVE, 0..1 (white tick) */
  marketPrice: number;
  flash?: boolean;
  className?: string;
}

/** Radar probability bar with a white tick at the market price. Honest Building state when the signal is not ready. */
export function SmartMoneyMeter({ state, p, ci, n, edge, marketPrice, flash, className }: SmartMoneyMeterProps) {
  const ready = state === 'ready' && p != null;
  const pct = ready ? Math.round((p as number) * 100) : 0;
  const favorsAbove = (edge ?? 0) >= 0;
  const lean = !ready ? '#9B6BFF' : favorsAbove ? '#2CE6D6' : '#E046F0';
  return (
    <div data-component="SmartMoneyMeter" className={cn('flex flex-col gap-[9px] rounded-xl border border-white/5 bg-white/[0.025] p-3', !ready && 'border-dashed border-violet/20', className)}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted">Radar P(above)</span>
        <span className="flex items-baseline gap-1.5">
          <b className={cn('gg-flash-target font-mono text-[15px] font-semibold text-ink', flash && 'gg-flash-violet')}>{ready ? `${pct}%` : 'Building'}</b>
          {ready && ci != null ? <span className="font-mono text-[11px] font-medium text-faint">±{ci}</span> : null}
        </span>
      </div>
      <span title="Bar: radar probability. White tick: market price" className="relative block h-1.5 rounded-[3px] bg-white/[0.06]">
        <span className="block h-full rounded-[3px] transition-[width] duration-[800ms]" style={{ width: `${pct}%`, background: `linear-gradient(90deg,#9B6BFF,${lean})` }} />
        <span className="absolute -top-[3px] ml-[-1px] h-3 w-0.5 rounded-sm bg-white shadow-[0_0_6px_rgba(255,255,255,0.7)] transition-[left] duration-[600ms]" style={{ left: `${Math.round(marketPrice * 100)}%` }} />
      </span>
      <div className="flex justify-between gap-2 font-mono text-[11px] text-faint">
        <span>{ready ? `n=${n} flagged · market ${Math.round(marketPrice * 100)}¢` : 'Signal after 10 scored trades'}</span>
        {ready && edge != null ? <span style={{ color: favorsAbove ? '#2CE6D6' : '#E046F0' }}>{`${edge >= 0 ? '+' : ''}${edge}¢ edge`}</span> : null}
      </div>
    </div>
  );
}

/* ------------------------------ Stats ------------------------------ */

export function StatCard({ label, value, sub, valueColor, glow, className, extra }: { label: string; value: ReactNode; sub?: ReactNode; valueColor?: string; glow?: boolean; className?: string; extra?: ReactNode }) {
  return (
    <div data-component="StatCard" className={cn('gg-card flex min-w-0 flex-col gap-2.5 rounded-[18px] p-5', className)}>
      <span className="gg-eyebrow">{label}</span>
      <div className="flex flex-wrap items-baseline gap-2.5">
        <span className={cn('gg-flash-target font-display text-[30px] font-semibold leading-none tracking-[-0.02em]', glow && 'gg-flash')} style={valueColor && !glow ? { color: valueColor } : undefined}>
          {value}
        </span>
        {extra}
      </div>
      {sub ? <span className="text-xs leading-[1.45] text-dim">{sub}</span> : null}
    </div>
  );
}

export function OutcomeBadge({ label, tone }: { label: string; tone: 'neutral' | 'violet' | 'above' | 'below' }) {
  const t = {
    neutral: 'text-muted bg-white/[0.03] border-white/[0.08]',
    violet: 'text-violet-pale bg-violet/[0.12] border-violet/35',
    above: 'text-above bg-above/[0.08] border-above/30',
    below: 'text-below bg-below/[0.08] border-below/30',
  }[tone];
  return (
    <span data-component="OutcomeBadge" className={cn('rounded-pill border px-2.5 py-[5px] font-mono text-[11px] font-medium leading-none tabular-nums', t)}>
      {label}
    </span>
  );
}

export function DepthMeter({ level, label, note }: { level: 1 | 2 | 3; label: string; note: string }) {
  const color = ['#9B6BFF', '#5FA8F0', '#2CE6D6'][level - 1];
  return (
    <div data-component="DepthMeter" className="flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-xl border border-white/5 bg-white/[0.025] px-3.5 py-3">
      <div className="flex gap-1" aria-hidden>
        {[1, 2, 3].map((k) => (
          <span key={k} className="h-1.5 w-7 rounded-[3px] transition-colors duration-300" style={{ background: k <= level ? color : 'rgba(255,255,255,0.08)' }} />
        ))}
      </div>
      <span className="text-[13px] font-semibold" style={{ color }}>
        {label}
      </span>
      <span className="text-[13px] text-dim">{note}</span>
    </div>
  );
}

export function MarketCardSkeleton({ delay = '0s' }: { delay?: string }) {
  return <div data-component="MarketCardSkeleton" aria-hidden className="gg-skeleton h-[396px]" style={{ animationDelay: delay }} />;
}

/* ------------------------------ Badges ------------------------------ */

export function DevnetTag({ className }: { className?: string }) {
  return (
    <span data-component="DevnetTag" title="Solana devnet · program not yet audited" className={cn('rounded-[5px] border border-violet/40 px-1.5 py-1 font-mono text-[9px] font-semibold leading-none tracking-[0.08em] text-violet-pale', className)}>
      DEVNET
    </span>
  );
}

/** Shown wherever the API says the data is synthetic. Never present demo data as real. */
export function DemoDataLabel({ source, className }: { source?: string | null; className?: string }) {
  if (!source || source !== 'demo-synthetic') return null;
  return (
    <span data-component="DemoDataLabel" title="This data is synthetic and for demonstration only" className={cn('inline-flex items-center gap-1.5 rounded-md border border-dashed border-blue/50 bg-blue/10 px-2 py-1 font-mono text-[10px] font-semibold leading-none tracking-[0.08em] text-[#BFDDFB]', className)}>
      DEMO DATA
    </span>
  );
}
