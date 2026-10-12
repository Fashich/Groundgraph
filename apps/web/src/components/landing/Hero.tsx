'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, LiveDot, cn, scoreColor, scoreVerdict } from '@groundgraph/ui';
import { WalletGraph } from '@/components/graph/WalletGraph';
import { useIsMobile, useMedia } from '@/lib/hooks';
import { DEFAULT_FILTERS, useMarkets, useRadar, useSession, useTrackRecord, useWalletDetail } from '@/lib/queries';
import { graphStats, signalMarkets } from '@/lib/landing';
import { cents, edgeLabel, shortAddr } from '@/lib/format';
import { useUi, useNet } from '@/lib/stores';
import { useChannel } from '@/components/live-provider';

function HeroStats() {
  const radar = useRadar();
  const track = useTrackRecord();
  const s = graphStats(radar.data);
  const med = track.data?.state === 'ready' ? track.data.medianLeadMin : null;
  const stats = [
    { v: s ? String(s.wallets) : '-', l: 'Wallets scored' },
    { v: s ? String(s.smart) : '-', l: 'Flagged smart money' },
    { v: med != null ? `${med} min` : track.isPending ? '-' : 'Building', l: 'Median lead time' },
  ];
  return (
    <div className="pointer-events-none flex flex-wrap gap-7 pt-3">
      {stats.map((x) => (
        <div key={x.l} className="flex flex-col gap-1">
          <span className="font-display text-[26px] font-semibold leading-none tracking-[-0.02em] text-[#F4F2FA]">{x.v}</span>
          <span className="gg-eyebrow !leading-[1.3]">{x.l}</span>
        </div>
      ))}
    </div>
  );
}

export function SignalFeed() {
  const q = useMarkets({ ...DEFAULT_FILTERS, sort: 'gap' });
  const ws = useNet((s) => s.ws);
  useChannel('markets:summary');
  const rows = signalMarkets(q.data?.pages.flatMap((p) => p.items) ?? [], 3);
  return (
    <div data-component="SignalFeed" className="absolute bottom-10 right-[clamp(16px,3vw,40px)] flex w-[330px] flex-col gap-3 rounded-2xl border border-violet/[0.18] bg-panel-2/70 p-4 backdrop-blur-[14px]">
      <div className="flex items-center justify-between font-mono text-[11px] font-medium uppercase leading-none tracking-[0.08em] text-faint">
        <span>Radar signals</span>
        <span className={ws === 'open' ? 'text-above' : 'text-dim'}>{ws === 'open' ? '● streaming' : '● polling'}</span>
      </div>
      {q.isPending ? <div className="gg-skeleton h-24" aria-hidden /> : null}
      {!q.isPending && rows.length === 0 ? <p className="text-[13px] leading-[1.45] text-dim">No market has enough flagged wallet activity yet. Signals appear here as soon as the radar is ready.</p> : null}
      {rows.map((m, k) => {
        const edge = m.radar.edge ?? 0;
        const color = edge >= 0 ? '#2CE6D6' : '#E046F0';
        return (
          <Link key={m.id} href={`/markets/${m.id}`} className="flex items-start gap-3 text-body transition-opacity hover:text-body" style={{ opacity: 1 - k * 0.2 }}>
            <span aria-hidden className="mt-[5px] h-2 w-2 flex-none rounded-full" style={{ background: color, boxShadow: `0 0 10px ${color}` }} />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13px] leading-[1.4] text-[#E4E1EF]">
                {m.radar.n} flagged wallets lean {edge >= 0 ? 'ABOVE' : 'BELOW'} on {m.assetSymbol}
              </span>
              <span className="font-mono text-[11px] leading-none text-faint">
                radar {Math.round((m.radar.p ?? 0) * 100)}% vs market {cents(m.priceAbove)} · {edgeLabel(edge)}
              </span>
            </span>
          </Link>
        );
      })}
    </div>
  );
}

