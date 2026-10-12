'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { MarketDetail, PositionRow, Side } from '@groundgraph/sdk/api-types';
import { Segmented, TradeReceipt, TxError, TxStatus, cn } from '@groundgraph/ui';
import { api } from '@/lib/api';
import { cents, fromBase, toBase, txShort, usd } from '@/lib/format';
import { useDebounced, useUsdcBalance } from '@/lib/hooks';
import { MIN_TRADE_USDC, SLIPPAGE_OPTIONS, bpsPct, largeVsBalance, parseAmount, radarFavors, type TradeTab } from '@/lib/market';
import { useMe, useQuote, useRefreshAccount } from '@/lib/queries';
import { explorerTx } from '@/lib/solana';
import { TxFailure, failureCopy, toFailure } from '@/lib/tx';
import { useUi } from '@/lib/stores';
import { FaucetButton } from '@/components/wallet/FaucetButton';
import { useTxRunner } from '@/components/wallet/useTxRunner';
import { useWalletFlow } from '@/components/wallet/flow';
import { statusLabel } from '@/components/markets/MarketCard';

export interface TradeDraft {
  tab: TradeTab;
  side: Side;
  amount: string;
  slip: number;
}

const eyebrow = 'font-mono text-[11px] font-medium leading-none tracking-[0.06em] uppercase text-faint';
const sideWord = (s: Side) => s.toUpperCase();

export function sharesHeld(positions: PositionRow[] | undefined, side: Side): number {
  return (positions ?? []).filter((p) => p.side === side).reduce((a, p) => a + fromBase(p.shares), 0);
}

function fmtInput(n: number): string {
  return (Math.floor(n * 100) / 100).toFixed(2).replace(/\.00$/, '');
}

