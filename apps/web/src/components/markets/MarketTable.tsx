'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { MarketSummary } from '@groundgraph/sdk/api-types';
import { AssetMonogram, Sparkline, cn } from '@groundgraph/ui';
import { cents, countdownLabel, edgeLabel, hoursUntil, isUrgent, signedPP, traders, usdFromU64 } from '@/lib/format';
import { useFlash } from '@/lib/hooks';
import { statusLabel } from './MarketCard';

const COLS = 'grid-cols-[minmax(0,1fr)_84px_130px_170px_110px_96px_168px]';

function Row({ m, now }: { m: MarketSummary; now: number }) {
  const router = useRouter();
  const flash = useFlash(m.priceAbove);
  const smFlash = useFlash(m.radar.p);
  const up = m.ch24 >= 0;
  const hrs = hoursUntil(m.endsAt, now);
  const st = statusLabel(m);
  const open = m.status === 'open';
  const ready = m.radar.state === 'ready' && m.radar.p != null;
  const lean = (m.radar.edge ?? 0) >= 0 ? '#2CE6D6' : '#E046F0';
  return (
    <div data-component="MarketRow" onClick={() => router.push(`/markets/${m.id}`)} className={cn('grid cursor-pointer items-center gap-4 border-b border-violet/[0.08] px-[18px] py-3.5 transition-colors duration-500 hover:bg-violet/[0.06]', COLS, flash && 'bg-above/5')}>
      <div className="flex min-w-0 items-center gap-3">
        <AssetMonogram symbol={m.assetSymbol} size={32} />
        <div className="flex min-w-0 flex-col gap-1">
          <Link href={`/markets/${m.id}`} onClick={(e) => e.stopPropagation()} className="overflow-hidden text-ellipsis whitespace-nowrap font-display text-sm font-medium leading-[1.3] text-ink hover:text-ink">
            {m.question}
          </Link>
          <span className="text-xs text-faint">
            {m.category} · {traders(m.traders)} traders
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <span className={cn('gg-flash-target font-display text-lg font-semibold leading-none text-ink', flash && 'gg-flash')}>{cents(m.priceAbove)}</span>
        <span className="font-mono text-[11px] font-medium leading-none" style={{ color: up ? '#2CE6D6' : '#E046F0' }}>
          {signedPP(m.ch24)}
        </span>
      </div>
      <Sparkline values={m.spark} up={up} width={200} height={56} className="h-9 w-[130px]" strokeWidth={1.5} />
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between text-xs">
          <b className={cn('gg-flash-target font-mono text-[13px] font-semibold leading-none text-ink', smFlash && 'gg-flash-violet')}>
            {ready ? `${Math.round((m.radar.p as number) * 100)}%` : 'Building'} {ready && m.radar.ci != null ? <span className="font-normal text-faint">±{m.radar.ci}</span> : null}
          </b>
          {ready && m.radar.edge != null ? (
            <span className="font-mono text-[11px] font-medium leading-none" style={{ color: lean }}>
              {edgeLabel(m.radar.edge)}
            </span>
          ) : null}
        </div>
        <span className="relative block h-1 rounded-sm bg-white/[0.06]">
          <span className="block h-full rounded-sm" style={{ width: `${ready ? Math.round((m.radar.p as number) * 100) : 0}%`, background: `linear-gradient(90deg,#9B6BFF,${ready ? lean : '#9B6BFF'})` }} />
          <span className="absolute -top-[3px] ml-[-1px] h-2.5 w-0.5 bg-white" style={{ left: `${Math.round(m.priceAbove * 100)}%` }} />
        </span>
      </div>
      <span className="font-mono text-xs font-medium tabular-nums" style={{ color: open && isUrgent(hrs) ? '#BFF7F1' : '#B9B4CC' }}>
        {st ?? countdownLabel(hrs)}
      </span>
      <span className="font-mono text-xs font-medium text-muted">{usdFromU64(m.volume)}</span>
      <div className="flex gap-1.5">
        <Link href={`/markets/${m.id}?side=above`} onClick={(e) => e.stopPropagation()} className="gg-btn gg-btn-above h-[34px] flex-1 rounded-[9px] text-xs hover:text-above-text">
          {open ? `Above ${cents(m.priceAbove)}` : 'View'}
        </Link>
        {open ? (
          <Link href={`/markets/${m.id}?side=below`} onClick={(e) => e.stopPropagation()} className="gg-btn gg-btn-below h-[34px] flex-1 rounded-[9px] text-xs hover:text-below-text">
            Below {cents(1 - m.priceAbove)}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

export function MarketTable({ items, now }: { items: MarketSummary[]; now: number }) {
  return (
    <div data-component="MarketTable" className="mt-5 animate-gg-in overflow-x-auto rounded-[20px] border border-violet/[0.14] bg-panel-2/55">
      <div className="min-w-[1040px]">
        <div aria-hidden className={cn('grid items-center gap-4 border-b border-violet/[0.12] px-[18px] py-3.5 font-mono text-[10px] font-medium uppercase leading-none tracking-[0.06em] text-faint', COLS)}>
          <span>Market</span>
          <span>Above</span>
          <span>Trend</span>
          <span>Radar P(above)</span>
          <span>Ends in</span>
          <span>Volume</span>
          <span />
        </div>
        {items.map((m) => (
          <Row key={m.id} m={m} now={now} />
        ))}
      </div>
    </div>
  );
}
