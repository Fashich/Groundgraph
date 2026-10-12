'use client';

import Link from 'next/link';
import type { MarketDetail } from '@groundgraph/sdk/api-types';
import { AssetMonogram, CountdownPill, OutcomeBadge, WatchToggle, cn } from '@groundgraph/ui';
import { countdownLabel, hoursUntil, isUrgent, traders, usdFromU64 } from '@/lib/format';
import { oracleView } from '@/lib/market';
import { statusLabel } from '@/components/markets/MarketCard';

export function OracleStatus({ oracle }: { oracle: MarketDetail['oracle'] }) {
  const v = oracleView(oracle);
  const stale = v.tone === 'stale';
  const unknown = v.tone === 'unknown';
  return (
    <span
      data-component="OracleStatus"
      data-stale={stale}
      title={v.title}
      className={cn(
        'flex items-center gap-2 rounded-pill border px-2.5 py-[5px] font-mono text-[11px] font-medium leading-none tabular-nums transition-colors',
        stale ? 'border-below/40 bg-below/[0.08] text-below-text' : unknown ? 'border-white/10 bg-white/[0.03] text-muted' : 'border-above/30 bg-above/[0.06] text-above-text',
      )}
    >
      <span aria-hidden className={cn('h-1.5 w-1.5 flex-none rounded-full', stale ? 'animate-gg-pulse-fast bg-below' : unknown ? 'bg-faint' : 'animate-gg-pulse bg-above')} />
      {v.label}
    </span>
  );
}

export function MarketHeader({ m, watched, onWatch, onShare, now }: { m: MarketDetail; watched: boolean; onWatch: () => void; onShare: () => void; now: number }) {
  const hrs = hoursUntil(m.endsAt, now);
  const st = statusLabel(m);
  const open = m.status === 'open';
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/markets" className="font-mono text-[13px] font-medium leading-none text-dim hover:text-above">
          ← Markets / {m.assetSymbol}
        </Link>
        <div className="flex gap-2">
          <WatchToggle variant="pill" on={watched} onToggle={onWatch} />
          <button
            type="button"
            data-component="ShareButton"
            onClick={onShare}
            className="h-11 rounded-pill border border-above/30 bg-above/[0.06] px-3.5 font-mono text-xs font-medium text-above-text transition-all hover:border-above/60 hover:text-white md:h-[34px]"
          >
            Share · Blink ↗
          </button>
        </div>
      </div>
      <header data-component="MarketHeader" className="mt-[18px] flex flex-wrap items-start gap-4">
        <AssetMonogram symbol={m.assetSymbol} size={52} />
        <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-3">
          <h1 className="font-display text-[clamp(24px,3.2vw,38px)] font-semibold leading-[1.1] tracking-[-0.025em] text-ink [text-wrap:balance]">{m.question}</h1>
          <div className="flex flex-wrap gap-2">
            <CountdownPill label={st ? st : `Ends in ${countdownLabel(hrs)}`} urgent={open && isUrgent(hrs)} prefix={st ? '' : '⏱'} />
            <span className="gg-pill">Vol {usdFromU64(m.volume)}</span>
            <span className="gg-pill">Liq {usdFromU64(m.liquidity)}</span>
            <span className="gg-pill">{traders(m.traders)} traders</span>
            <OracleStatus oracle={m.oracle} />
            {m.status === 'settled' && m.outcome ? <OutcomeBadge tone={m.outcome} label={`Settled ${m.outcome.toUpperCase()}${m.settlePrice != null ? ` · $${m.settlePrice.toLocaleString('en-US', { maximumFractionDigits: 4 })}` : ''}`} /> : null}
            {m.status === 'voided' ? <OutcomeBadge tone="neutral" label="Voided · redeem at cost" /> : null}
          </div>
        </div>
      </header>
    </>
  );
}
