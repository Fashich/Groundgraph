'use client';

import { useMemo } from 'react';
import Image from 'next/image';
import type { MarketDetail } from '@groundgraph/sdk/api-types';
import { Modal, ModalHeader } from '@/components/common/Modal';
import { cents } from '@/lib/format';
import { useCopy } from '@/lib/hooks';
import { blinkUrl, marketUrl } from '@/lib/market';
import { sparkPath } from '@groundgraph/ui';

function CopyField({ k, v }: { k: string; v: string }) {
  const [done, copy] = useCopy();
  return (
    <div className="flex min-h-12 items-center gap-2 rounded-xl border border-violet/20 bg-bg/50 py-0 pl-3.5 pr-1.5">
      <span className="w-[42px] flex-none font-mono text-[10px] font-medium leading-none tracking-[0.06em] text-faint">{k}</span>
      <input readOnly value={v} aria-label={k === 'BLINK' ? 'Blink link' : 'Market link'} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap border-0 bg-transparent font-mono text-xs font-medium text-body outline-none" />
      <button type="button" onClick={() => copy(v)} className="h-[38px] flex-none rounded-[9px] border border-violet/[0.24] bg-violet/[0.08] px-3 font-sans text-xs font-semibold text-violet-pale hover:border-violet/50">
        {done ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function ShareModal({ m, onClose }: { m: MarketDetail; onClose: () => void }) {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const blink = blinkUrl(origin, m.id);
  const link = marketUrl(origin, m.id);
  const line = useMemo(() => sparkPath(m.history.points.map((p) => p.priceAbove), 800, 240, 4).line, [m.history.points]);
  const ready = m.radar.state === 'ready' && m.radar.p != null;
  const tweet = `https://twitter.com/intent/tweet?text=${encodeURIComponent(`${m.question} ABOVE ${cents(m.priceAbove)}`)}&url=${encodeURIComponent(blink)}`;
  return (
    <Modal open onClose={onClose} label="Share as a Blink" z={92} variant="sheet" panelClassName="max-w-[560px] p-[22px] pb-[calc(22px+env(safe-area-inset-bottom))] flex flex-col gap-4" data-component="ShareModal">
      <ModalHeader title="Share as a Blink" sub="People can take an Above or Below position right inside X, Discord or any Blink-aware wallet." onClose={onClose} />
      <div data-component="ShareCard" className="relative flex aspect-[1.91/1] flex-col justify-between gap-2 overflow-hidden rounded-2xl border border-violet/30 p-[clamp(12px,3vw,20px)]" style={{ background: 'radial-gradient(80% 120% at 85% 15%,rgba(91,44,143,0.7),#0B0914 70%)' }}>
        {line ? (
          <svg viewBox="0 0 800 240" preserveAspectRatio="none" className="absolute bottom-0 left-0 h-[46%] w-full opacity-50" aria-hidden>
            <path d={line} fill="none" stroke="#2CE6D6" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </svg>
        ) : null}
        <div className="relative flex items-center gap-2">
          <Image src="/gg-icon.png" alt="" width={22} height={22} className="rounded-md" />
          <span className="font-display text-[13px] font-semibold leading-none">Groundgraph</span>
          <span className="ml-auto font-mono text-[9px] font-medium leading-none tracking-[0.08em] text-muted">SOLANA DEVNET</span>
        </div>
        <span className="relative max-w-[88%] font-display text-[clamp(14px,3.2vw,20px)] font-semibold leading-[1.2] text-ink [text-wrap:balance]">{m.question}</span>
        <div className="relative flex flex-wrap items-end gap-x-[18px] gap-y-2">
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[9px] font-medium leading-none text-muted">ABOVE</span>
            <span className="font-display text-[clamp(20px,5vw,30px)] font-semibold leading-none">{cents(m.priceAbove)}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[9px] font-medium leading-none text-muted">RADAR P(ABOVE)</span>
            <span className="font-display text-[clamp(20px,5vw,30px)] font-semibold leading-none text-above">{ready ? `${Math.round((m.radar.p as number) * 100)}%` : 'Building'}</span>
          </div>
          <div className="ml-auto flex gap-1.5">
            <span className="rounded-lg border border-above/40 bg-above/[0.18] px-3 py-[7px] font-sans text-[11px] font-semibold leading-none text-above-text">Buy ABOVE</span>
            <span className="rounded-lg border border-below/40 bg-below/[0.18] px-3 py-[7px] font-sans text-[11px] font-semibold leading-none text-below-text">Buy BELOW</span>
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <CopyField k="BLINK" v={blink} />
        <CopyField k="LINK" v={link} />
      </div>
      <a href={tweet} target="_blank" rel="noopener noreferrer" className="gg-btn gg-btn-primary h-12 rounded-xl text-sm text-white hover:text-white">
        Post on X →
      </a>
    </Modal>
  );
}
