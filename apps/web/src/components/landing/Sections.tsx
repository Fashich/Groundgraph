'use client';

import Link from 'next/link';
import { FeatureBars, cn, FEATURE_COLORS, FEATURE_LABELS, scoreColor, sparkPath } from '@groundgraph/ui';
import { HOW_STEPS, topWallet } from '@/lib/landing';
import { useRadar, useSession, useSpotlight, useWalletDetail } from '@/lib/queries';
import { hedgeExample, HEDGE_DEFAULT } from '@/lib/hedge';
import { cents, shortAddr, usd } from '@/lib/format';
import { useUi } from '@/lib/stores';
import { Skeleton } from '@/components/common/states';


const SECTION_LABEL = 'font-mono text-xs font-medium uppercase leading-none tracking-[0.1em] text-violet';
const CARD = 'rounded-3xl border bg-[linear-gradient(180deg,rgba(28,22,44,0.6),rgba(14,11,24,0.6))]';

export function HowItWorks() {
  return (
    <section data-component="HowItWorks" className="gg-section">
      <div className={SECTION_LABEL}>How it works</div>
      <h2 className="gg-h2 mt-4 max-w-[760px]">From raw transactions to a signal you can read in one glance.</h2>
      <div className="mt-12 grid grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-4">
        {HOW_STEPS.map((s) => (
          <div key={s.n} className="gg-hover-lift relative flex flex-col gap-3.5 overflow-hidden rounded-[20px] border border-violet/[0.14] bg-[linear-gradient(180deg,rgba(28,22,44,0.6),rgba(14,11,24,0.6))] p-7 hover:!border-above/35">
            <div className="flex items-center gap-3">
              <span className="grid h-9 w-9 place-items-center rounded-full border border-above/35 font-mono text-xs font-medium leading-none text-above">{s.n}</span>
              <span aria-hidden className="h-px flex-1 bg-gradient-to-r from-above/40 to-violet/0" />
            </div>
            <h3 className="font-display text-2xl font-semibold leading-[1.15] tracking-[-0.02em]">{s.t}</h3>
            <p className="text-muted [text-wrap:pretty]">{s.d}</p>
            <span className="font-mono text-xs leading-none text-faint">{s.tech}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function TwoEngines() {
  const spot = useSpotlight();
  const radar = useRadar();
  const top = topWallet(radar.data);
  const detail = useWalletDetail(top?.addr ?? null);
  const m = spot.data;
  const sp = m ? sparkPath(m.spark, 400, 100, 8) : null;
  const w = detail.data;
  const items = w
    ? (Object.keys(FEATURE_LABELS) as (keyof typeof FEATURE_LABELS)[]).map((k) => ({ label: FEATURE_LABELS[k], pts: w.contributions[k], value: k === 'leadTime' ? Math.min(1, w.features.leadTimeMin / 68) : w.features[k], color: FEATURE_COLORS[k] }))
    : [];
  return (
    <section data-component="TwoEngines" className="gg-section">
      <div className={SECTION_LABEL}>Two engines, one decision</div>
      <h2 className="gg-h2 mt-4 max-w-[760px]">The market sets the price. The radar tells you who is behind it.</h2>
      <div className="mt-12 grid grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] gap-4">
        <div className={cn(CARD, 'flex flex-col gap-5 border-violet/[0.14] p-[clamp(20px,3vw,32px)]')}>
          <div className="flex items-center justify-between">
            <span className="font-display text-xl font-semibold leading-none">Price market</span>
            <span className="font-mono text-xs leading-none text-faint">x · y = k</span>
          </div>
          {m && sp ? (
            <>
              <div className="text-[15px] text-muted">{m.question}</div>
              <div className="flex items-end gap-4">
                <span className="font-display text-[56px] font-semibold leading-[0.9] tracking-[-0.03em] text-above">{cents(m.priceAbove)}</span>
                <span className="font-mono text-[13px] leading-[1.4] text-faint">
                  ABOVE price
                  <br />= implied probability
                </span>
              </div>
              <svg viewBox="0 0 400 100" preserveAspectRatio="none" className="block h-[100px] w-full" aria-hidden>
                <defs>
                  <linearGradient id="lg1" x1="0" x2="1">
                    <stop offset="0" stopColor="#9B6BFF" />
                    <stop offset="1" stopColor="#2CE6D6" />
                  </linearGradient>
                  <linearGradient id="lg1a" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0" stopColor="rgba(44,230,214,0.22)" />
                    <stop offset="1" stopColor="rgba(44,230,214,0)" />
                  </linearGradient>
                </defs>
                <path d={`${sp.line} L400,100 L0,100 Z`} fill="url(#lg1a)" />
                <path d={sp.line} fill="none" stroke="url(#lg1)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
              </svg>
            </>
          ) : spot.isPending ? (
            <Skeleton className="h-52" />
          ) : (
            <p className="text-sm leading-relaxed text-dim">Markets with a ready radar signal are shown here. None is available right now.</p>
          )}
          <p className="text-muted [text-wrap:pretty]">Liquidity is pooled, so there is always a price. Buying ABOVE moves the implied probability up. Each share settles at $1 if the price ends on its side and $0 if not, using a Pyth price feed.</p>
        </div>
        <div className={cn(CARD, 'flex flex-col gap-5 border-above/[0.18] p-[clamp(20px,3vw,32px)]')}>
          <div className="flex items-center justify-between">
            <span className="font-display text-xl font-semibold leading-none">Smart money radar</span>
            <span className="font-mono text-xs leading-none text-faint">graph features → score</span>
          </div>
          {w && top ? (
            <>
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <span className="font-mono text-[13px] font-medium leading-none text-ink">{shortAddr(w.address)}</span>
                  <span className="text-[13px] text-dim">{w.cluster?.name ?? 'Unclustered'}</span>
                </div>
                <span className="font-display text-[56px] font-semibold leading-[0.9] tracking-[-0.03em]" style={{ color: scoreColor(w) }}>
                  {w.score}
                </span>
              </div>
              <FeatureBars items={items} labelWidth={110} />
            </>
          ) : radar.isPending || detail.isPending ? (
            <Skeleton className="h-52" />
          ) : (
            <p className="text-sm leading-relaxed text-dim">The radar is still building its first scores. Wallet breakdowns appear here when it is ready.</p>
          )}
          <p className="text-muted [text-wrap:pretty]">Wallets become nodes, transfers become edges. Each wallet is scored on how it sits in that graph and how early it tends to be, then aggregated into a per-market lean.</p>
        </div>
      </div>
    </section>
  );
}

export function HedgeUseCase() {
  const h = hedgeExample();
  const i = HEDGE_DEFAULT;
  const sign = (n: number) => `${n < 0 ? '−' : '+'}${usd(Math.abs(n))}`;
  return (
    <section data-component="HedgeUseCase" className="gg-section">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,380px),1fr))] items-center gap-[clamp(24px,4vw,56px)]">
        <div className="flex flex-col gap-4">
          <div className={SECTION_LABEL}>Hedge what you hold</div>
          <h2 className="gg-h2">Protect a position against a price move.</h2>
          <p className="max-w-[520px] text-muted [text-wrap:pretty]">A price market works like protection on a level. Holding SOL and worried about a drop? A Below position pays when it happens, and costs only what the market thinks that risk is worth.</p>
        </div>
        <div data-component="HedgeExample" className={cn(CARD, 'flex flex-col gap-4 border-above/[0.18] p-[clamp(20px,3vw,28px)]')}>
          <div className="flex justify-between gap-3 font-mono text-[11px] font-medium uppercase leading-none tracking-[0.06em] text-faint">
            <span>
              Example · {i.symbol} at ${i.spot.toFixed(2)}
            </span>
            <span>Assumed prices</span>
          </div>
          <div className="flex flex-col gap-2.5 text-sm">
            <div className="flex justify-between gap-3">
              <span className="text-dim">You hold</span>
              <span className="font-mono text-ink">
                {i.qty} {i.symbol} · {usd(h.holdValue)}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-dim">You buy</span>
              <span className="text-right font-mono text-below-text">
                {i.shares} BELOW ${i.strike} @ {Math.round(i.belowPrice * 100)}¢ = {usd(h.cost)}
              </span>
            </div>
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,190px),1fr))] gap-2.5">
            <div className="flex flex-col gap-2 rounded-[14px] border border-below/20 bg-below/[0.06] p-3.5">
              <span className="text-[13px] font-semibold leading-[1.3] text-ink">
                {i.symbol} breaks below ${i.strike}, to ${i.shock}
              </span>
              <span className="font-mono text-xs leading-[1.6] text-muted">
                Holdings {sign(-h.holdingsLoss)}
                <br />
                Position {sign(h.positionGain)}
              </span>
              <span className="font-display text-base font-semibold leading-none text-ink">
                Net {sign(h.netWithHedge)} instead of {sign(h.netWithout)}
              </span>
            </div>
            <div className="flex flex-col gap-2 rounded-[14px] border border-above/20 bg-above/5 p-3.5">
              <span className="text-[13px] font-semibold leading-[1.3] text-ink">
                {i.symbol} holds above ${i.strike}
              </span>
              <span className="font-mono text-xs leading-[1.6] text-muted">
                Holdings keep their value
                <br />
                Position {sign(h.netIfHolds)}
              </span>
              <span className="font-display text-base font-semibold leading-none text-ink">{usd(h.cost)} was the cost of protection</span>
            </div>
          </div>
          <span className="text-xs leading-[1.5] text-faint">Illustration with assumed inputs, not live data and not financial advice. Settlement uses the Pyth {i.symbol}/USD feed.</span>
        </div>
      </div>
    </section>
  );
}