export function WalletPeek({ addr, onClose }: { addr: string; onClose: () => void }) {
  const { data: session } = useSession();
  const openWallet = useUi((s) => s.openWallet);
  const q = useWalletDetail(addr);
  const w = q.data;
  const color = w ? scoreColor(w) : '#9A95AE';
  return (
    <div data-component="WalletPeek" role="region" aria-label="Wallet peek" className="absolute right-[clamp(16px,3vw,40px)] top-14 z-[3] flex w-[min(320px,calc(100%-32px))] animate-gg-sheet flex-col gap-3.5 rounded-[18px] border border-above/25 bg-panel-2/85 p-[18px] shadow-[0_24px_60px_rgba(0,0,0,0.5)] backdrop-blur-xl">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[13px] font-medium leading-none text-ink" title={addr}>
            {shortAddr(addr)}
          </span>
          <span className="text-xs text-dim">{w ? `${w.cluster?.name ?? 'Unclustered'} · ${scoreVerdict(w)}` : q.isError ? 'No score available for this wallet' : 'Loading'}</span>
        </div>
        <span className="font-display text-[34px] font-semibold leading-none" style={{ color }}>
          {w ? w.score : '-'}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {(w?.reasons ?? []).slice(0, 3).map((r, i) => (
          <div key={i} className="flex gap-2.5 text-[13px] leading-[1.4] text-ink-2">
            <span className="font-mono text-[11px] leading-[1.6] text-violet">0{i + 1}</span>
            {r}
          </div>
        ))}
        {q.isPending ? <div className="gg-skeleton h-16" aria-hidden /> : null}
      </div>
      <div className="flex gap-2">
        {session ? (
          <Link href={`/radar?wallet=${addr}`} className="gg-btn gg-btn-primary h-[38px] flex-1 rounded-[10px] text-[13px] text-white hover:text-white">
            Open in Radar
          </Link>
        ) : (
          <Button size="sm" className="h-[38px] flex-1 rounded-[10px]" onClick={() => openWallet(`/radar?wallet=${addr}`)}>
            Connect to open in Radar
          </Button>
        )}
        <Button variant="quiet" size="sm" className="h-[38px] rounded-[10px] border-white/[0.14] text-muted" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

export function Hero() {
  const { data: session } = useSession();
  const openWallet = useUi((s) => s.openWallet);
  const radar = useRadar();
  const mobile = useIsMobile();
  const wide = useMedia('(min-width: 1101px)');
  const stacked = useMedia('(max-width: 900px)');
  const [sel, setSel] = useState<string | null>(null);

  return (
    <section data-component="Hero" className="relative flex min-h-[calc(100vh-64px)] items-center overflow-hidden px-[clamp(16px,4vw,40px)] py-[clamp(32px,6vw,80px)]">
      <div aria-hidden className="absolute inset-0 bg-[radial-gradient(55%_60%_at_68%_45%,rgba(91,44,143,0.38),transparent_70%),radial-gradient(30%_35%_at_85%_18%,rgba(44,230,214,0.07),transparent_70%)]" />
      <div className="absolute inset-0">
        <WalletGraph data={radar.data} mode="hero" lite={mobile} state={radar.isPending ? 'loading' : radar.data && radar.data.nodes.length === 0 ? 'empty' : 'idle'} selected={sel} onSelect={setSel} decorative />
      </div>
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-[180px] bg-gradient-to-b from-transparent to-bg" />
      <div className={cn('pointer-events-none relative mx-auto w-full max-w-[1240px]', stacked ? 'pt-[34vh]' : 'pt-0')}>
        <div className="flex max-w-[640px] flex-col items-start gap-6">
          <div className="inline-flex w-fit items-center gap-2.5 rounded-pill border border-above/[0.22] bg-above/5 py-[7px] pl-2.5 pr-3.5 font-mono text-xs font-medium leading-none tracking-[0.04em] text-above-text">
            <LiveDot />
            Price markets × smart money radar
          </div>
          <h1 className="font-display text-[clamp(42px,6.6vw,92px)] font-semibold leading-[0.98] tracking-[-0.04em] text-[#F4F2FA] [text-wrap:balance]">
            See <span className="gg-text-gradient">smart money</span> move before the market does.
          </h1>
          <p className="max-w-[540px] text-[clamp(16px,1.4vw,19px)] leading-[1.6] text-muted [text-wrap:pretty]">
            Take Above or Below positions on crypto prices, to express a view or hedge what you hold, with a graph-learned radar built in. Every price comes with a readable signal: which wallets are positioned, how early they usually are, and exactly why they were flagged.
          </p>
          <div className="pointer-events-auto flex flex-wrap gap-3">
            {session ? (
              <Link href="/markets" className="gg-btn gg-btn-primary h-[52px] px-[26px] text-base text-white hover:text-white shadow-[0_0_40px_rgba(91,44,143,0.6),inset_0_1px_0_rgba(255,255,255,0.15)]">
                Explore markets →
              </Link>
            ) : (
              <Button variant="primary" size="xl" onClick={() => openWallet('/markets')} className="shadow-[0_0_40px_rgba(91,44,143,0.6),inset_0_1px_0_rgba(255,255,255,0.15)]">
                Explore markets →
              </Button>
            )}
            {session ? (
              <Link href="/radar" className="gg-btn h-[52px] border-white/[0.18] bg-white/[0.03] px-6 text-base backdrop-blur-lg hover:border-above/50 hover:bg-above/[0.06]">
                Open the Radar
              </Link>
            ) : (
              <Button variant="plain" size="xl" onClick={() => openWallet()} className="border-white/[0.18] bg-white/[0.03] px-6 backdrop-blur-lg hover:border-above/50 hover:bg-above/[0.06]">
                Connect wallet
              </Button>
            )}
          </div>
          <HeroStats />
        </div>
      </div>
      {wide && !sel ? (
        <>
          <SignalFeed />
          <div className="pointer-events-none absolute right-[clamp(16px,3vw,40px)] top-7 font-mono text-[11px] font-medium leading-none tracking-[0.06em] text-faint">HOVER A NODE TO READ ITS SCORE ↗</div>
        </>
      ) : null}
      {sel ? <WalletPeek addr={sel} onClose={() => setSel(null)} /> : null}
    </section>
  );
}
