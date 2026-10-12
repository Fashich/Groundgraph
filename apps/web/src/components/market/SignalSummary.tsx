'use client';

import type { MarketDetail } from '@groundgraph/sdk/api-types';
import { cn } from '@groundgraph/ui';
import { cents, edgeLabel, usd } from '@/lib/format';
import { useFlash } from '@/lib/hooks';
import type { Lean } from '@/lib/market';

const LBL = 'font-mono text-[11px] font-medium leading-none tracking-[0.06em] uppercase text-faint';

function Cell({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('flex min-w-0 flex-[1_1_200px] flex-col gap-2.5 bg-panel px-5 py-[18px]', className)}>{children}</div>;
}

/** Radar summary: P(above) with CI, flagged volume lean, edge versus market, and the market line. Honest Building state. */
export function SignalSummary({ m, lean, spark }: { m: MarketDetail; lean: Lean | null; spark: number[] }) {
  const r = m.radar;
  const ready = r.state === 'ready' && r.p != null;
  const flash = useFlash(r.p);
  const edge = r.edge ?? 0;
  const favorsAbove = edge >= 0;
  const pct = ready ? Math.round((r.p as number) * 100) : null;
  const fair = m.fairValue?.pAbove ?? null;
  const edgeColor = !ready ? '#9A95AE' : favorsAbove ? '#2CE6D6' : '#E046F0';
  return (
    <section
      data-component="SignalSummary"
      aria-label="Smart money radar summary"
      className="mt-6 flex flex-wrap gap-px overflow-hidden rounded-[20px] border border-above/[0.18] bg-violet/[0.14]"
    >
      <Cell>
        <span className={LBL}>Radar P(above)</span>
        {ready ? (
          <>
            <div className="flex items-baseline gap-2.5">
              <span className={cn('gg-flash-target font-display text-[34px] font-semibold leading-none tracking-[-0.02em]', flash ? 'gg-flash' : 'text-above')}>{pct}%</span>
              {r.ci != null ? <span className="font-mono text-sm font-semibold text-muted">±{r.ci}</span> : null}
            </div>
            <span className="font-mono text-xs leading-[1.4] text-dim">
              n={r.n} flagged wallets{r.modelVersion ? ` · model ${r.modelVersion}` : ''}
            </span>
          </>
        ) : (
          <>
            <span className="font-display text-[30px] font-semibold leading-none text-violet-pale">Building</span>
            <span className="text-xs leading-[1.45] text-dim">The radar needs at least 3 flagged wallets and 10 scored trades before it shows a probability. Currently {r.n} flagged.</span>
          </>
        )}
      </Cell>
      <Cell>
        <span className={LBL}>Flagged volume</span>
        {lean ? (
          <>
            <div className="mt-1.5 flex h-2.5 gap-0.5 overflow-hidden rounded-[5px] bg-white/[0.06]" role="img" aria-label={`Flagged volume ${lean.abovePct}% ABOVE, ${lean.belowPct}% BELOW`}>
              <span className="bg-above transition-[width] duration-[600ms]" style={{ width: `${lean.abovePct}%` }} />
              <span className="flex-1 bg-below" />
            </div>
            <div className="flex justify-between font-mono text-xs font-medium leading-none">
              <span className="text-above">ABOVE {lean.abovePct}%</span>
              <span className="text-below">BELOW {lean.belowPct}%</span>
            </div>
            <span className="text-xs text-dim">
              {usd(lean.total)} across {lean.n} flagged {lean.n === 1 ? 'wallet' : 'wallets'}
            </span>
          </>
        ) : (
          <span className="text-xs leading-[1.45] text-dim">No flagged wallet holds a position here yet.</span>
        )}
      </Cell>
      <Cell>
        <span className={LBL}>Edge vs market</span>
        {ready && r.edge != null ? (
          <>
            <div className="flex items-baseline gap-2">
              <span className="font-display text-[34px] font-semibold leading-none tracking-[-0.02em]" style={{ color: edgeColor }}>
                {edgeLabel(r.edge)}
              </span>
              <span className="text-xs text-dim">on {favorsAbove ? 'ABOVE' : 'BELOW'}</span>
            </div>
            <span className="text-xs leading-[1.45] text-muted">
              Market {cents(m.priceAbove)} vs radar {pct}%.{fair != null ? ` Model fair value ${cents(fair)}.` : ''}
            </span>
          </>
        ) : (
          <span className="text-xs leading-[1.45] text-dim">Edge appears once the radar signal is ready.{fair != null ? ` Model fair value is ${cents(fair)}.` : ''}</span>
        )}
      </Cell>
      <Cell>
        <div className="flex flex-wrap justify-between gap-2">
          <span className={LBL}>Radar vs market</span>
          <span className="flex gap-2.5 font-mono text-[10px] leading-none text-faint">
            <span className="flex items-center gap-1">
              <span className="h-0.5 w-2.5 bg-above" />
              Radar now
            </span>
            <span className="flex items-center gap-1">
              <span className="h-0 w-2.5 border-t-2 border-dashed border-violet" />
              Market
            </span>
          </span>
        </div>
        <MiniSeries spark={spark} radarP={ready ? (r.p as number) : null} />
        <span className="font-mono text-[10px] leading-[1.4] text-faint">Radar history is not published yet. The marker shows the current radar value.</span>
      </Cell>
    </section>
  );
}

function MiniSeries({ spark, radarP }: { spark: number[]; radarP: number | null }) {
  if (spark.length < 2) return <div className="grid h-[60px] place-items-center rounded-lg border border-dashed border-violet/20 text-[11px] text-faint">No price history yet</div>;
  const all = radarP != null ? [...spark, radarP] : spark;
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const span = Math.max(0.02, hi - lo);
  const y = (v: number) => 56 - ((v - lo) / span) * 52;
  const path = spark.map((v, i) => `${i ? 'L' : 'M'}${((i / (spark.length - 1)) * 196).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  return (
    <svg viewBox="0 0 200 60" preserveAspectRatio="none" className="block h-[60px] w-full" role="img" aria-label="Market price line with the current radar value">
      <path d={path} fill="none" stroke="#9B6BFF" strokeWidth="1.5" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      {radarP != null ? <circle cx="196" cy={y(radarP)} r="3.5" fill="#2CE6D6" /> : null}
    </svg>
  );
}
