'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { MarketWalletRow, WalletDetail } from '@groundgraph/sdk/api-types';
import { FEATURE_COLORS, FEATURE_LABELS, FeatureBars, ReasonList, ScoreRing, SybilGuard, scoreColor, scoreVerdict, cn, type FeatureItem } from '@groundgraph/ui';
import { Modal } from '@/components/common/Modal';
import { ErrorState, Skeleton } from '@/components/common/states';
import { cents, fromBase, shortAddr, usd } from '@/lib/format';
import { useCopy } from '@/lib/hooks';
import { api } from '@/lib/api';
import { useUi } from '@/lib/stores';
import { isApiError } from '@/lib/api';
import { useWalletDetail } from '@/lib/queries';
import { explorerAddr } from '@/lib/solana';

const eyebrow = 'font-mono text-[11px] font-medium leading-none tracking-[0.06em] uppercase text-faint';

export interface MarketContext {
  marketId: string;
  priceAbove: number;
  /** The side the radar favors in this market, if any. */
  radarSide: 'above' | 'below' | null;
  row?: MarketWalletRow;
  rank?: number | null;
}

export function contributionItems(d: WalletDetail): FeatureItem[] {
  return [
    { label: FEATURE_LABELS.whaleOverlap, pts: d.contributions.whaleOverlap, value: d.features.whaleOverlap, color: FEATURE_COLORS.whaleOverlap },
    { label: FEATURE_LABELS.entryTiming, pts: d.contributions.entryTiming, value: d.features.entryTiming, color: FEATURE_COLORS.entryTiming },
    { label: FEATURE_LABELS.hitRate, pts: d.contributions.hitRate, value: d.features.hitRate, color: FEATURE_COLORS.hitRate },
    { label: FEATURE_LABELS.centrality, pts: d.contributions.centrality, value: d.features.centrality, color: FEATURE_COLORS.centrality },
    { label: FEATURE_LABELS.leadTime, pts: d.contributions.leadTime, value: Math.min(1, d.features.leadTimeMin / 90), color: FEATURE_COLORS.leadTime },
  ];
}