export function Explainable() {
  const radar = useRadar();
  const top = topWallet(radar.data);
  const q = useWalletDetail(top?.addr ?? null);
  const w = q.data;
  const keys = Object.keys(FEATURE_LABELS) as (keyof typeof FEATURE_LABELS)[];
  const rest = w ? Math.max(0, 100 - w.score) : 0;
  return (
    <section data-component="Explainable" className="gg-section">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,380px),1fr))] items-center gap-[clamp(24px,4vw,56px)] rounded-[28px] border border-violet/[0.18] bg-[radial-gradient(80%_120%_at_0%_0%,rgba(91,44,143,0.4),rgba(14,11,24,0.7)_60%)] p-[clamp(24px,4vw,56px)]">
        <div className="flex flex-col gap-4">
          <div className="font-mono text-xs font-medium uppercase leading-none tracking-[0.1em] text-above">Explainable by design</div>
          <h2 className="font-display text-[clamp(28px,3.6vw,46px)] font-semibold leading-[1.05] tracking-[-0.03em] [text-wrap:balance]">Not a black box. Every point of the score is accounted for.</h2>
          <p className="text-muted [text-wrap:pretty]">
            {w ? `A score of ${w.score} is the sum of five named features. ` : 'A wallet score is the sum of five named features. '}You see the parts, the plain-language reason behind each, and the transactions that produced them.
          </p>
        </div>
        {w ? (
          <div className="flex flex-col gap-[18px]">
            <div className="flex h-11 gap-[3px] overflow-hidden rounded-xl" role="img" aria-label={`Score ${w.score} split across five features`}>
              {keys.map((k) => (
                <div key={k} className="flex items-center justify-center font-mono text-[13px] font-semibold leading-none text-[#0B0914]" style={{ flex: `${Math.max(1, w.contributions[k])} 1 0`, background: FEATURE_COLORS[k] }}>
                  {w.contributions[k]}
                </div>
              ))}
              <div className="bg-white/[0.06]" style={{ flex: `${rest} 1 0` }} />
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-2.5">
              {keys.map((k) => (
                <div key={k} className="flex items-center gap-2 text-[13px] text-ink-2">
                  <span aria-hidden className="h-2.5 w-2.5 rounded-[3px]" style={{ background: FEATURE_COLORS[k] }} />
                  {FEATURE_LABELS[k]}
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-2.5 border-t border-violet/[0.14] pt-1.5">
              {w.reasons.slice(0, 3).map((r, i) => (
                <div key={i} className="flex gap-3 pt-2.5 text-sm text-ink-2">
                  <span className="font-mono text-xs leading-[1.6] text-violet">0{i + 1}</span>
                  {r}
                </div>
              ))}
            </div>
          </div>
        ) : radar.isPending || q.isPending ? (
          <Skeleton className="h-56" />
        ) : (
          <p className="text-sm text-dim">Score breakdowns appear here once the radar has scored its first wallets.</p>
        )}
      </div>
    </section>
  );
}

export function FinalCta() {
  const { data: session } = useSession();
  const openWallet = useUi((s) => s.openWallet);
  return (
    <div className="flex flex-wrap items-end justify-between gap-6">
      <h2 className="max-w-[680px] font-display text-[clamp(32px,4.6vw,60px)] font-semibold leading-none tracking-[-0.035em] [text-wrap:balance]">Trade with the graph on your side.</h2>
      <div className="flex flex-wrap gap-3">
        {session ? (
          <>
            <Link href="/markets" className="gg-btn gg-btn-primary h-[52px] px-[26px] text-base text-white shadow-[0_0_40px_rgba(91,44,143,0.55)] hover:text-white">
              Explore markets →
            </Link>
            <Link href="/radar" className="gg-btn h-[52px] border-white/[0.18] px-6 text-base">
              Open the Radar
            </Link>
          </>
        ) : (
          <button type="button" onClick={() => openWallet('/markets')} className="gg-btn gg-btn-primary h-[52px] px-[26px] text-base shadow-[0_0_40px_rgba(91,44,143,0.55)]">
            Connect wallet to start →
          </button>
        )}
      </div>
    </div>
  );
}
