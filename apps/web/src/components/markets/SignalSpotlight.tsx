'use client';

import Link from 'next/link';
import type { MarketSummary } from '@groundgraph/sdk/api-types';
import { cents, edgeLabel } from '@/lib/format';
import { useFlash, useIsMobile } from '@/lib/hooks';
import { useMarketWallets, useRadar } from '@/lib/queries';
import { WalletGraph } from '@/components/graph/WalletGraph';

export function SignalSpotlight({ m }: { m: MarketSummary }) {
  const mobile = useIsMobile();
  const radar = useRadar();
  const wallets = useMarketWallets(m.id, !mobile);
  const flash = useFlash(m.radar.p);
  const p = m.radar.p ?? 0;
  const edge = m.radar.edge ?? 0;
  const lean = edge >= 0 ? 'above' : 'below';
  const leanColor = edge >= 0 ? '#2CE6D6' : '#E046F0';
  const members = wallets.data?.map((w) => w.address) ?? null;
  const price = lean === 'above' ? m.priceAbove : 1 - m.priceAbove;
  return (
    <section data-component="SignalSpotlight" className="relative mt-7 flex animate-gg-in flex-wrap overflow-hidden rounded-3xl border border-above/[0.22] bg-[radial-gradient(70%_140%_at_100%_50%,rgba(91,44,143,0.42),rgba(14,11,24,0.72)_65%)] transition-colors hover:border-above/45">
      <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-4 p-[clamp(20px,3vw,32px)]">
        <span className="flex items-center gap-2.5 font-mono text-[11px] font-medium uppercase leading-none tracking-[0.08em] text-above">
          <span aria-hidden className="gg-dot" />
          Radar vs market · biggest edge right now
        </span>
        <h2 className="font-display text-[clamp(22px,2.6vw,32px)] font-semibold leading-[1.15] tracking-[-0.02em] text-[#F4F2FA] [text-wrap:balance]">{m.question}</h2>
        <div className="flex flex-wrap items-end gap-x-9 gap-y-5">
          <div className="flex flex-col gap-2">
            <span className="gg-eyebrow">Market · ABOVE</span>
            <span className="font-display text-[40px] font-semibold leading-[0.9] tracking-[-0.03em] text-[#F4F2FA]">{cents(m.priceAbove)}</span>
          </div>
          <div className="flex flex-col gap-2">
            <span className="gg-eyebrow">Radar P(above)</span>
            <span className="gg-flash-target font-display text-[40px] font-semibold leading-[0.9] tracking-[-0.03em]" style={{ color: flash ? '#fff' : leanColor, textShadow: flash ? '0 0 18px rgba(155,107,255,0.9)' : undefined }}>
              {Math.round(p * 100)}%
              <span className="ml-2 font-mono text-sm font-medium tracking-normal text-muted">±{m.radar.ci}</span>
            </span>
          </div>
          <div className="flex flex-col gap-2">
            <span className="gg-eyebrow">Edge on ABOVE</span>
            <span className="font-display text-[40px] font-semibold leading-[0.9] tracking-[-0.03em]" style={{ color: leanColor }}>
              {edgeLabel(edge)}
            </span>
          </div>
        </div>
        <p className="max-w-[560px] text-muted [text-wrap:pretty]">
          {m.radar.n} flagged wallets are positioned in this market. Folding them into the price gives P(above) {Math.round(p * 100)}% against {cents(m.priceAbove)} on the market, so the radar leans {lean.toUpperCase()} and the market still prices {lean.toUpperCase()} at {cents(price)}.
        </p>
        <Link href={`/markets/${m.id}`} className="w-fit text-sm font-semibold text-violet-pale before:absolute before:inset-0 before:content-[''] hover:text-above">
          Open market →
        </Link>
      </div>
      {!mobile ? (
        <div className="relative min-h-[260px] flex-[0_1_400px]">
          <div className="absolute inset-0">
            <WalletGraph data={radar.data} mode="mini" lite={false} market={m.id} members={members} state={radar.isPending ? 'loading' : 'idle'} decorative />
          </div>
        </div>
      ) : null}
    </section>
  );
}