/** Panel content shared by the market drawer, the radar side panel and the mobile sheets. */
export function WalletDetailBody({ addr, market, onClose, variant }: { addr: string; market?: MarketContext; onClose: () => void; variant: 'market' | 'radar' }) {
  const q = useWalletDetail(addr);
  const [copied, copy] = useCopy();
  const toast = useUi((s) => s.toast);
  const [tracking, setTracking] = useState<boolean | null>(null);
  const [trackBusy, setTrackBusy] = useState(false);
  const toggleTrack = async () => {
    setTrackBusy(true);
    try {
      const r = await api.track(addr);
      setTracking(r.tracking);
      toast({ tone: 'success', title: r.tracking ? `Tracking ${shortAddr(addr)}` : `Stopped tracking ${shortAddr(addr)}` });
    } catch (e) {
      toast({ tone: 'error', title: 'Could not update tracking', body: (e as Error).message });
    } finally {
      setTrackBusy(false);
    }
  };
  const d = q.data;
  const color = d ? scoreColor(d) : '#9A95AE';
  const row = market?.row;
  const nowPrice = row ? (row.side === 'above' ? market!.priceAbove : 1 - market!.priceAbove) : null;
  return (
    <div data-component="WalletDetailPanel" data-variant={variant} className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-2.5">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className={eyebrow}>{market ? `Wallet · rank ${market.rank ?? '–'} in this market` : 'Wallet'}</span>
          <span className="font-mono text-[15px] font-medium leading-[1.2] text-body" title={addr}>
            {shortAddr(addr)}
          </span>
        </div>
        <div className="flex gap-1.5">
          <button type="button" onClick={() => copy(addr)} className="h-8 rounded-lg border border-violet/20 bg-transparent px-2.5 font-mono text-[11px] font-medium text-muted hover:border-violet/50">
            {copied ? 'Copied' : 'Copy'}
          </button>
          <a href={explorerAddr(addr)} target="_blank" rel="noopener noreferrer" className="grid h-8 place-items-center rounded-lg border border-violet/20 px-2.5 font-mono text-[11px] font-medium text-muted hover:border-violet/50">
            Explorer ↗
          </a>
          <button type="button" onClick={onClose} aria-label="Close wallet panel" className="grid h-8 w-8 place-items-center rounded-lg border border-violet/20 bg-transparent text-muted hover:border-violet/50">
            ×
          </button>
        </div>
      </div>

      {q.isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-[88px] rounded-2xl" />
          <Skeleton className="h-24 rounded-2xl" />
          <Skeleton className="h-32 rounded-2xl" />
        </div>
      ) : null}
      {q.isError && isApiError(q.error) && q.error.status === 404 ? (
        <div className="rounded-xl border border-dashed border-violet/20 p-4 text-[13px] leading-[1.5] text-dim">This wallet has no scored profile yet. The radar scores wallets after enough resolved history.</div>
      ) : q.isError ? (
        <ErrorState title="Could not load this wallet" onRetry={() => void q.refetch()} />
      ) : null}

      {d ? (
        <>
          <div className="flex items-center gap-[18px]">
            <ScoreRing score={d.score} color={color} glow={d.smart ? `${color}66` : undefined} />
            <div className="flex min-w-0 flex-col gap-2">
              <span className="font-display text-[17px] font-semibold leading-[1.2]">{scoreVerdict(d)}</span>
              <span className="text-[13px] text-dim">{d.labelHidden ? 'Cluster label hidden' : d.cluster ? d.cluster.name : 'No cluster'}</span>
              {d.tags.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {d.tags.map((t) => (
                    <span key={t} className="rounded-md bg-violet/[0.14] px-2 py-1 font-sans text-[11px] font-medium leading-none text-violet-pale">
                      {t}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          {market ? (
            <div data-component="PositionInMarket" className={cn('flex flex-col gap-3 rounded-[14px] border p-3.5', d.smart ? 'border-above/[0.22] bg-above/5' : 'border-white/[0.06] bg-white/[0.025]')}>
              <div className="flex items-center justify-between">
                <span className={eyebrow}>In this market</span>
                {row ? (
                  <span className={cn('rounded-md px-2 py-1 font-mono text-[11px] font-semibold leading-none', row.side === 'above' ? 'bg-above/10 text-above' : 'bg-below/10 text-below')}>{row.side.toUpperCase()}</span>
                ) : (
                  <span className="font-mono text-[11px] text-faint">Not positioned</span>
                )}
              </div>
              {row ? (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    <Cell k="Size" v={usd(fromBase(row.usdc))} />
                    <Cell k="Entry" v={cents(row.entryPrice)} />
                    <Cell k="Now" v={nowPrice != null ? cents(nowPrice) : 'n/a'} color={nowPrice != null && nowPrice >= row.entryPrice ? '#2CE6D6' : '#E046F0'} />
                  </div>
                  <span className="text-xs leading-[1.45] text-muted">
                    {d.smart ? 'Flagged smart money. ' : 'Crowd wallet. '}
                    {market.radarSide ? (row.side === market.radarSide ? `Sides with the radar's ${market.radarSide.toUpperCase()} lean.` : `Against the radar's ${market.radarSide.toUpperCase()} lean.`) : 'The radar has no lean on this market yet.'}
                  </span>
                </>
              ) : (
                <span className="text-xs text-muted">This wallet holds no position in this market.</span>
              )}
            </div>
          ) : null}

          <div className="flex flex-col gap-2.5">
            <span className={eyebrow}>Why it was flagged</span>
            {d.sybil ? <SybilGuard text="Linked to a cluster of wallets with correlated funding and timing. Its score is discounted so one actor is not counted twice." /> : null}
            {d.reasons.length ? <ReasonList reasons={d.reasons} /> : <span className="text-[13px] text-dim">No flagging reasons recorded. This wallet is part of the crowd.</span>}
          </div>

          <div className="flex flex-col gap-2.5">
            <span className={eyebrow}>Feature breakdown</span>
            <FeatureBars items={contributionItems(d)} />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <Stat v={String(d.stats.markets)} l="Markets" />
            <Stat v={`${Math.round(d.stats.hitRate * 100)}%`} l="Hit rate" color="#2CE6D6" />
            <Stat v={`${d.stats.medianLeadMin} min`} l="Median lead" />
          </div>
          <div className="font-mono text-[11px] leading-[1.4] text-faint">
            Volume {usd(d.stats.volumeUsd)} · model {d.modelVersion}
          </div>

          {variant === 'radar' ? (
            <button type="button" onClick={() => void toggleTrack()} disabled={trackBusy} className="gg-btn gg-btn-primary h-[46px] flex-none rounded-xl text-sm">
              {tracking ? 'Stop tracking this wallet' : 'Track this wallet'}
            </button>
          ) : null}

          {d.openPositions.filter((p) => p.marketId !== market?.marketId).length ? (
            <div className="flex flex-col gap-2">
              <span className={eyebrow}>Other open positions</span>
              {d.openPositions
                .filter((p) => p.marketId !== market?.marketId)
                .slice(0, 5)
                .map((p) => (
                  <Link key={`${p.marketId}-${p.side}`} href={`/markets/${p.marketId}`} className="flex items-center gap-2.5 rounded-[10px] border border-violet/[0.12] p-2.5 text-xs text-ink-2 hover:border-violet/40 hover:text-ink-2">
                    <span className="min-w-0 flex-1">{p.question}</span>
                    <span className={cn('rounded-[5px] px-1.5 py-1 font-mono text-[10px] font-semibold leading-none', p.side === 'above' ? 'bg-above/10 text-above' : 'bg-below/10 text-below')}>{p.side.toUpperCase()}</span>
                    <span className="font-mono text-[11px] text-muted">{cents(p.entryPrice)}</span>
                  </Link>
                ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Cell({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-display text-[15px] font-semibold leading-none" style={{ color: color ?? '#F4F2FA' }}>
        {v}
      </span>
      <span className="font-mono text-[10px] uppercase leading-[1.2] text-faint">{k}</span>
    </div>
  );
}

function Stat({ v, l, color }: { v: string; l: string; color?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-[10px] bg-white/[0.03] p-2.5">
      <span className="font-display text-[15px] font-semibold leading-none" style={{ color }}>
        {v}
      </span>
      <span className="font-mono text-[10px] uppercase leading-none text-faint">{l}</span>
    </div>
  );
}

/** Market detail variant: a right drawer on desktop, a bottom sheet on mobile. */
export function WalletDetailDrawer({ addr, market, onClose }: { addr: string | null; market: MarketContext; onClose: () => void }) {
  if (!addr) return null;
  return (
    <Modal
      open
      onClose={onClose}
      label="Wallet details"
      z={87}
      variant="sheet"
      className="min-[760px]:justify-end"
      scrim="bg-[rgba(4,3,8,0.45)]"
      panelClassName="p-[22px] min-[760px]:h-[calc(100vh-32px)] min-[760px]:w-[400px] min-[760px]:max-h-none"
    >
      <WalletDetailBody addr={addr} market={market} onClose={onClose} variant="market" />
    </Modal>
  );
}
