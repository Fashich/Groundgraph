'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import type { TrackRecord } from '@groundgraph/sdk/api-types';
import { DemoDataLabel, StatCard } from '@groundgraph/ui';
import { EmptyState, ErrorState, Skeleton } from '@/components/common/states';
import { ago, cents, fmtD, shortAddr } from '@/lib/format';
import { useTrackRecord } from '@/lib/queries';
import { closerStats, leadBuckets } from '@/lib/track';

const panel = 'flex min-w-0 flex-col gap-3.5 rounded-[20px] border border-violet/[0.14] p-[22px]';
const panelBg = { background: 'var(--gg-surface)' } as const;
const h3 = 'font-display text-lg font-semibold leading-[1.2]';

const fix = (v: number | null, d = 3) => (v == null ? null : v.toFixed(d));
const pctOf = (v: number | null) => (v == null ? null : `${Math.round(v * 100)}%`);

export function TrackRecordView({ toggle }: { toggle: ReactNode }) {
  const q = useTrackRecord();
  const t = q.data;
  return (
    <section data-component="TrackRecord" className="mx-auto flex max-w-[1240px] animate-gg-in flex-col gap-4 px-[clamp(16px,4vw,40px)] py-[clamp(20px,3vw,40px)]">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2.5">
          <h1 className="font-display text-[clamp(28px,3.6vw,42px)] font-semibold leading-none tracking-[-0.03em]">Radar track record</h1>
          <span className="max-w-[640px] text-sm leading-normal text-dim [text-wrap:pretty]">
            {t && t.state === 'ready'
              ? `Results on ${t.nMarkets} settled markets, ${fmtD(t.window.start)} to ${fmtD(t.window.end)}. Each radar reading uses only the wallet scores available 24 hours before the market settled. Run ${ago(t.runAt)} ago, model ${t.modelVersion}.`
              : 'How the radar probability compares with the market price once markets settle.'}
          </span>
          {t ? <DemoDataLabel source={t.dataSource} className="self-start" /> : null}
        </div>
        {toggle}
      </div>

      {q.isPending ? (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr))]">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-[130px] rounded-[20px]" />
          ))}
        </div>
      ) : null}
      {q.isError ? <ErrorState title="Could not load the track record" onRetry={() => void q.refetch()} /> : null}
      {t && t.state === 'building' ? (
        <EmptyState title="Track record is building">
          The radar has not completed an evaluation run yet, so there is nothing to compare. This page fills in once enough markets have settled with a ready radar reading. Until then no numbers are shown.
        </EmptyState>
      ) : null}
      {t && t.state === 'ready' ? <Ready t={t} /> : null}
    </section>
  );
}

function Ready({ t }: { t: TrackRecord }) {
  const stats = closerStats(t.rows);
  const edge = t.edgeRealizedCents;
  const kpis = [
    {
      l: 'Brier score',
      v: fix(t.brier.radar) ?? 'n/a',
      vs: t.brier.market != null ? `market ${fix(t.brier.market)}` : undefined,
      color: t.brier.radar != null && t.brier.market != null && t.brier.radar < t.brier.market ? '#2CE6D6' : undefined,
      sub: stats.total ? `Lower is better. The radar was closer to the outcome on ${stats.radar} of ${stats.total} markets listed below.` : 'Lower is better.',
    },
    {
      l: 'Directional hit rate',
      v: pctOf(t.hitRate.radar) ?? 'n/a',
      vs: t.hitRate.market != null ? `market ${pctOf(t.hitRate.market)}` : undefined,
      color: t.hitRate.radar != null && t.hitRate.market != null && t.hitRate.radar > t.hitRate.market ? '#2CE6D6' : undefined,
      sub: 'Share of markets where the favored side settled correctly.',
    },
    { l: 'Median lead time', v: t.medianLeadMin != null ? `${t.medianLeadMin} min` : 'n/a', vs: undefined, color: undefined, sub: 'From the first flagged entry to a 5¢ price move.' },
    {
      l: 'Edge realized',
      v: edge != null ? `${edge >= 0 ? '+' : '−'}${Math.abs(edge).toFixed(1)}¢` : 'n/a',
      vs: 'per share',
      color: edge != null ? (edge >= 0 ? '#2CE6D6' : '#E046F0') : undefined,
      sub: 'Average gain from buying the side with a radar edge, after fees.',
    },
  ];
  return (
    <>
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr))]">
        {kpis.map((k) => (
          <StatCard key={k.l} label={k.l} value={k.v} valueColor={k.color} sub={k.sub} extra={k.vs ? <span className="font-mono text-xs font-medium leading-none text-faint">{k.vs}</span> : undefined} />
        ))}
      </div>
      <div className="flex flex-wrap items-stretch gap-4">
        <Calibration t={t} />
        <LeadHistogram t={t} />
      </div>
      <div className="flex flex-wrap items-stretch gap-4">
        <ModelCard t={t} />
        <ManipulationGuard />
      </div>
      <ResolvedTable rows={t.rows} />
    </>
  );
}

