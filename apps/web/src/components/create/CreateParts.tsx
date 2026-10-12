'use client';

import type { ReactNode } from 'react';
import { AssetMonogram, Checkbox, DepthMeter, Switch, cn } from '@groundgraph/ui';
import { cents, spotFmt, tgtFmt, usd } from '@/lib/format';
import { type Ladder } from '@/lib/create';
import type { AssetRow } from '@/lib/api';

export const labelCls = 'font-mono text-xs font-medium leading-none tracking-[0.06em] uppercase text-dim';

export function Field({ label, htmlFor, right, children }: { label: string; htmlFor?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={htmlFor} className={labelCls}>
          {label}
        </label>
        {right}
      </div>
      {children}
    </div>
  );
}

/* ------------------------------ step 1 ------------------------------ */

export function MarketTypePicker() {
  return (
    <div className="flex flex-col gap-2.5" data-component="MarketTypePicker">
      <span className={labelCls}>Market type</span>
      <div className="flex flex-wrap gap-2">
        <span aria-current="true" className="inline-flex h-10 items-center gap-2 rounded-xl border border-above/50 bg-above/[0.08] px-3.5 text-[13px] font-semibold text-ink">
          Close
          <span className="font-mono text-[11px] font-medium text-above-text">price at the close</span>
        </span>
        <span aria-disabled="true" title="Touch markets are not enabled in this version" className="inline-flex h-10 cursor-not-allowed items-center gap-2 rounded-xl border border-dashed border-violet/25 px-3.5 text-[13px] font-semibold text-faint">
          Touch
          <span className="rounded-md bg-violet/[0.14] px-1.5 py-1 font-mono text-[10px] font-semibold leading-none text-violet-pale">COMING SOON</span>
        </span>
      </div>
    </div>
  );
}

export function AssetPicker({ assets, value, onPick, loading, error }: { assets: AssetRow[] | undefined; value: string; onPick: (symbol: string) => void; loading: boolean; error: boolean }) {
  return (
    <div data-component="AssetPicker" className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-3">
        <span className={labelCls} id="asset-label">
          Asset
        </span>
        <span className="flex items-center gap-1.5 font-mono text-[11px] leading-none text-faint">
          <span aria-hidden className="gg-dot !h-1.5 !w-1.5" />
          Oracle prices
        </span>
      </div>
      {error ? <div className="rounded-xl border border-dashed border-below/30 p-4 text-[13px] text-below-text">Asset prices are unavailable right now. Try again in a moment.</div> : null}
      <div role="radiogroup" aria-labelledby="asset-label" className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2">
        {loading
          ? Array.from({ length: 6 }, (_, i) => <div key={i} className="gg-skeleton h-[62px] !rounded-[14px]" />)
          : (assets ?? []).map((a) => {
              const on = a.symbol === value;
              const none = a.price == null;
              return (
                <button
                  key={a.symbol}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={none}
                  onClick={() => onPick(a.symbol)}
                  data-testid={`asset-${a.symbol}`}
                  className={cn('flex flex-col items-start gap-2 rounded-[14px] border p-3 text-left text-body transition-all', on ? 'border-above/60 bg-above/[0.08] shadow-[0_0_20px_rgba(44,230,214,0.15)]' : 'border-violet/[0.14] bg-white/[0.02] hover:border-violet/45', none && 'opacity-50')}
                >
                  <span className="font-display text-[15px] font-semibold leading-none">{a.symbol}</span>
                  <span className="font-mono text-xs font-medium leading-none tabular-nums text-muted">{a.price != null ? spotFmt(a.price) : 'No price'}</span>
                </button>
              );
            })}
      </div>
    </div>
  );
}