export function TradePanel({
  m,
  draft,
  setDraft,
  positions,
  onCloseSheet,
}: {
  m: MarketDetail;
  draft: TradeDraft;
  setDraft: (p: Partial<TradeDraft>) => void;
  positions: PositionRow[] | undefined;
  /** Present when rendered inside the mobile bottom sheet. */
  onCloseSheet?: () => void;
}) {
  const runner = useTxRunner();
  const { signer } = runner;
  const flow = useWalletFlow();
  const openWallet = useUi((s) => s.openWallet);
  const toast = useUi((s) => s.toast);
  const refresh = useRefreshAccount();
  const open = m.status === 'open';
  const signing = signer.isSign;
  const me = useMe(!!signer.session);
  const bal = useUsdcBalance(signer.wallet, signing);
  const balUsdc = bal.data != null ? fromBase(bal.data) : null;
  const { tab, side } = draft;
  const dir = tab === 'sell' ? 'sell' : 'buy';
  const heldA = sharesHeld(positions, 'above');
  const heldB = sharesHeld(positions, 'below');
  const held = side === 'above' ? heldA : heldB;
  const mergeable = Math.min(heldA, heldB);
  const amt = parseAmount(draft.amount);
  const debounced = useDebounced(draft.amount, 280);
  const base = toBase(debounced);
  const valid = amt != null && amt > 0;
  const stale = m.oracle.stale;
  const breakUntil = me.data?.settings.breakUntil;
  const onBreak = !!breakUntil && new Date(breakUntil).getTime() > Date.now();
  const quoteOn = open && signing !== undefined && valid && tab !== 'merge' && base != null && base !== '0' && (tab === 'sell' || amt >= MIN_TRADE_USDC);
  const quote = useQuote({ marketId: m.id, side, dir, amount: base, slippageBps: draft.slip }, quoteOn);
  const q = quoteOn ? quote.data : undefined;
  const quoteFailure = quoteOn && quote.isError ? toFailure(quote.error) : null;
  const price = side === 'above' ? m.priceAbove : 1 - m.priceAbove;
  const priceFlash = useFlashLocal(price);

  // Preselect the side that the user actually holds when selling.
  useEffect(() => {
    if (tab === 'sell' && held <= 0 && (side === 'above' ? heldB : heldA) > 0) setDraft({ side: side === 'above' ? 'below' : 'above' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, heldA, heldB]);

  const favors = radarFavors(m.radar.state === 'ready' ? m.radar.edge : null);
  const aligned = favors === side;

  /* ---- derived state for the CTA ---- */
  const exceedsHeld = tab === 'sell' && amt != null && amt > held + 1e-6;
  const exceedsMerge = tab === 'merge' && amt != null && amt > mergeable + 1e-6;
  const exceedsBalance = tab === 'buy' && amt != null && balUsdc != null && amt > balUsdc + 1e-9;
  const belowMin = tab === 'buy' && amt != null && amt > 0 && amt < MIN_TRADE_USDC;
  const riskPct = tab === 'buy' && amt != null ? largeVsBalance(amt, balUsdc) : null;
  const serverLarge = q?.warnings.includes('large_vs_balance') && riskPct == null;
  const limit = me.data?.settings.dailyLimitUsdc ? fromBase(me.data.settings.dailyLimitUsdc) : null;
  const spent = me.data ? fromBase(me.data.settings.spentToday) : 0;
  const overLimit = tab === 'buy' && limit != null && amt != null && spent + amt > limit + 1e-9;
  const busy = runner.phase.kind === 'busy';

  type Cta = { label: string; disabled: boolean; action: 'trade' | 'connect' | 'reconnect' | 'none' };
  const cta: Cta = (() => {
    if (!open) return { label: 'Trading closed', disabled: true, action: 'none' };
    if (signer.loading) return { label: 'Checking session', disabled: true, action: 'none' };
    if (!signer.session) return { label: 'Connect wallet to trade', disabled: false, action: 'connect' };
    if (signer.isView) return { label: 'View-only · connect a signing wallet', disabled: false, action: 'connect' };
    if (signer.needsReconnect) return { label: 'Reconnect wallet to trade', disabled: false, action: 'reconnect' };
    if (tab === 'buy' && stale) return { label: 'Trading paused · oracle stale', disabled: true, action: 'none' };
    if (tab === 'buy' && onBreak) return { label: 'On a break · buying paused', disabled: true, action: 'none' };
    if (!valid) return { label: tab === 'merge' ? 'Enter sets to merge' : 'Enter an amount', disabled: true, action: 'none' };
    if (belowMin) return { label: `Minimum trade is ${MIN_TRADE_USDC} USDC`, disabled: true, action: 'none' };
    if (tab === 'sell' && held <= 0) return { label: `No ${sideWord(side)} shares to sell`, disabled: true, action: 'none' };
    if (exceedsHeld) return { label: `You hold ${held.toFixed(2)} ${sideWord(side)}`, disabled: true, action: 'none' };
    if (tab === 'merge' && mergeable <= 0) return { label: 'Hold both sides to merge', disabled: true, action: 'none' };
    if (exceedsMerge) return { label: `Up to ${mergeable.toFixed(2)} sets`, disabled: true, action: 'none' };
    if (exceedsBalance) return { label: 'Not enough USDC', disabled: true, action: 'none' };
    if (tab === 'buy') return { label: `Buy ${sideWord(side)} · ${usd(amt ?? 0)}`, disabled: busy, action: 'trade' };
    if (tab === 'sell') return { label: `Sell ${(amt ?? 0).toFixed(2)} ${sideWord(side)}${q ? ` · ${usd(fromBase(q.amountOut))}` : ''}`, disabled: busy, action: 'trade' };
    return { label: `Merge ${(amt ?? 0).toFixed(2)} sets · ${usd(amt ?? 0)}`, disabled: busy, action: 'trade' };
  })();

  /* ---- execution ---- */
  const exec = async (over?: { slip?: number; amount?: string }) => {
    const text = over?.amount ?? draft.amount;
    const b = toBase(text);
    if (!b) return;
    const slip = over?.slip ?? draft.slip;
    const res = await runner.run((priorityFeeMicroLamports) => {
      const common = { marketId: m.id, slippageBps: slip, priorityFeeMicroLamports };
      if (tab === 'buy') return api.txBuy({ ...common, side, amount: b });
      if (tab === 'sell') return api.txSell({ ...common, side, amount: b });
      return api.txMerge({ ...common, amount: b });
    });
    if (res) {
      refresh(m.id);
      window.setTimeout(() => refresh(m.id), 2500);
      const summary = receiptText(tab, side, res.tx.receipt, text);
      toast({ tone: 'success', title: summary.title, body: txShort(res.signature) });
      if (tab !== 'buy') setDraft({ amount: '' });
    }
  };

  const onCta = () => {
    if (cta.action === 'connect') {
      openWallet(typeof window !== 'undefined' ? window.location.pathname + window.location.search : null);
      return;
    }
    if (cta.action === 'reconnect') {
      void flow.reconnectSigner();
      return;
    }
    if (cta.action === 'trade') void exec();
  };

  const onAction = (id: string) => {
    if (runner.handleGeneric(id as never)) return;
    if (id === 'retry') void exec();
    else if (id === 'retry_priority') {
      runner.bumpPriority();
      void exec();
    } else if (id === 'slippage2') {
      setDraft({ slip: 200 });
      void exec({ slip: 200 });
    } else if (id === 'halve') {
      const next = fmtInput((amt ?? 0) / 2);
      setDraft({ amount: next });
      runner.reset();
    } else if (id === 'refresh') {
      refresh(m.id);
      runner.reset();
    }
  };

  const failure = runner.phase.kind === 'error' ? runner.phase.failure : null;
  const failCopy = failure ? failureCopy(failure, { slippageBps: draft.slip, breakUntil, dailyLimit: me.data?.settings.dailyLimitUsdc }) : null;

  /* ---- presets ---- */
  const presets = useMemo(() => {
    if (tab === 'buy') return [10, 50, 100, 500].map((v) => ({ label: `$${v}`, value: String(v) }));
    const cap = tab === 'sell' ? held : mergeable;
    return [
      { label: '25%', value: fmtInput(cap * 0.25) },
      { label: '50%', value: fmtInput(cap * 0.5) },
      { label: '75%', value: fmtInput(cap * 0.75) },
      { label: 'Max', value: fmtInput(cap) },
    ];
  }, [tab, held, mergeable]);

  const tradeRows: { k: string; v: string; color?: string }[] = (() => {
    const dash = '–';
    const feeK = `Fee (${q ? bpsPct(q.feeBps) : bpsPct(m.feeBpsNow)}${m.dynamicFee ? ' dynamic' : ''})`;
    const impact = q ? `${(q.priceImpactBps / 100).toFixed(2)}%` : dash;
    const impactColor = q && q.priceImpactBps > draft.slip ? '#E046F0' : undefined;
    if (tab === 'merge') {
      return [
        { k: 'You give', v: valid ? `${(amt ?? 0).toFixed(2)} ABOVE + ${(amt ?? 0).toFixed(2)} BELOW` : dash },
        { k: 'You receive', v: valid ? usd(amt ?? 0) : dash },
        { k: 'Fee', v: '$0.00' },
      ];
    }
    if (tab === 'sell') {
      return [
        { k: 'Est. proceeds', v: q ? usd(fromBase(q.amountOut)) : dash },
        { k: 'Avg. price', v: q ? cents(q.avgPrice) : dash },
        { k: 'Price impact', v: impact, color: impactColor },
        { k: feeK, v: q ? usd(fromBase(q.feeUsdc)) : dash },
        { k: 'Remaining', v: valid && !exceedsHeld ? `${Math.max(0, held - (amt ?? 0)).toFixed(2)} sh` : dash, color: '#B9B4CC' },
      ];
    }
    return [
      { k: 'Est. shares', v: q ? fromBase(q.amountOut).toFixed(2) : dash },
      { k: 'Avg. price', v: q ? cents(q.avgPrice) : dash },
      { k: 'Price impact', v: impact, color: impactColor },
      { k: feeK, v: q ? usd(fromBase(q.feeUsdc)) : dash },
      { k: `Settles at $1 if ${sideWord(side)}`, v: q?.settleValue ? usd(fromBase(q.settleValue)) : dash, color: side === 'above' ? '#2CE6D6' : '#E046F0' },
    ];
  })();

  const tabOptions: { value: TradeTab; label: string }[] = [
    { value: 'buy', label: 'Buy' },
    { value: 'sell', label: 'Sell' },
  ];
  if (mergeable > 0 || tab === 'merge') tabOptions.push({ value: 'merge', label: 'Merge' });

  const showFaucet = tab === 'buy' && signing && bal.data === '0';

  return (
    <section
      data-component="TradePanel"
      aria-label="Trade"
      className="flex flex-col gap-[18px] rounded-3xl border border-violet/[0.24] p-[22px] shadow-[0_24px_60px_rgba(0,0,0,0.35)]"
      style={{ background: 'var(--gg-surface-strong)' }}
    >
      {onCloseSheet ? (
        <div className="flex items-center justify-between">
          <span className="font-display text-[17px] font-semibold leading-none">Trade</span>
          <button type="button" onClick={onCloseSheet} aria-label="Close trade panel" className="gg-btn-icon h-11 w-11 text-base">
            ×
          </button>
        </div>
      ) : null}

      {!open ? (
        <div role="status" className="rounded-[14px] border border-violet/20 bg-violet/[0.06] p-4 text-[13px] leading-normal text-ink-2">
          <b className="font-display text-[15px] text-ink">{statusLabel(m) ?? 'Trading closed'}</b>
          <p className="mt-1.5">{m.status === 'settled' ? 'This market has settled. Each share settled at $1 or $0. Redeem from Your position or Positions.' : m.status === 'voided' ? 'This market was voided. Redeem your shares for their cost from Positions.' : 'Trading has closed while the oracle price is read. The market settles shortly.'}</p>
        </div>
      ) : (
        <>
          <Segmented<TradeTab> ariaLabel="Trade type" role="tablist" value={tab} onChange={(t) => setDraft({ tab: t, amount: '' })} options={tabOptions} className="grid w-full grid-flow-col auto-cols-fr rounded-xl bg-bg/50 p-1" btnClassName="h-9 justify-center rounded-[9px] text-[13px] font-semibold" data-component="TradeTabs" />

          {tab !== 'merge' ? (
            <div className="grid grid-cols-2 gap-2" role="group" aria-label="Outcome">
              {(['above', 'below'] as const).map((s) => {
                const on = side === s;
                const p = s === 'above' ? m.priceAbove : 1 - m.priceAbove;
                return (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setDraft({ side: s })}
                    data-testid={`side-${s}`}
                    className={cn(
                      'flex h-[60px] flex-col items-center justify-center gap-1 rounded-[14px] border text-body transition-all',
                      on ? (s === 'above' ? 'border-above/60 bg-above/[0.12]' : 'border-below/60 bg-below/[0.12]') : 'border-violet/[0.18] bg-transparent hover:border-violet/40',
                    )}
                  >
                    <span className={cn('font-sans text-[13px] font-semibold leading-none', s === 'above' ? 'text-above-text' : 'text-below-text')}>
                      {tab === 'sell' ? 'Sell' : 'Buy'} {sideWord(s)}
                    </span>
                    <span className="font-display text-lg font-semibold leading-none">{cents(p)}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="rounded-xl border border-violet/20 bg-violet/[0.06] p-3 text-[13px] leading-normal text-ink-2">
              One ABOVE share plus one BELOW share always redeem for exactly 1 USDC. Merge returns USDC for the sets you hold, with no fee. You can merge up to <b className="text-ink">{mergeable.toFixed(2)}</b> sets.
            </div>
          )}

          <div className="flex flex-col gap-2.5">
            <div className={cn(eyebrow, 'flex justify-between')}>
              <label htmlFor="trade-amount">{tab === 'buy' ? 'Amount' : tab === 'sell' ? 'Shares to sell' : 'Sets to merge'}</label>
              <span data-testid="balance">
                {tab === 'buy' ? (signing && balUsdc != null ? `Balance ${balUsdc.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '') : tab === 'sell' ? (signing ? `Held ${held.toFixed(2)} ${sideWord(side)}` : '') : `Max ${mergeable.toFixed(2)}`}
              </span>
            </div>
            <div className="gg-field h-[58px]" data-invalid={(exceedsHeld || exceedsBalance || exceedsMerge || belowMin) && valid}>
              <input
                id="trade-amount"
                value={draft.amount}
                onChange={(e) => {
                  const v = e.target.value.replace(/,/g, '');
                  if (/^\d*\.?\d{0,6}$/.test(v)) setDraft({ amount: v });
                }}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0"
                aria-label={tab === 'buy' ? 'Amount in USDC' : 'Amount in shares'}
                className="font-display text-[26px] font-semibold leading-none"
              />
              <span className="font-mono text-[13px] leading-none text-faint">{tab === 'buy' ? 'USDC' : tab === 'sell' ? sideWord(side) : 'SETS'}</span>
            </div>
            <div className="flex gap-1.5">
              {presets.map((p) => (
                <button key={p.label} type="button" onClick={() => setDraft({ amount: p.value })} className="h-11 flex-1 rounded-lg border border-violet/[0.18] bg-transparent font-mono text-xs font-medium text-muted transition-colors hover:border-violet/45 min-[760px]:h-9">
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className={cn('flex flex-col gap-2.5 text-[13px] transition-opacity', quote.isFetching && quoteOn ? 'opacity-70' : '')} data-testid="trade-rows" aria-live="polite">
            {tradeRows.map((r) => (
              <div key={r.k} className="flex justify-between gap-3">
                <span className="text-dim">{r.k}</span>
                <span className={cn('text-right font-mono', priceFlash && r.k === 'Avg. price' && 'gg-flash')} style={{ color: r.color ?? '#EDEBF5' }}>
                  {r.v}
                </span>
              </div>
            ))}
            {quoteFailure && quoteFailure.kind !== 'unauthorized' ? <span role="status" className="text-xs leading-[1.45] text-below-text">{failureCopy(quoteFailure).title}. {failureCopy(quoteFailure).body}</span> : null}
          </div>

          {tab !== 'merge' ? (
            <div data-component="SlippagePicker" className="flex items-center justify-between text-[13px]">
              <span className="text-dim">Max slippage</span>
              <div className="flex gap-1" role="group" aria-label="Max slippage">
                {SLIPPAGE_OPTIONS.map((o) => {
                  const on = draft.slip === o;
                  return (
                    <button key={o} type="button" aria-pressed={on} onClick={() => setDraft({ slip: o })} className={cn('h-9 rounded-[7px] border px-2.5 font-mono text-[11px] font-medium transition-colors min-[760px]:h-7', on ? 'border-violet/60 bg-violet/20 text-white' : 'border-violet/20 bg-transparent text-muted hover:border-violet/45')}>
                      {o / 100}%
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {riskPct != null || serverLarge ? (
            <div data-component="RiskNote" role="note" className="flex items-start gap-2.5 rounded-xl border border-violet/30 bg-violet/[0.08] p-3 text-[13px] leading-[1.45] text-violet-pale">
              <span aria-hidden className="mt-[5px] h-2 w-2 flex-none rounded-full bg-violet" />
              {riskPct != null ? `This is ${riskPct}% of your balance.` : 'This is a large share of your balance.'} Only put in what you can afford to lose.
            </div>
          ) : null}

          {tab === 'buy' ? (
            <div className="flex items-center gap-2.5 rounded-xl border px-3 py-3 text-[13px] text-ink-2" style={{ background: aligned ? 'rgba(44,230,214,0.06)' : 'rgba(255,255,255,0.025)', borderColor: aligned ? 'rgba(44,230,214,0.25)' : 'rgba(255,255,255,0.06)' }}>
              <span aria-hidden className="h-2 w-2 flex-none rounded-full" style={{ background: favors === 'below' ? '#E046F0' : '#2CE6D6', boxShadow: `0 0 10px ${favors === 'below' ? '#E046F0' : '#2CE6D6'}` }} />
              {m.radar.state !== 'ready' || m.radar.p == null
                ? 'Radar is still building a signal for this market.'
                : `Radar P(above) ${Math.round(m.radar.p * 100)}%${m.radar.ci != null ? ` ±${m.radar.ci}` : ''} vs price ${cents(m.priceAbove)}. ${favors == null ? 'No edge either way.' : aligned ? `You are on the side it favors (${m.radar.edge! >= 0 ? '+' : '−'}${Math.abs(m.radar.edge!)}¢ edge).` : `It favors ${sideWord(favors)}; you are taking the other side.`}`}
            </div>
          ) : null}

          {stale ? (
            <div data-component="OracleStaleBanner" role="status" className="flex items-start gap-2.5 rounded-xl border border-below/30 bg-below/[0.07] p-3 text-[13px] leading-[1.45] text-below-text">
              <span aria-hidden className="mt-[5px] h-2 w-2 flex-none animate-gg-pulse-fast rounded-full bg-below" />
              {tab === 'buy'
                ? `Trading paused. The Pyth price is ${m.oracle.ageSec != null ? `${Math.round(m.oracle.ageSec)}s` : 'too'} old (limit 60s); buying resumes as soon as a fresh price lands. Selling and merging still work.`
                : 'The oracle price is stale, so buys are paused. Selling and merging still work.'}
            </div>
          ) : null}

          {tab === 'buy' && onBreak ? (
            <div role="status" className="rounded-xl border border-below/30 bg-below/[0.07] p-3 text-[13px] leading-[1.45] text-below-text">
              {failureCopy(new TxFailure('break', 'break'), { breakUntil }).body}{' '}
              <Link href="/positions#limits" className="underline">
                Trading limits
              </Link>
            </div>
          ) : null}
          {overLimit && !onBreak ? (
            <div role="status" className="rounded-xl border border-violet/30 bg-violet/[0.08] p-3 text-[13px] leading-[1.45] text-violet-pale">
              This would take you past your daily limit of {usd(limit ?? 0)} ({usd(spent)} spent today).{' '}
              <Link href="/positions#limits" className="underline">
                Review limits
              </Link>
            </div>
          ) : null}

          {showFaucet && signer.wallet ? (
            <div data-component="FaucetBanner" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-above/25 bg-above/5 p-3 text-[13px] text-ink-2">
              <span>You have no test USDC. Devnet tokens have no monetary value.</span>
              <FaucetButton wallet={signer.wallet} variant="primary" />
            </div>
          ) : null}

          {runner.phase.kind === 'idle' || runner.phase.kind === 'done' || runner.phase.kind === 'error' ? (
            runner.phase.kind === 'done' ? null : (
              <button
                type="button"
                data-testid="trade-cta"
                onClick={onCta}
                disabled={cta.disabled}
                aria-disabled={cta.disabled}
                className={cn('gg-btn h-[54px] rounded-[14px] text-base', cta.disabled ? 'gg-btn-quiet' : cta.action === 'trade' ? 'gg-btn-primary shadow-[0_0_36px_rgba(91,44,143,0.6)]' : 'gg-btn-primary')}
              >
                {cta.label}
              </button>
            )
          ) : null}

          {runner.phase.kind === 'busy' ? <TxStatus label={runner.phase.p.label} sub={runner.phase.p.sub} progress={runner.phase.p.pct} /> : null}
          {failure && failCopy ? (
            <TxError
              title={failCopy.title}
              body={failCopy.body}
              code={failCopy.code}
              primary={failCopy.primary ? { label: failCopy.primary.label, onClick: () => onAction(failCopy.primary!.id) } : undefined}
              secondary={failCopy.secondary ? { label: failCopy.secondary.label, onClick: () => onAction(failCopy.secondary!.id) } : undefined}
              onDismiss={() => runner.reset()}
            />
          ) : null}
          {runner.phase.kind === 'done' ? (
            <ReceiptBlock phase={runner.phase} tab={tab} side={side} amountText={draft.amount} onAgain={() => runner.reset()} />
          ) : null}
        </>
      )}
      {open && busy ? <span className="sr-only" aria-live="polite">Transaction in progress</span> : null}
    </section>
  );
}

function receiptText(tab: TradeTab, side: Side, r: { amountIn?: string; amountOut?: string } | undefined, typed: string): { title: string; sub: string } {
  const out = r?.amountOut ? fromBase(r.amountOut) : null;
  const inn = r?.amountIn ? fromBase(r.amountIn) : parseAmount(typed);
  if (tab === 'buy') return { title: `Bought ${out != null ? out.toFixed(2) : ''} ${sideWord(side)}`.replace('  ', ' '), sub: `${usd(inn ?? 0)} in${out != null ? ` · ${out.toFixed(2)} shares out` : ''}. Each share settles at $1 or $0.` };
  if (tab === 'sell') return { title: `Sold ${inn != null ? inn.toFixed(2) : ''} ${sideWord(side)}`.replace('  ', ' '), sub: out != null ? `${usd(out)} received after fees.` : 'USDC returned to your wallet.' };
  return { title: `Merged ${inn != null ? inn.toFixed(2) : ''} sets`.replace('  ', ' '), sub: `${usd(inn ?? 0)} returned to your wallet.` };
}

function ReceiptBlock({ phase, tab, side, amountText, onAgain }: { phase: { kind: 'done'; signature: string; tx: { receipt?: { amountIn?: string; amountOut?: string } } }; tab: TradeTab; side: Side; amountText: string; onAgain: () => void }) {
  const t = receiptText(tab, side, phase.tx.receipt, amountText);
  return (
    <div className="flex flex-col gap-2.5">
      <TradeReceipt
        title={t.title}
        sub={t.sub}
        footer={
          <>
            <a href={explorerTx(phase.signature)} target="_blank" rel="noopener noreferrer" className="font-mono text-faint hover:text-above">
              tx {txShort(phase.signature)} ↗
            </a>
            <Link href="/positions">View positions →</Link>
          </>
        }
      />
      <button type="button" onClick={onAgain} className="gg-btn gg-btn-quiet h-11 rounded-xl text-[13px]">
        New trade
      </button>
    </div>
  );
}

/** Flash for a short time when the value changes (price moved under the panel). */
function useFlashLocal(v: number): boolean {
  const [on, setOn] = useState(false);
  const [prev, setPrev] = useState(v);
  useEffect(() => {
    if (v === prev) return;
    setPrev(v);
    setOn(true);
    const t = setTimeout(() => setOn(false), 900);
    return () => clearTimeout(t);
  }, [v, prev]);
  return on;
}