function Calibration({ t }: { t: TrackRecord }) {
  const bins = [...t.calibration].filter((b) => b.n > 0).sort((a, b) => a.predicted - b.predicted);
  const maxN = Math.max(1, ...bins.map((b) => b.n));
  const best = [...bins].sort((a, b) => b.n - a.n)[0];
  const pt = (b: (typeof bins)[number]) => ({ x: b.predicted * 100, y: (1 - b.observed) * 100 });
  const path = bins.map((b, i) => `${i ? 'L' : 'M'}${pt(b).x.toFixed(1)},${pt(b).y.toFixed(1)}`).join(' ');
  return (
    <section data-component="CalibrationChart" className={`${panel} flex-[1_1_420px]`} style={panelBg}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <span className={h3}>Calibration</span>
        <span className="flex flex-wrap gap-3 font-mono text-[11px] leading-none text-muted">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-above" />
            Radar
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-0 w-3 border-t border-dashed border-muted" />
            Perfect
          </span>
        </span>
      </div>
      {bins.length === 0 ? (
        <div className="grid h-48 place-items-center rounded-xl border border-dashed border-violet/20 text-sm text-dim">No calibration bins yet</div>
      ) : (
        <div className="grid w-full max-w-[460px] grid-cols-[18px_minmax(0,1fr)] items-center gap-2 self-center">
          <span className="font-mono text-[10px] leading-none text-faint [text-align:center] [transform:rotate(180deg)] [writing-mode:vertical-rl]">OBSERVED ABOVE RATE</span>
          <div className="relative aspect-square border-b border-l border-violet/25" role="img" aria-label="Calibration chart: predicted probability against the observed ABOVE rate">
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
              <path d="M0,25 L100,25 M0,50 L100,50 M0,75 L100,75 M25,0 L25,100 M50,0 L50,100 M75,0 L75,100" stroke="rgba(155,107,255,0.08)" fill="none" vectorEffect="non-scaling-stroke" />
              <path d="M0,100 L100,0" stroke="rgba(237,235,245,0.3)" strokeDasharray="3 3" fill="none" vectorEffect="non-scaling-stroke" />
              <path d={path} stroke="#2CE6D6" strokeWidth="2" fill="none" vectorEffect="non-scaling-stroke" />
            </svg>
            {bins.map((b) => {
              const p = pt(b);
              const s = 9 + Math.round((b.n / maxN) * 9);
              return <span key={b.bin} title={`Predicted ${Math.round(b.predicted * 100)}%, observed ${Math.round(b.observed * 100)}% (n=${b.n})`} className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-above bg-above/25 shadow-[0_0_12px_rgba(44,230,214,0.45)]" style={{ left: `${p.x}%`, top: `${p.y}%`, width: s, height: s }} />;
            })}
          </div>
          <span />
          <div className="flex justify-between font-mono text-[10px] leading-none text-faint">
            <span>0%</span>
            <span>PREDICTED P(ABOVE)</span>
            <span>100%</span>
          </div>
        </div>
      )}
      {best ? (
        <span className="text-[13px] leading-normal text-muted">
          In the busiest bin ({best.n} markets) the radar said {Math.round(best.predicted * 100)}% and ABOVE settled {Math.round(best.observed * 100)}% of the time. Dots on the dashed diagonal are perfectly calibrated.
        </span>
      ) : null}
    </section>
  );
}

function LeadHistogram({ t }: { t: TrackRecord }) {
  const b = leadBuckets(t.leadHistogram);
  return (
    <section data-component="LeadTimeHistogram" className={`${panel} flex-[1_1_320px]`} style={panelBg}>
      <span className={h3}>Lead time before the move</span>
      {b.length === 0 ? (
        <div className="grid h-48 place-items-center rounded-xl border border-dashed border-violet/20 text-sm text-dim">No lead time data yet</div>
      ) : (
        <div className="flex h-[200px] items-end gap-1.5 pt-2">
          {b.map((x) => (
            <div key={x.label} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5">
              <span className="font-mono text-[11px] font-medium leading-none text-body">{x.n}</span>
              <span className="w-full rounded-t-md rounded-b-sm" style={{ height: `${Math.max(2, x.h * 100)}%`, background: 'linear-gradient(180deg,#2CE6D6,rgba(155,107,255,0.5))' }} />
              <span className="whitespace-nowrap font-mono text-[10px] leading-none text-faint">{x.label}</span>
            </div>
          ))}
        </div>
      )}
      <span className="text-[13px] leading-normal text-muted">Minutes between the first flagged entry and a 5¢ price move.{t.medianLeadMin != null ? ` Median ${t.medianLeadMin} min.` : ''}</span>
    </section>
  );
}

