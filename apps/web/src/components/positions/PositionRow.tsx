'use client';

import { useRef } from 'react';
import Link from 'next/link';
import type { PositionRow } from '@groundgraph/sdk/api-types';
import { OutcomeBadge, SideBadge, TxError, TxStatus, cn } from '@groundgraph/ui';
import { api } from '@/lib/api';
import { cents, fromBase, hoursUntil, leftLabel, pct, signedUsd, txShort, usd } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { alignment, isLive, mergePair, pnlFraction, settledPerShare } from '@/lib/positions';
import { useRefreshAccount } from '@/lib/queries';
import { useUi } from '@/lib/stores';
import { failureCopy } from '@/lib/tx';
import { useTxRunner } from '@/components/wallet/useTxRunner';

const eyebrow = 'font-mono text-[10px] font-medium leading-none tracking-[0.06em] uppercase text-faint';

const ABOVE = '#2CE6D6';
const BELOW = '#E046F0';

function statusBadge(p: PositionRow, now: number): { label: string; tone: 'neutral' | 'violet' | 'above' | 'below' } {
  switch (p.status) {
    case 'open':
      return { label: `Ends in ${leftLabel(hoursUntil(p.endsAt, now))}`, tone: 'violet' };
    case 'trading_closed':
      return { label: 'Trading closed · awaiting result', tone: 'neutral' };
    case 'settled':
      return { label: `Settled ${p.outcome ? p.outcome.toUpperCase() : ''}`.trim(), tone: p.outcome === 'above' ? 'above' : 'below' };
    case 'voided':
      return { label: 'Voided', tone: 'neutral' };
  }
}

/** What a finished redeem or merge shows. The page keeps it: the row itself usually disappears once the list refreshes. */
export interface PositionReceipt {
  id: string;
  title: string;
  sub: string;
  signature: string;
}

