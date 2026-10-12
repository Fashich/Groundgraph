'use client';

import type { MarketDetail, PositionRow, Side } from '@groundgraph/sdk/api-types';
import { TradeReceipt, TxError, TxStatus, cn } from '@groundgraph/ui';
import Link from 'next/link';
import { api } from '@/lib/api';
import { cents, fromBase, signedUsd, txShort, usd } from '@/lib/format';
import { radarFavors } from '@/lib/market';
import { explorerTx } from '@/lib/solana';
import { failureCopy } from '@/lib/tx';
import { useRefreshAccount } from '@/lib/queries';
import { useUi } from '@/lib/stores';
import { useTxRunner } from '@/components/wallet/useTxRunner';

const eyebrow = 'font-mono text-[10px] font-medium leading-none tracking-[0.06em] uppercase text-faint';

export function YourPosition({ m, positions, onSell, onAddMore }: { m: MarketDetail; positions: PositionRow[]; onSell: (side: Side, shares: number) => void; onAddMore: (side: Side) => void }) {
  if (positions.length === 0) return null;
  return (
    <div className="flex flex-col gap-5">
      {positions.map((p) => (
        <PositionCard key={`${p.marketId}-${p.side}`} m={m} p={p} onSell={onSell} onAddMore={onAddMore} />
      ))}
    </div>
  );
}

function PositionCard({ m, p, onSell, onAddMore }: { m: MarketDetail; p: PositionRow; onSell: (s: Side, n: number) => void; onAddMore: (s: Side) => void }) {
  const runner = useTxRunner();
  const refresh = useRefreshAccount();
  const toast = useUi((s) => s.toast);
  const shares = fromBase(p.shares);
  const pnl = fromBase(p.pnl);
  const redeemable = fromBase(p.redeemable);
  const open = p.status === 'open';
  const favors = radarFavors(m.radar.state === 'ready' ? m.radar.edge : null);
  const withSmart = favors === p.side;
  const above = p.side === 'above';
  const failure = runner.phase.kind === 'error' ? runner.phase.failure : null;
  const copy = failure ? failureCopy(failure) : null;

  const redeem = async () => {
    const res = await runner.run((priorityFeeMicroLamports) => api.txRedeem({ marketId: p.marketId, side: p.side, amount: p.shares, priorityFeeMicroLamports }));
    if (res) {
      refresh(p.marketId);
      toast({ tone: 'success', title: `Redeemed ${usd(redeemable)}`, body: txShort(res.signature) });
    }
  };
  const act = (id: string) => {
    if (runner.handleGeneric(id as never)) return;
    if (id === 'retry') void redeem();
    if (id === 'retry_priority') {
      runner.bumpPriority();
      void redeem();
    }
  };

  const cells = [
    { k: 'Shares', v: shares.toFixed(2) },
    { k: 'Avg → now', v: open ? `${cents(p.avgPrice)} → ${cents(p.markPrice)}` : `${cents(p.avgPrice)} → ${p.outcome === p.side ? '$1' : '$0'}` },
    { k: open ? 'Value' : 'Settled value', v: usd(fromBase(p.value)) },
    { k: 'P&L', v: signedUsd(pnl), color: pnl >= 0 ? '#2CE6D6' : '#E046F0' },
  ];
  return (
    <section data-component="YourPosition" aria-label={`Your ${p.side.toUpperCase()} position`} className="flex animate-gg-in flex-col gap-3.5 rounded-[22px] border border-above/20 p-5" style={{ background: 'var(--gg-surface)' }}>
      <div className="flex items-center justify-between">
        <span className="font-display text-[15px] font-semibold leading-none">Your position</span>
        <span className={cn('rounded-md px-2 py-1 font-mono text-[11px] font-semibold leading-none', above ? 'bg-above/10 text-above' : 'bg-below/10 text-below')}>{p.side.toUpperCase()}</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {cells.map((c) => (
          <div key={c.k} className="flex flex-col gap-1">
            <span className={eyebrow}>{c.k}</span>
            <span className="font-mono text-sm font-medium leading-[1.2]" style={{ color: c.color ?? '#EDEBF5' }}>
              {c.v}
            </span>
          </div>
        ))}
      </div>
      {open ? (
        <>
          <div className="flex items-center gap-2 text-xs" style={{ color: withSmart ? '#2CE6D6' : '#F6C9FB' }}>
            <span aria-hidden className="h-1.5 w-1.5 flex-none rounded-full" style={{ background: withSmart ? '#2CE6D6' : '#F6C9FB' }} />
            {m.radar.state !== 'ready' || m.radar.p == null ? 'Radar signal still building' : withSmart ? `With smart money · radar ${Math.round(m.radar.p * 100)}%` : favors ? `Against smart money · radar favors ${favors.toUpperCase()}` : 'Radar has no lean yet'}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => onSell(p.side, shares)} className="gg-btn h-11 flex-1 rounded-[10px] border border-below/30 bg-below/[0.06] text-[13px] text-below-text min-[760px]:h-10">
              Sell
            </button>
            <button type="button" onClick={() => onAddMore(p.side)} className="gg-btn gg-btn-quiet h-11 flex-1 rounded-[10px] text-[13px] min-[760px]:h-10">
              Add more
            </button>
          </div>
        </>
      ) : (
        <>
          {redeemable > 0 && runner.phase.kind !== 'done' ? (
            <button type="button" data-testid="redeem" onClick={() => void redeem()} disabled={runner.phase.kind === 'busy'} className="gg-btn gg-btn-primary h-11 rounded-[10px] text-sm">
              Redeem {usd(redeemable)}
            </button>
          ) : redeemable <= 0 && runner.phase.kind !== 'done' ? (
            <span className="text-xs text-dim">{p.outcome && p.outcome !== p.side ? `Settled ${p.outcome.toUpperCase()}. This side settled at $0, nothing to redeem.` : 'Nothing to redeem.'}</span>
          ) : null}
          {runner.phase.kind === 'busy' ? <TxStatus label={runner.phase.p.label} sub={runner.phase.p.sub} progress={runner.phase.p.pct} /> : null}
          {failure && copy ? (
            <TxError title={copy.title} body={copy.body} code={copy.code} primary={copy.primary ? { label: copy.primary.label, onClick: () => act(copy.primary!.id) } : undefined} onDismiss={() => runner.reset()} />
          ) : null}
          {runner.phase.kind === 'done' ? (
            <TradeReceipt
              title={`Redeemed ${usd(redeemable)}`}
              sub="USDC was returned to your wallet."
              footer={
                <>
                  <a href={explorerTx(runner.phase.signature)} target="_blank" rel="noopener noreferrer" className="text-faint hover:text-above">
                    tx {txShort(runner.phase.signature)} ↗
                  </a>
                  <Link href="/positions">View positions →</Link>
                </>
              }
            />
          ) : null}
        </>
      )}
    </section>
  );
}
