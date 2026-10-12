'use client';

import { cn } from './cn';

export interface FeatureItem {
  label: string;
  /** contribution to the score in points */
  pts: number;
  /** feature value 0..1, drives the bar width */
  value: number;
  color: string;
}

export const FEATURE_COLORS = {
  whaleOverlap: '#E046F0',
  entryTiming: '#B65CF5',
  hitRate: '#9B6BFF',
  centrality: '#5FA8F0',
  leadTime: '#2CE6D6',
} as const;

export const FEATURE_LABELS = {
  whaleOverlap: 'Whale overlap',
  entryTiming: 'Entry timing',
  hitRate: 'Hit rate',
  centrality: 'Centrality',
  leadTime: 'Lead time',
} as const;

export const FEATURE_ABBR = {
  whaleOverlap: 'Whale',
  entryTiming: 'Timing',
  hitRate: 'Hit rate',
  centrality: 'Central',
  leadTime: 'Lead',
} as const;

export function scoreColor(w: { smart: boolean; top: boolean }): string {
  return w.top ? '#E046F0' : w.smart ? '#2CE6D6' : '#9A95AE';
}

export function scoreVerdict(w: { smart: boolean; top: boolean }): string {
  return w.top ? 'Top-tier smart money' : w.smart ? 'Flagged smart money' : 'Crowd wallet';
}

/** Conic score ring. The number is the sum of five feature contributions, 0..100. */
export function ScoreRing({ score, color, size = 88, glow, className }: { score: number; color: string; size?: number; glow?: string; className?: string }) {
  const deg = Math.round(Math.max(0, Math.min(100, score)) * 3.6);
  const inner = Math.round(size * 0.84);
  return (
    <div
      className={cn('grid flex-none place-items-center rounded-full', className)}
      style={{ width: size, height: size, background: `conic-gradient(${color} 0 ${deg}deg,rgba(255,255,255,0.06) 0)`, boxShadow: glow ? `0 0 30px ${glow}` : undefined }}
      role="img"
      aria-label={`Score ${score} of 100`}
    >
      <div className="grid place-items-center rounded-full bg-panel-2 font-display font-semibold leading-none" style={{ width: inner, height: inner, color, fontSize: Math.round(size * 0.34) }}>
        {score}
      </div>
    </div>
  );
}

export function FeatureBars({ items, labelWidth = 100, compact, className }: { items: FeatureItem[]; labelWidth?: number; compact?: boolean; className?: string }) {
  return (
    <div className={cn('flex flex-col', compact ? 'gap-2' : 'gap-2.5', className)}>
      {items.map((f) => (
        <div key={f.label} className="grid items-center gap-2.5 text-xs" style={{ gridTemplateColumns: `${labelWidth}px minmax(0,1fr) 30px` }}>
          <span className="text-muted">{f.label}</span>
          <span className="h-1.5 overflow-hidden rounded-[3px] bg-white/[0.06]">
            <span className="block h-full transition-[width] duration-[600ms] ease-soft" style={{ width: `${Math.round(f.value * 100)}%`, background: f.color }} />
          </span>
          <span className="text-right font-mono text-[11px] font-medium">+{f.pts}</span>
        </div>
      ))}
    </div>
  );
}

export function ReasonList({ reasons, className }: { reasons: string[]; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2.5', className)}>
      {reasons.map((r, i) => (
        <div key={i} className="flex gap-2.5 text-[13px] leading-[1.45] text-ink-2">
          <span className="font-mono text-[11px] leading-[1.7] text-violet">{String(i + 1).padStart(2, '0')}</span>
          {r}
        </div>
      ))}
    </div>
  );
}

export function SybilGuard({ text }: { text: string }) {
  return (
    <div data-component="SybilGuard" className="flex items-start gap-2.5 rounded-[10px] border border-below/25 bg-below/[0.06] px-3 py-2.5 text-xs leading-[1.45] text-below-text">
      <span className="flex-none font-mono text-[10px] font-semibold leading-[1.7] text-below">SYBIL</span>
      {text}
    </div>
  );
}