export function TargetLadder({
  target,
  onTarget,
  spot,
  diff,
  lad,
  error,
  presets,
  onPreset,
  asset,
}: {
  target: string;
  onTarget: (v: string) => void;
  spot: number | null;
  diff: number | null;
  lad: Ladder | null;
  error: string;
  presets: number[];
  onPreset: (pct: number) => void;
  asset: string;
}) {
  const diffColor = diff == null ? '#8F8AA6' : diff >= 0 ? '#2CE6D6' : '#E046F0';
  return (
    <div data-component="TargetLadder" className="flex flex-col gap-3">
      <label htmlFor="target-price" className={labelCls}>
        Target price (USD)
      </label>
      <div className="gg-field h-14" data-invalid={!!error && target !== ''}>
        <span className="font-display text-xl font-semibold leading-none text-faint">$</span>
        <input id="target-price" value={target} onChange={(e) => /^\d*\.?\d{0,9}$/.test(e.target.value) && onTarget(e.target.value)} inputMode="decimal" autoComplete="off" placeholder={spot ? String(Math.round(spot * 1.1)) : '0'} aria-label={`${asset} target price`} aria-invalid={!!error} className="font-display text-[22px] font-semibold leading-none" />
        {diff != null && target ? (
          <span className="font-mono text-xs font-medium leading-none" style={{ color: diffColor }}>
            {diff >= 0 ? '+' : '−'}
            {Math.abs(diff).toFixed(1)}% vs spot
          </span>
        ) : null}
      </div>
      {lad && spot ? (
        <>
          <div className="relative mx-2 mt-1 h-16" aria-hidden>
            <span className="absolute inset-x-0 top-[30px] h-1 rounded-sm bg-white/[0.06]" />
            <span className="absolute top-[22px] flex h-5 items-center justify-end overflow-hidden whitespace-nowrap rounded-md border border-dashed border-above/35 bg-above/[0.07] px-2 font-mono text-[10px] font-medium leading-none text-above transition-[left,width] duration-300" style={{ left: `${lad.zoneL}%`, width: `${lad.zoneW}%` }}>
              ABOVE
            </span>
            <span className="absolute top-0 flex -translate-x-1/2 flex-col items-center gap-1 transition-[left] duration-300" style={{ left: `${lad.spotX}%` }}>
              <span className="whitespace-nowrap font-mono text-[10px] font-medium leading-none text-muted">Spot {spotFmt(spot)}</span>
              <span className="h-8 w-0.5 rounded-sm bg-body" />
            </span>
            <span className="absolute top-[25px] flex -translate-x-1/2 flex-col items-center gap-2.5 transition-[left] duration-300" style={{ left: `${lad.tgtX}%` }}>
              <span className="h-3 w-3 rotate-45 bg-above shadow-[0_0_12px_rgba(44,230,214,0.8)]" />
              <span className="whitespace-nowrap font-mono text-[10px] font-medium leading-none text-above">{Number(target) > 0 ? `Target ${tgtFmt(Number(target))}` : 'Target not set'}</span>
            </span>
          </div>
          <input type="range" min={lad.min} max={lad.max} step={lad.step} value={lad.val} onChange={(e) => onTarget(String(+Number(e.target.value).toPrecision(5)))} aria-label="Target price slider" className="mt-1.5 w-full" />
        </>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {presets.map((p) => (
          <button key={p} type="button" onClick={() => onPreset(p)} disabled={!spot} className="h-[34px] rounded-pill border border-violet/20 bg-transparent px-3 font-mono text-xs font-medium text-muted transition-colors hover:border-above/50 hover:text-body disabled:opacity-40">
            {p > 0 ? '+' : '−'}
            {Math.abs(p)}%
          </button>
        ))}
        {error && target !== '' ? (
          <span role="alert" className="ml-auto text-xs text-below-text">
            {error}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function QuestionPreview({ question, fair, fairNote, fairLoading, fairError }: { question: string; fair: number | null; fairNote: string; fairLoading: boolean; fairError: boolean }) {
  return (
    <div data-component="QuestionPreview" className="flex flex-col gap-2 rounded-[14px] border border-violet/[0.18] bg-violet/[0.06] px-[18px] py-4">
      <span className="gg-eyebrow">Market question</span>
      <span className="font-display text-lg font-medium leading-[1.35] text-ink [text-wrap:pretty]" data-testid="question-preview">
        {question}
      </span>
      <div data-component="FairValue" className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-2.5 border-t border-violet/[0.14] pt-3">
        <span className="gg-eyebrow">Model fair value</span>
        {fair != null ? (
          <span className="font-display text-[22px] font-semibold leading-none text-above" data-testid="fair-value">
            ABOVE {cents(fair)}
          </span>
        ) : (
          <span className="font-display text-lg font-semibold leading-none text-violet-pale">{fairLoading ? 'Calculating' : fairError ? 'Unavailable' : 'Enter a target'}</span>
        )}
        <span className="min-w-[220px] flex-[1_1_220px] text-xs leading-[1.45] text-dim">{fairNote}</span>
      </div>
    </div>
  );
}

/* ------------------------------ step 2 ------------------------------ */

export function DurationPicker({ days, onDays, date, onDate, note, error }: { days: number | null; onDays: (d: number) => void; date: string; onDate: (v: string) => void; note: string; error: boolean }) {
  return (
    <div data-component="DurationPicker" className="flex flex-col gap-2.5">
      <label htmlFor="resolve-date" className={labelCls}>
        Resolves
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Duration" className="flex rounded-[14px] border border-violet/[0.18] p-1">
          {[7, 14, 30, 60].map((d) => (
            <button key={d} type="button" aria-pressed={days === d} onClick={() => onDays(d)} className={cn('h-11 rounded-[10px] border-0 px-4 font-mono text-[13px] font-semibold transition-colors min-[760px]:h-10', days === d ? 'bg-brand text-white' : 'bg-transparent text-muted hover:text-body')}>
              {d}d
            </button>
          ))}
        </div>
        <input id="resolve-date" type="date" value={date} onChange={(e) => onDate(e.target.value)} aria-label="Resolution date" aria-invalid={error} className={cn('h-12 rounded-[14px] border bg-white/[0.03] px-3.5 font-sans text-sm font-medium outline-none [color-scheme:dark] focus:border-above/70', error ? 'border-below/50' : 'border-violet/[0.24]')} />
      </div>
      <span className="text-[13px] text-dim">{note}</span>
    </div>
  );
}

export function ResolutionSource({ asset }: { asset: string }) {
  return (
    <Field label="Resolution source">
      <div className="flex min-h-[52px] items-center gap-2.5 rounded-[14px] border border-violet/[0.14] bg-white/[0.015] px-3.5 py-3 font-mono text-[13px] font-medium leading-[1.4] text-ink-2">
        <span aria-hidden className="h-2 w-2 flex-none rounded-full bg-above shadow-[0_0_8px_#2CE6D6]" />
        Pyth {asset}/USD · price at 23:59 UTC close · fixed at launch
      </div>
    </Field>
  );
}

export function LiquidityInput({ value, onChange, error, level, label, note }: { value: string; onChange: (v: string) => void; error: boolean; level: 1 | 2 | 3; label: string; note: string }) {
  const n = Number(value) || 0;
  return (
    <div data-component="LiquidityInput" className="flex flex-col gap-2.5">
      <label htmlFor="liq" className={labelCls}>
        Initial liquidity (USDC)
      </label>
      <div className="gg-field h-14" data-invalid={error}>
        <input id="liq" value={value} onChange={(e) => /^\d*\.?\d{0,6}$/.test(e.target.value) && onChange(e.target.value)} inputMode="decimal" autoComplete="off" aria-label="Initial liquidity" aria-invalid={error} className="font-display text-[22px] font-semibold leading-none" />
        <span className="font-mono text-[13px] leading-none text-faint">USDC</span>
      </div>
      <input type="range" min={100} max={10000} step={100} value={Math.min(10000, Math.max(100, n))} onChange={(e) => onChange(e.target.value)} aria-label="Liquidity slider" className="w-full" />
      <DepthMeter level={level} label={label} note={note} />
    </div>
  );
}

export function SeedPicker({
  seed,
  onSeed,
  fair,
  fairOk,
  arb,
}: {
  seed: 'fair' | 'even';
  onSeed: (s: 'fair' | 'even') => void;
  fair: number | null;
  fairOk: boolean;
  arb: { text: string; warn: boolean };
}) {
  const opts: { id: 'fair' | 'even'; label: string; tag: string; tagColor: string; price: string; disabled?: boolean }[] = [
    { id: 'fair', label: 'Model fair value', tag: 'RECOMMENDED', tagColor: '#2CE6D6', price: fair != null ? `${cents(fair)} / ${cents(1 - fair)}` : 'Unavailable', disabled: !fairOk },
    { id: 'even', label: 'Even 50/50', tag: 'SIMPLE', tagColor: '#9B6BFF', price: '50¢ / 50¢' },
  ];
  return (
    <div data-component="SeedPicker" className="flex flex-col gap-2.5">
      <span className={labelCls} id="seed-label">
        Opening price
      </span>
      <div role="radiogroup" aria-labelledby="seed-label" className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-2">
        {opts.map((o) => (
          <button key={o.id} type="button" role="radio" aria-checked={seed === o.id} disabled={o.disabled} onClick={() => onSeed(o.id)} className={cn('flex flex-col items-start gap-2 rounded-[14px] border p-3.5 text-left text-body transition-colors disabled:opacity-50', seed === o.id ? 'border-above/55 bg-above/[0.08]' : 'border-violet/[0.14] bg-white/[0.02] hover:border-violet/45')}>
            <span className="flex w-full justify-between gap-2">
              <span className="font-sans text-sm font-semibold leading-[1.2]">{o.label}</span>
              <span className="font-mono text-[10px] font-semibold leading-[1.2]" style={{ color: o.tagColor }}>
                {o.tag}
              </span>
            </span>
            <span className="font-display text-xl font-semibold leading-none">{o.price}</span>
          </button>
        ))}
      </div>
      <div data-component="ArbLossNote" className={cn('flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-[13px] leading-normal text-ink-2 transition-colors', arb.warn ? 'border-below/30 bg-below/[0.07]' : 'border-above/[0.22] bg-above/[0.06]')}>
        <span aria-hidden className={cn('mt-1.5 h-2 w-2 flex-none rounded-full', arb.warn ? 'bg-below' : 'bg-above')} />
        {arb.text}
      </div>
    </div>
  );
}

export function FeePicker({ fee, onFee, dyn, onDyn, note }: { fee: '0.5' | '1' | '2'; onFee: (f: '0.5' | '1' | '2') => void; dyn: boolean; onDyn: (v: boolean) => void; note: string }) {
  return (
    <div data-component="FeePicker" className="flex flex-col gap-2.5">
      <span className={labelCls} id="fee-label">
        Base fee to liquidity providers
      </span>
      <div role="group" aria-labelledby="fee-label" className="flex w-fit rounded-[14px] border border-violet/[0.18] p-1">
        {(['0.5', '1', '2'] as const).map((f) => (
          <button key={f} type="button" aria-pressed={fee === f} onClick={() => onFee(f)} className={cn('h-11 rounded-[10px] border-0 px-[18px] font-mono text-sm font-semibold transition-colors min-[760px]:h-10', fee === f ? 'bg-brand text-white' : 'bg-transparent text-muted hover:text-body')}>
            {f}%
          </button>
        ))}
      </div>
      <span className="text-[13px] text-dim">{note}</span>
      <div data-component="DynamicFeeToggle" className="flex items-center justify-between gap-3 rounded-xl border border-violet/[0.16] px-3.5 py-3 text-[13px] text-ink-2">
        <span className="flex flex-col gap-1">
          <b className="font-semibold">Dynamic fee · recommended</b>
          <span className="text-xs leading-[1.45] text-dim">Rises with time to resolution and with recent flagged-wallet flow, so informed flow pays LPs instead of draining them. The program caps the total.</span>
        </span>
        <Switch on={dyn} onChange={onDyn} label="Dynamic fee" />
      </div>
    </div>
  );
}

/* ------------------------------ step 3 ------------------------------ */

export function ReviewSummary({ rows }: { rows: { k: string; v: string }[] }) {
  return (
    <dl data-component="ReviewSummary" className="m-0 flex flex-col overflow-hidden rounded-2xl border border-violet/[0.14]">
      {rows.map((r) => (
        <div key={r.k} className="flex justify-between gap-4 border-b border-violet/[0.08] px-4 py-3.5 text-sm last:border-b-0">
          <dt className="flex-none text-dim">{r.k}</dt>
          <dd className="m-0 text-right font-mono text-[13px] text-body">{r.v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function RuleBox({ text }: { text: string }) {
  return (
    <div data-component="ResolutionRules" className="flex gap-3 rounded-[14px] border border-above/20 bg-above/5 px-4 py-3.5 text-sm leading-normal text-ink-2">
      <span className="flex-none pt-[3px] font-mono text-[11px] font-medium leading-[1.9] text-above">RULE</span>
      {text}
    </div>
  );
}

export function CostSummary({ deposit }: { deposit: string }) {
  return (
    <div data-component="CostSummary" className="flex flex-wrap items-end justify-between gap-3 px-0.5 py-1">
      <div className="flex flex-col gap-2">
        <span className="gg-eyebrow">You deposit</span>
        <span className="font-display text-[30px] font-semibold leading-none tracking-[-0.02em]" data-testid="deposit">
          {deposit}
        </span>
      </div>
      <span className="font-mono text-xs leading-[1.4] text-faint">Plus a small SOL network fee and account rent. Test USDC on devnet has no monetary value.</span>
    </div>
  );
}

export function AckBox({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <Checkbox checked={checked} onChange={onChange} className="text-sm text-muted">
      I understand the question, rule and oracle are final once the market is live.
    </Checkbox>
  );
}

/* ------------------------------ preview ------------------------------ */

export function MarketPreview({
  mode,
  onMode,
  asset,
  category,
  question,
  openPrice,
  openNote,
  liq,
  fee,
  hoursLeft,
  rule,
}: {
  mode: 'card' | 'detail';
  onMode: (m: 'card' | 'detail') => void;
  asset: string;
  category: string;
  question: string;
  openPrice: number | null;
  openNote: string;
  liq: number;
  fee: string;
  hoursLeft: string;
  rule: string;
}) {
  return (
    <aside data-component="MarketPreview" className="flex min-w-0 flex-[1_1_320px] flex-col gap-3.5 min-[900px]:sticky min-[900px]:top-[88px]">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[11px] font-medium leading-none tracking-[0.08em] uppercase text-faint">Live preview</span>
        <div role="group" aria-label="Preview mode" className="gg-seg">
          {(['card', 'detail'] as const).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} data-on={mode === m} onClick={() => onMode(m)} className="gg-seg-btn">
              {m === 'card' ? 'Card' : 'Detail'}
            </button>
          ))}
        </div>
      </div>
      {mode === 'card' ? (
        <article data-component="MarketCard" data-variant="preview" className="flex animate-gg-in flex-col gap-4 rounded-[20px] border border-violet/30 p-5 shadow-[0_0_60px_rgba(91,44,143,0.25)]" style={{ background: 'var(--gg-surface)' }}>
          <div className="flex items-center gap-2.5">
            <AssetMonogram symbol={asset} />
            <div className="flex flex-col gap-0.5">
              <span className="font-display text-sm font-semibold leading-[1.2]">{asset}</span>
              <span className="text-xs text-faint">{category}</span>
            </div>
            <span className="ml-auto rounded-md bg-violet/[0.18] px-2 py-1 font-mono text-[10px] font-semibold leading-none text-violet-pale">NEW</span>
            <span className="rounded-pill border border-white/[0.06] bg-white/[0.04] px-2.5 py-[5px] font-mono text-[11px] font-medium leading-none text-muted">⏱ {hoursLeft}</span>
          </div>
          <h3 className="font-display text-[17px] font-medium leading-[1.35] text-ink [text-wrap:pretty]">{question}</h3>
          <div className="flex items-end gap-3.5">
            <div className="flex flex-col gap-1">
              <span className="font-mono text-[11px] font-medium leading-none text-faint">ABOVE</span>
              <span className="font-display text-[34px] font-semibold leading-none">{openPrice != null ? cents(openPrice) : '–'}</span>
              <span className="font-mono text-xs font-medium leading-none text-faint">{openNote}</span>
            </div>
            <div className="relative h-14 flex-1 border-b border-dashed border-violet/30">
              <span className="absolute inset-x-0 top-1/2 h-px" style={{ background: 'var(--gg-gradient-bar)' }} />
            </div>
          </div>
          <div className="flex flex-col gap-2 rounded-xl border border-dashed border-violet/20 bg-white/[0.025] p-3">
            <div className="flex justify-between text-xs">
              <span className="text-muted">
                Radar · <b className="font-semibold text-violet">Building</b>
              </span>
              <span className="font-mono text-[13px] font-semibold leading-none text-faint">–</span>
            </div>
            <span className="font-mono text-[11px] leading-[1.4] text-faint">Signal appears after the first 10 scored trades</span>
          </div>
          <div className="flex justify-between font-mono text-[11px] leading-none text-faint">
            <span>Liq {usd(liq)}</span>
            <span>Fee {fee}%</span>
          </div>
        </article>
      ) : (
        <article data-component="MarketHeader" data-variant="preview" className="flex animate-gg-in flex-col gap-4 rounded-[20px] border border-violet/30 p-5 shadow-[0_0_60px_rgba(91,44,143,0.25)]" style={{ background: 'var(--gg-surface)' }}>
          <div className="flex items-start gap-3">
            <AssetMonogram symbol={asset} size={40} />
            <div className="flex min-w-0 flex-col gap-2">
              <span className="font-display text-[17px] font-semibold leading-[1.3] text-ink [text-wrap:pretty]">{question}</span>
              <span className="font-mono text-[11px] leading-[1.4] text-dim">
                ⏱ {hoursLeft} · Liq {usd(liq)} · Pyth {asset}/USD
              </span>
            </div>
          </div>
          <div className="flex items-end gap-6">
            <div className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] font-medium leading-none text-faint">ABOVE</span>
              <span className="font-display text-[40px] font-semibold leading-[0.9]">{openPrice != null ? cents(openPrice) : '–'}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] font-medium leading-none text-faint">BELOW</span>
              <span className="font-display text-2xl font-semibold leading-[0.9] text-muted">{openPrice != null ? cents(1 - openPrice) : '–'}</span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <span className="grid h-11 place-items-center rounded-xl border border-above/30 bg-above/[0.08] font-sans text-[13px] font-semibold text-above-text">Buy ABOVE {openPrice != null ? cents(openPrice) : ''}</span>
            <span className="grid h-11 place-items-center rounded-xl border border-below/30 bg-below/[0.08] font-sans text-[13px] font-semibold text-below-text">Buy BELOW {openPrice != null ? cents(1 - openPrice) : ''}</span>
          </div>
          <span className="text-[13px] leading-normal text-muted">{rule}</span>
        </article>
      )}
      <div className="flex gap-2.5 rounded-[14px] border border-dashed border-violet/[0.22] px-4 py-3.5 text-[13px] leading-normal text-dim">
        <span aria-hidden className="mt-1.5 h-2 w-2 flex-none rounded-full bg-violet" />
        The smart money radar starts scoring this market after its first 10 trades. Until then its signal reads &quot;Building&quot;.
      </div>
    </aside>
  );
}

