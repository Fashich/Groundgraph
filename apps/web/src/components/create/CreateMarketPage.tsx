'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { TxError, TxStatus, cn } from '@groundgraph/ui';
import { api } from '@/lib/api';
import { useWalletFlow } from '@/components/wallet/flow';
import { useTxRunner } from '@/components/wallet/useTxRunner';
import { buildCreateReq, defaultDraft, durationDate, ladder, openingPrice, questionText, ruleText, settleIso } from '@/lib/create';
import { fmtD, leftLabel, num, numStr, txShort, usd } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { arbLoss, depthLevel, impactCents } from '@/lib/math';
import { useAssets, useFairValue, useRefreshAccount } from '@/lib/queries';
import { explorerTx } from '@/lib/solana';
import { failureCopy } from '@/lib/tx';
import { useUi } from '@/lib/stores';
import { LIQ_MIN, validateTarget, validateTiming, type CreateDraft } from '@/lib/validation';
import { AckBox, AssetPicker, CostSummary, DurationPicker, FeePicker, Field, LiquidityInput, MarketPreview, MarketTypePicker, QuestionPreview, ResolutionSource, ReviewSummary, RuleBox, SeedPicker, TargetLadder } from './CreateParts';
import { useRouter } from 'next/navigation';

const STEPS = ['Question', 'Timing & liquidity', 'Review & publish'] as const;
const CATEGORY: Record<string, string> = { BTC: 'Majors', ETH: 'Majors', SOL: 'Majors' };

