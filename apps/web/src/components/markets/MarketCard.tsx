'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { MarketSummary } from '@groundgraph/sdk/api-types';
import { AssetMonogram, CountdownPill, SmartMoneyMeter, Sparkline, WatchToggle, cn } from '@groundgraph/ui';
import { cents, countdownLabel, hoursUntil, isUrgent, signedPP, traders, usdFromU64 } from '@/lib/format';
import { useFlash } from '@/lib/hooks';

export function statusLabel(m: Pick<MarketSummary, 'status' | 'outcome'>): string | null {
  if (m.status === 'settled') return `Settled ${m.outcome ? m.outcome.toUpperCase() : ''}`.trim();
  if (m.status === 'voided') return 'Voided';
  if (m.status === 'trading_closed') return 'Resolving';
  return null;
}

export function MarketCard({ m, watched, onWatch, now }: { m: MarketSummary; watched: boolean; onWatch: () => void; now: number }) {
  const router = useRouter();
  const flash = useFlash(m.priceAbove);
  const smFlash = useFlash(m.radar.p);
  const up = m.ch24 >= 0;
  const hrs = hoursUntil(m.endsAt, now);
  const st = statusLabel(m);
  const open = m.status === 'open';
  const href = `/markets/${m.id}`;
  return (
    <article
      data-component="MarketCard"
      data-market-id={m.id}
      onClick={() => router.push(href)}
      className={cn('gg-hover-lift flex animate-gg-in cursor-pointer flex-col gap-4 rounded-[20px] border p-5', flash ? 'border-above/40' : 'border-violet/[0.14]')}
      style={{ background: 'var(--gg-surface)' }}
    >
      <div className="flex items-center gap-2.5">
        <AssetMonogram symbol={m.assetSymbol} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-display text-sm font-semibold leading-[1.2]">{m.assetSymbol}</span>
          <span className="whitespace-nowrap text-xs text-faint">{m.category}</span>
        </div>
        <WatchToggle on={watched} onToggle={onWatch} />
        <CountdownPill label={st ?? countdownLabel(hrs)} urgent={open && isUrgent(hrs)} prefix={st ? '' : '⏱'} />
      </div>
      <h3 className="min-h-[46px] font-display text-[17px] font-medium leading-[1.35] tracking-[-0.01em] text-ink [text-wrap:pretty]">
        <Link href={href} onClick={(e) => e.stopPropagation()} className="text-ink hover:text-ink">
          {m.question}
        </Link>
      </h3>
      <div className="flex items-end gap-3.5">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[11px] font-medium leading-none tracking-[0.06em] text-faint">ABOVE · {Math.round(m.priceAbove * 100)}% implied</span>
          <span className={cn('gg-flash-target font-display text-[34px] font-semibold leading-none tracking-[-0.03em] text-ink', flash && 'gg-flash')}>{cents(m.priceAbove)}</span>
          <span className="font-mono text-xs font-medium leading-none" style={{ color: up ? '#2CE6D6' : '#E046F0' }}>
            {signedPP(m.ch24)} 24h
          </span>
        </div>
        <Sparkline values={m.spark} up={up} className="h-14 flex-1" />
      </div>
      <SmartMoneyMeter state={m.radar.state} p={m.radar.p} ci={m.radar.ci} n={m.radar.n} edge={m.radar.edge} marketPrice={m.priceAbove} flash={smFlash} />
      <div className="flex gap-2">
        <Link href={`${href}?side=above`} onClick={(e) => e.stopPropagation()} className="gg-btn gg-btn-above h-11 flex-1 rounded-[10px] text-[13px] hover:text-above-text min-[760px]:h-10">
          {open ? `Above ${cents(m.priceAbove)}` : 'View market'}
        </Link>
        {open ? (
          <Link href={`${href}?side=below`} onClick={(e) => e.stopPropagation()} className="gg-btn gg-btn-below h-11 flex-1 rounded-[10px] text-[13px] hover:text-below-text min-[760px]:h-10">
            Below {cents(1 - m.priceAbove)}
          </Link>
        ) : null}
      </div>
      <div className="flex justify-between font-mono text-[11px] leading-none text-faint">
        <span>Vol {usdFromU64(m.volume)}</span>
        <span>{traders(m.traders)} traders</span>
        <span>Liq {usdFromU64(m.liquidity)}</span>
      </div>
    </article>
  );
}