/** One held side of one market. Sell and Trade link to the market page, Redeem and Merge are signed from here. */
export function PositionRowCard({ p, all, readOnly, onDone }: { p: PositionRow; all: PositionRow[]; readOnly: boolean; onDone: (r: PositionReceipt) => void }) {
  const now = useNow(30_000);
  const runner = useTxRunner();
  const refresh = useRefreshAccount();
  const toast = useUi((s) => s.toast);
  const last = useRef<'redeem' | 'merge'>('redeem');

  const live = isLive(p);
  const shares = fromBase(p.shares);
  const pnl = fromBase(p.pnl);
  const frac = pnlFraction(p);
  const redeemable = fromBase(p.redeemable);
  const pair = mergePair(p, all);
  const align = live ? alignment(p) : null;
  const settled = settledPerShare(p);
  const closed = shares <= 0;
  const badge = statusBadge(p, now);
  const above = p.side === 'above';
  const href = `/markets/${p.marketId}`;
  const canRedeem = !live && redeemable > 0 && shares > 0;

  const exec = async (kind: 'redeem' | 'merge') => {
    last.current = kind;
    const res = await runner.run((priorityFeeMicroLamports) =>
      kind === 'redeem' ? api.txRedeem({ marketId: p.marketId, side: p.side, amount: p.shares, priorityFeeMicroLamports }) : api.txMerge({ marketId: p.marketId, amount: pair!.amount, priorityFeeMicroLamports }),
    );
    if (res) {
      const title = kind === 'redeem' ? `Redeemed ${usd(redeemable)}` : `Merged into ${usd(pair!.usdc)}`;
      onDone({ id: res.signature, title, sub: kind === 'redeem' ? 'USDC was returned to your wallet.' : 'The complete sets were burned and USDC returned to your wallet.', signature: res.signature });
      refresh(p.marketId);
      toast({ tone: 'success', title, body: txShort(res.signature) });
    }
  };
  const failure = runner.phase.kind === 'error' ? runner.phase.failure : null;
  const copy = failure ? failureCopy(failure) : null;
  const act = (id: string) => {
    if (runner.handleGeneric(id as never)) return;
    if (id === 'retry') void exec(last.current);
    if (id === 'retry_priority') {
      runner.bumpPriority();
      void exec(last.current);
    }
  };

  const cells: { k: string; v: string; color?: string; sub?: string }[] = [
    { k: 'Shares', v: shares.toFixed(2) },
    { k: 'Cost', v: usd(fromBase(p.costBasis)) },
    live ? { k: 'Avg → now', v: `${cents(p.avgPrice)} → ${cents(p.markPrice)}` } : { k: 'Avg → settled', v: closed ? 'Redeemed' : p.status === 'voided' ? `${cents(p.avgPrice)} → refund` : `${cents(p.avgPrice)} → ${settled === 1 ? '$1' : '$0'}` },
    { k: live ? 'Value' : closed ? 'Value left' : 'Payout', v: usd(live ? fromBase(p.value) : closed ? 0 : redeemable) },
    { k: 'P&L', v: signedUsd(pnl), color: pnl >= 0 ? ABOVE : BELOW, sub: frac == null ? undefined : `${frac >= 0 ? '+' : '−'}${Math.abs(Math.round(frac * 100))}%` },
  ];

  return (
    <article
      data-component="PositionRow"
      data-market={p.marketId}
      data-side={p.side}
      data-status={p.status}
      className={cn('flex flex-col gap-3.5 rounded-[18px] border p-4 min-[760px]:p-[18px]', above ? 'border-above/[0.16]' : 'border-below/[0.16]', canRedeem && 'shadow-[0_0_32px_rgba(91,44,143,0.28)]')}
      style={{ background: 'linear-gradient(180deg, rgba(28,22,44,0.55), rgba(14,11,24,0.55))' }}
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <SideBadge side={p.side} />
        <Link href={href} className="min-w-0 flex-[1_1_240px] font-display text-base font-medium leading-[1.3] text-ink hover:text-above">
          {p.question}
        </Link>
        <OutcomeBadge label={badge.label} tone={badge.tone} />
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(112px,1fr))] gap-3">
        {cells.map((c) => (
          <div key={c.k} className="flex min-w-0 flex-col gap-[5px]">
            <span className={eyebrow}>{c.k}</span>
            <span className="font-mono text-sm font-medium leading-[1.2] tabular-nums" style={{ color: c.color ?? '#EDEBF5' }}>
              {c.v}
              {c.sub ? <span className="ml-1.5 text-xs opacity-80">{c.sub}</span> : null}
            </span>
          </div>
        ))}
      </div>

      <div data-component="ScoreContext" className="flex flex-wrap items-center gap-x-[18px] gap-y-2.5 rounded-xl border border-white/5 bg-white/[0.025] px-3.5 py-3 text-[13px]">
        {live ? (
          <>
            <RadarLine p={p} />
            {align && align !== 'building' ? (
              <span
                data-testid="alignment"
                className="rounded-pill border px-2.5 py-1 font-mono text-[11px] font-medium leading-none"
                style={{ color: align === 'with' ? ABOVE : align === 'against' ? '#F6C9FB' : '#9A95AE', borderColor: align === 'with' ? 'rgba(44,230,214,0.3)' : align === 'against' ? 'rgba(224,70,240,0.3)' : 'rgba(255,255,255,0.12)' }}
              >
                {align === 'with' ? 'With smart money' : align === 'against' ? 'Against smart money' : 'No clear lean'}
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-dim">
            {p.status === 'voided'
              ? 'This market was voided because no valid price arrived in time. Every share redeems at $0.50.'
              : closed
                ? 'Fully redeemed.'
                : redeemable > 0
                  ? `Your ${p.side.toUpperCase()} side settled at $1 per share. Redeem to return ${usd(redeemable)} to your wallet.`
                  : `This side settled at $0 per share. Nothing to redeem.`}
          </span>
        )}

        <div className="ml-auto flex flex-wrap gap-2">
          {readOnly ? (
            <span className="font-mono text-[11px] text-faint">View only</span>
          ) : (
            <>
              {live && pair ? (
                <button type="button" data-testid="merge" onClick={() => void exec('merge')} disabled={runner.phase.kind === 'busy'} title={`Burn ${pair.usdc.toFixed(2)} ABOVE and ${pair.usdc.toFixed(2)} BELOW to get ${usd(pair.usdc)} back`} className="gg-btn h-11 rounded-[10px] border border-dashed border-sky/50 bg-sky/[0.06] px-3.5 text-[13px] text-sky min-[760px]:h-10">
                  Merge {usd(pair.usdc)}
                </button>
              ) : null}
              {live ? (
                <Link href={`${href}?side=${p.side}`} className="gg-btn gg-btn-quiet h-11 rounded-[10px] px-3.5 text-[13px] min-[760px]:h-10">
                  Trade
                </Link>
              ) : null}
              {p.status === 'open' && shares > 0 ? (
                <Link href={`${href}?side=${p.side}&tab=sell`} data-testid="sell" className="gg-btn h-11 rounded-[10px] border border-below/30 bg-below/[0.06] px-3.5 text-[13px] text-below-text min-[760px]:h-10">
                  Sell
                </Link>
              ) : null}
              {canRedeem && runner.phase.kind !== 'done' ? (
                <button type="button" data-testid="redeem" onClick={() => void exec('redeem')} disabled={runner.phase.kind === 'busy'} className="gg-btn gg-btn-primary h-11 rounded-[10px] px-4 text-[13px] min-[760px]:h-10">
                  Redeem {usd(redeemable)}
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>

      {runner.phase.kind === 'busy' ? <TxStatus label={runner.phase.p.label} sub={runner.phase.p.sub} progress={runner.phase.p.pct} /> : null}
      {failure && copy ? (
        <TxError
          title={copy.title}
          body={copy.body}
          code={copy.code}
          primary={copy.primary ? { label: copy.primary.label, onClick: () => act(copy.primary!.id) } : undefined}
          secondary={copy.secondary ? { label: copy.secondary.label, onClick: () => act(copy.secondary!.id) } : undefined}
          onDismiss={() => runner.reset()}
        />
      ) : null}
    </article>
  );
}

/** Radar context for a live position. Says so when the radar has no signal instead of inventing one. */
function RadarLine({ p }: { p: PositionRow }) {
  const r = p.radar;
  if (r.state !== 'ready' || r.p == null) {
    return (
      <span className="flex items-center gap-2 text-dim">
        <span aria-hidden className="h-2 w-2 flex-none rounded-full bg-faint" />
        Radar signal still building for this market
      </span>
    );
  }
  const edge = r.edge ?? 0;
  const color = edge === 0 ? '#9A95AE' : edge > 0 ? ABOVE : BELOW;
  return (
    <>
      <span className="flex items-center gap-2 text-ink-2">
        <span aria-hidden className="h-2 w-2 flex-none rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
        Radar {pct(r.p)} ABOVE{r.ci != null ? ` ±${Math.round(r.ci)}` : ''} · {r.n} flagged {r.n === 1 ? 'wallet' : 'wallets'}
      </span>
      <span className="font-mono text-xs" style={{ color }}>
        {edge >= 0 ? '+' : '−'}
        {Math.abs(edge)}¢ vs market
      </span>
    </>
  );
}