function ModelCard({ t }: { t: TrackRecord }) {
  const rules = [
    'Features are point in time: each market is scored only with transactions from before the reading.',
    'Labels such as realized PnL and early entry are computed after the feature cutoff, never before.',
    'An embargo gap separates the training labels from the test period, so no position spans both.',
    'Hit rate leaves out the market being scored.',
    'Radar probabilities are calibrated before they are shown and carry a confidence interval.',
  ];
  return (
    <section data-component="ModelCard" className={`${panel} flex-[1_1_440px]`} style={panelBg}>
      <div className="flex flex-col gap-1.5">
        <span className={h3}>How we keep it honest</span>
        <span className="text-[13px] text-dim">The score is a sum of five explainable features plus a graph model. The label it learns is a proxy for smart money, not ground truth.</span>
      </div>
      <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
        {rules.map((r) => (
          <li key={r} className="flex gap-2.5 text-[13px] leading-normal text-ink-2">
            <span aria-hidden className="flex-none text-above">
              ✓
            </span>
            {r}
          </li>
        ))}
      </ul>
      <code className="font-mono text-[11px] leading-normal text-violet-light">GraphSAGE · five heuristic features · model {t.modelVersion}</code>
    </section>
  );
}

function ManipulationGuard() {
  return (
    <section data-component="ManipulationGuard" className={`${panel} flex-[1_1_320px]`} style={panelBg}>
      <span className={h3}>Spoof &amp; sybil guard</span>
      <ul className="m-0 flex list-none flex-col gap-2.5 p-0 text-[13px] leading-normal text-ink-2">
        <li className="rounded-xl bg-white/[0.03] p-3">Wallets funded from the same source are grouped and down-weighted, so one actor cannot count as many.</li>
        <li className="rounded-xl bg-white/[0.03] p-3">Labels weight realized PnL, not position size, so one large position does not look like skill.</li>
        <li className="rounded-xl bg-white/[0.03] p-3">A wallet in a suspected sybil cluster carries a SYBIL tag in its breakdown.</li>
      </ul>
      <span className="text-[13px] leading-normal text-muted">A wallet can take a position just to look like smart money. The radar shows its confidence interval and the number of flagged wallets so thin signals read as thin.</span>
    </section>
  );
}

function ResolvedTable({ rows }: { rows: TrackRecord['rows'] }) {
  return (
    <section data-component="ResolvedTable" className={panel} style={panelBg}>
      <span className={h3}>Recently resolved</span>
      {rows.length === 0 ? (
        <span className="text-sm text-dim">No settled markets with a radar reading yet.</span>
      ) : (
        <div className="overflow-x-auto">
          <table className="gg-table min-w-[640px]">
            <thead>
              <tr>
                <th>Market</th>
                <th>Radar T−24h</th>
                <th>Market T−24h</th>
                <th>Outcome</th>
                <th>Closer</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.marketId}>
                  <td className="text-ink">
                    <Link href={`/markets/${r.marketId}`} className="text-ink hover:text-above">
                      {r.question ?? shortAddr(r.marketId)}
                    </Link>
                  </td>
                  <td className="font-mono text-above">{r.radarT24 != null ? `${Math.round(r.radarT24 * 100)}%` : 'n/a'}</td>
                  <td className="font-mono text-muted">{r.marketT24 != null ? cents(r.marketT24) : 'n/a'}</td>
                  <td>
                    {r.outcome ? <span className={`rounded-[5px] px-[7px] py-[3px] font-mono text-[10px] font-semibold leading-none ${r.outcome === 'above' ? 'bg-above/10 text-above' : 'bg-below/10 text-below'}`}>{r.outcome.toUpperCase()}</span> : <span className="font-mono text-xs text-faint">n/a</span>}
                  </td>
                  <td className="font-mono text-xs font-medium" style={{ color: r.closer === 'radar' ? '#2CE6D6' : undefined }}>
                    {r.closer === 'radar' ? 'Radar' : r.closer === 'market' ? 'Market' : r.closer === 'tie' ? 'Tie' : 'n/a'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