export function CreateMarketPage() {
  const router = useRouter();
  const runner = useTxRunner();
  const { signer } = runner;
  const flow = useWalletFlow();
  const openWallet = useUi((s) => s.openWallet);
  const refresh = useRefreshAccount();
  const toast = useUi((s) => s.toast);
  const assets = useAssets();
  const now = useNow(60_000);
  const [d, setD] = useState<CreateDraft>(() => defaultDraft('SOL'));
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [ack, setAck] = useState(false);
  const [mode, setMode] = useState<'card' | 'detail'>('card');
  const [days, setDays] = useState<number | null>(30);
  const [created, setCreated] = useState<{ marketId?: string; signature: string } | null>(null);
  const set = (p: Partial<CreateDraft>) => setD((x) => ({ ...x, ...p }));

  const row = assets.data?.find((a) => a.symbol === d.asset);
  const spot = row?.price ?? null;
  const tgt = num(d.target);
  // Prefill a target 10% above spot the first time a price is known for the chosen asset.
  const [prefilled, setPrefilled] = useState<string | null>(null);
  useEffect(() => {
    if (spot && prefilled !== d.asset) {
      setPrefilled(d.asset);
      setD((x) => ({ ...x, target: numStr(spot * 1.1) }));
    }
  }, [spot, d.asset, prefilled]);

  const e1 = spot == null ? (assets.isPending ? 'Loading the live price' : 'No live price for this asset right now') : validateTarget(tgt, spot);
  const dateErr = validateTiming(d.date, LIQ_MIN, now);
  const e2 = validateTiming(d.date, num(d.liq), now);
  const timingOk = !dateErr;
  const hoursTo = (new Date(settleIso(d.date)).getTime() - now) / 36e5;

  const fairParams = !e1 && timingOk && tgt > 0 ? { asset: d.asset, target: tgt, settleTs: settleIso(d.date), kind: 'close' } : null;
  const fairQ = useFairValue(fairParams);
  const fair = fairQ.data?.pAbove ?? null;
  const fairNote = fairQ.data
    ? `Digital-option estimate from oracle spot ${usd(fairQ.data.spot)}, ${Math.round(fairQ.data.vol * 100)}% annualized volatility and ${leftLabel(Math.max(1, hoursTo))} to the close.`
    : fairQ.isError
      ? 'The model fair value is unavailable right now (no fresh oracle price or volatility estimate). You can still open at 50/50.'
      : 'Pick a target price and date to see the model fair value.';

  const liq = num(d.liq);
  const open = openingPrice(d.seed, fair);
  const p0 = open ?? 0.5;
  const move = impactCents(liq, p0, 100);
  const lvl = depthLevel(move);
  const depth = { label: ['Thin', 'Healthy', 'Deep'][lvl - 1]!, note: `A $100 trade moves the price by about ${move.toFixed(1)}¢ at opening.` };
  const loss = fair != null && d.seed === 'even' ? arbLoss(liq, fair) : 0;
  const arb =
    d.seed === 'even' && fair != null && loss >= 1
      ? { warn: true, text: `Fair value is ${Math.round(fair * 100)}¢, so arbitrageurs can buy the cheap side right after launch. Expected loss about ${usd(loss)} of your ${usd(liq)} (${Math.round((loss / Math.max(1, liq)) * 100)}%).` }
      : { warn: false, text: open != null ? `Pool opens at ${Math.round(open * 100)}¢ / ${Math.round((1 - open) * 100)}¢. Arbitrage has almost nothing to take, so your ${usd(liq)} stays with LPs.` : 'Choose an opening price.' };

  const question = tgt > 0 ? questionText(d.asset, tgt, d.date) : `${d.asset} above or below a target at the close?`;
  const rule = tgt > 0 ? ruleText(d.asset, tgt, d.date) : 'Set a target price to see the resolution rule.';
  const feeN = Number(d.fee);
  const diff = spot && tgt > 0 ? (tgt / spot - 1) * 100 : null;

  const stepOk = (n: number) => (n === 1 ? !e1 && tgt > 0 : n === 2 ? !e2 && (d.seed === 'even' || fair != null) : ack);
  const stepErr = step === 1 ? e1 : step === 2 ? e2 || (d.seed === 'fair' && fair == null ? 'The model fair value is unavailable. Open at 50/50 or try again.' : '') : '';

  const busy = runner.phase.kind === 'busy';
  const failure = runner.phase.kind === 'error' ? runner.phase.failure : null;
  const copy = failure ? failureCopy(failure, {}) : null;

  const publish = async () => {
    const req = buildCreateReq(d, question);
    if (!req) return;
    const res = await runner.run((priority) => api.txCreate(priority ? ({ ...req, priorityFeeMicroLamports: priority } as typeof req) : req));
    if (res) {
      setCreated({ marketId: (res.tx as { marketId?: string }).marketId, signature: res.signature });
      refresh();
      toast({ tone: 'success', title: 'Market published on Solana', body: txShort(res.signature) });
    }
  };

  const next = () => {
    if (busy) return;
    if (!stepOk(step)) {
      toast({ tone: 'error', title: stepErr || (step === 3 ? 'Confirm the checkbox to continue' : 'Complete this step first') });
      return;
    }
    if (step < 3) {
      setStep((s) => (s + 1) as 1 | 2 | 3);
      return;
    }
    if (!signer.session || signer.isView) {
      openWallet('/create');
      return;
    }
    if (signer.needsReconnect) {
      void flow.reconnectSigner();
      return;
    }
    void publish();
  };

  const act = (id: string) => {
    if (runner.handleGeneric(id as never)) return;
    if (id === 'retry') void publish();
    if (id === 'retry_priority') {
      runner.bumpPriority();
      void publish();
    }
    if (id === 'refresh') runner.reset();
  };

  const reviewRows = useMemo(
    () => [
      { k: 'Question', v: question },
      { k: 'Outcomes', v: 'ABOVE / BELOW · each share settles at $1 or $0' },
      { k: 'Oracle', v: `Pyth ${d.asset}/USD` },
      { k: 'Resolves', v: `${fmtD(settleIso(d.date))} · 23:59 UTC` },
      { k: 'Opening price', v: open != null ? `${Math.round(open * 100)}¢ / ${Math.round((1 - open) * 100)}¢ · ${d.seed === 'even' ? '50/50 start' : 'model fair value'}` : 'Unavailable' },
      { k: 'Liquidity', v: `${usd(liq)} USDC` },
      { k: 'Fee', v: `${d.fee}% base${d.dyn ? ' · dynamic' : ''} to LPs` },
    ],
    [question, d.asset, d.date, d.seed, d.fee, d.dyn, open, liq],
  );

  const ctaLabel = step < 3 ? 'Continue' : !signer.session ? 'Connect wallet to publish' : signer.isView ? 'Connect a signing wallet to publish' : signer.needsReconnect ? 'Reconnect wallet to publish' : busy ? 'Publishing' : `Publish market · ${usd(liq)}`;
  const ctaOff = (step === 3 && !ack) || busy;
  const stepsDone = (i: number) => created != null || step > i + 1;

  return (
    <div data-component="CreateMarketPage" className="mx-auto max-w-[1240px] animate-gg-in px-[clamp(16px,4vw,40px)] py-[clamp(24px,4vw,48px)]">
      <Link href="/markets" className="font-mono text-[13px] font-medium leading-none text-dim hover:text-above">
        ← Markets
      </Link>
      <h1 className="mt-4 font-display text-[clamp(30px,4vw,46px)] font-semibold leading-none tracking-[-0.03em]">Create a market</h1>
      <p className="mt-2.5 max-w-[580px] text-dim">A two-outcome market on a price level, Above or Below. A Pyth oracle feed settles it automatically, so no one can change the outcome after launch.</p>

      <div className="mt-8 flex flex-wrap items-start gap-6">
        <div data-component="CreateForm" className="flex min-w-0 flex-[999_1_480px] flex-col gap-7 rounded-3xl border border-violet/[0.14] p-[clamp(20px,3vw,32px)]" style={{ background: 'var(--gg-surface)' }}>
          <ol data-component="CreateStepper" className="m-0 flex list-none gap-2 p-0">
            {STEPS.map((label, i) => {
              const n = i + 1;
              const done = stepsDone(i);
              const cur = !created && step === n;
              const reachable = !created && (n < step || (n === step + 1 && stepOk(step)));
              return (
                <li key={label} className="min-w-0 flex-1">
                  <button type="button" disabled={!reachable && !cur} onClick={() => setStep(n as 1 | 2 | 3)} aria-current={cur ? 'step' : undefined} className="flex w-full flex-col items-start gap-2.5 border-0 bg-transparent p-0 text-left">
                    <span className="h-[3px] w-full rounded-sm transition-colors" style={{ background: done || cur ? 'var(--gg-gradient-bar)' : 'rgba(255,255,255,0.08)' }} />
                    <span className={cn('flex items-center gap-1.5 font-mono text-xs font-medium leading-[1.3]', cur ? 'text-white' : 'text-faint')}>
                      <span className={done ? 'text-above' : ''}>{done ? '✓' : `0${n}`}</span>
                      {label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>

          {created ? (
            <div className="flex animate-gg-in flex-col items-start gap-3.5 rounded-2xl border border-above/30 bg-above/[0.06] p-6" role="status">
              <span aria-hidden className="grid h-10 w-10 place-items-center rounded-full bg-above font-bold text-bg shadow-[0_0_24px_rgba(44,230,214,0.5)]">
                ✓
              </span>
              <span className="font-display text-[22px] font-semibold leading-[1.2]">Market is live</span>
              <span className="text-ink-2">{question}</span>
              <a href={explorerTx(created.signature)} target="_blank" rel="noopener noreferrer" className="break-all font-mono text-xs leading-normal text-dim hover:text-above">
                tx {txShort(created.signature)} · confirmed · it lists in Markets once the indexer sees it ↗
              </a>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => router.push(created.marketId ? `/markets/${created.marketId}` : '/markets')} className="gg-btn gg-btn-primary h-11 rounded-pill px-[18px] text-sm">
                  {created.marketId ? 'View market' : 'Go to markets'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCreated(null);
                    runner.reset();
                    setStep(1);
                    setAck(false);
                    setD(defaultDraft(d.asset));
                    setPrefilled(null);
                  }}
                  className="gg-btn gg-btn-quiet h-11 rounded-pill px-[18px] text-sm"
                >
                  Create another
                </button>
              </div>
            </div>
          ) : (
            <>
              {step === 1 ? (
                <div className="flex animate-gg-in flex-col gap-[26px]">
                  <MarketTypePicker />
                  <AssetPicker assets={assets.data} value={d.asset} onPick={(symbol) => (setPrefilled(null), set({ asset: symbol, target: '' }))} loading={assets.isPending} error={assets.isError} />
                  <TargetLadder target={d.target} onTarget={(v) => set({ target: v })} spot={spot} diff={diff} lad={spot ? ladder(spot, tgt) : null} error={e1} presets={[-10, 10, 25, 50]} onPreset={(p) => spot && set({ target: numStr(spot * (1 + p / 100)) })} asset={d.asset} />
                  <QuestionPreview question={question} fair={fair} fairNote={fairNote} fairLoading={fairQ.isFetching && !!fairParams} fairError={fairQ.isError} />
                </div>
              ) : null}

              {step === 2 ? (
                <div className="flex animate-gg-in flex-col gap-[26px]">
                  <DurationPicker
                    days={days}
                    onDays={(n) => {
                      setDays(n);
                      set({ date: durationDate(n) });
                    }}
                    date={d.date}
                    onDate={(v) => {
                      setDays(null);
                      set({ date: v });
                    }}
                    error={!!dateErr}
                    note={timingOk ? `${fmtD(settleIso(d.date))} · 23:59 UTC close · ${leftLabel(Math.max(0, hoursTo))} from now` : dateErr}
                  />
                  <ResolutionSource asset={d.asset} />
                  <LiquidityInput value={d.liq} onChange={(v) => set({ liq: v })} error={!!e2 && !dateErr} level={lvl} label={depth.label} note={depth.note} />
                  <SeedPicker seed={d.seed} onSeed={(s) => set({ seed: s })} fair={fair} fairOk={fair != null} arb={arb} />
                  <FeePicker fee={d.fee} onFee={(f) => set({ fee: f })} dyn={d.dyn} onDyn={(v) => set({ dyn: v })} note={`Illustration: at $50,000 of volume, LPs would earn about ${usd((50000 * feeN) / 100)} in base fees. Higher fees discourage small trades.`} />
                </div>
              ) : null}

              {step === 3 ? (
                <div className="flex animate-gg-in flex-col gap-[18px]">
                  <ReviewSummary rows={reviewRows} />
                  <RuleBox text={rule} />
                  <CostSummary deposit={`${usd(liq)} USDC`} />
                  <AckBox checked={ack} onChange={setAck} />
                  {busy && runner.phase.kind === 'busy' ? <TxStatus label={runner.phase.p.label} sub={runner.phase.p.sub} progress={runner.phase.p.pct} /> : null}
                  {failure && copy ? (
                    <TxError
                      title={failure.kind === 'stale' ? 'Price feed is stale, cannot publish right now' : copy.title}
                      body={failure.kind === 'stale' ? 'The oracle for this asset has not published a fresh price in over a minute. Try again in a moment.' : copy.body}
                      code={copy.code}
                      primary={copy.primary ? { label: copy.primary.label, onClick: () => act(copy.primary!.id) } : undefined}
                      secondary={copy.secondary ? { label: copy.secondary.label, onClick: () => act(copy.secondary!.id) } : undefined}
                      onDismiss={() => runner.reset()}
                    />
                  ) : null}
                </div>
              ) : null}

              <div className="flex flex-col gap-3 pt-1">
                {stepErr && step !== 3 ? (
                  <span role="alert" className="flex items-center gap-2 text-[13px] text-below-text">
                    <span aria-hidden className="h-1.5 w-1.5 flex-none rounded-full bg-below" />
                    {stepErr}
                  </span>
                ) : null}
                <div className="flex justify-between gap-3">
                  <button type="button" onClick={() => setStep((s) => (Math.max(1, s - 1) as 1 | 2 | 3))} disabled={step === 1 || busy} className="gg-btn gg-btn-quiet h-12 rounded-pill px-5 text-[15px]" style={{ opacity: step === 1 ? 0.4 : 1 }}>
                    Back
                  </button>
                  <button type="button" data-testid="create-next" onClick={next} aria-disabled={ctaOff || (step < 3 && !stepOk(step))} disabled={busy} className={cn('gg-btn gg-btn-primary h-12 rounded-pill px-[26px] text-[15px]', (ctaOff || (step < 3 && !stepOk(step))) && 'opacity-50')}>
                    {ctaLabel}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        <MarketPreview mode={mode} onMode={setMode} asset={d.asset} category={CATEGORY[d.asset] ?? 'Solana ecosystem'} question={question} openPrice={open} openNote={d.seed === 'even' ? 'opening · 50/50' : 'opening · model fair'} liq={liq} fee={d.fee} hoursLeft={timingOk ? leftLabel(Math.max(0, hoursTo)) : '–'} rule={rule} />
      </div>
    </div>
  );
}

