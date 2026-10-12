'use client';

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { MeResp, UserSettings } from '@groundgraph/sdk/api-types';
import { Switch, cn } from '@groundgraph/ui';
import { api } from '@/lib/api';
import { fmtDT, fromBase, toBase, usd } from '@/lib/format';
import { qk } from '@/lib/queries';
import { useUi } from '@/lib/stores';

const eyebrow = 'font-mono text-[11px] font-medium leading-none tracking-[0.06em] uppercase text-faint';
const DAILY = [100, 500, 1000, null] as const;
const BREAKS: { days: 1 | 7 | 30; label: string }[] = [
  { days: 1, label: '24 hours' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
];

export function remainingDays(breakUntil: string | null | undefined, now = Date.now()): number {
  if (!breakUntil) return 0;
  return Math.max(0, (new Date(breakUntil).getTime() - now) / 86_400_000);
}

export function TradingLimits({ me, readOnly }: { me: MeResp; readOnly: boolean }) {
  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);
  const st = me.settings;
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<1 | 7 | 30 | null>(null);
  const [tabStart] = useState(() => Date.now());
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const apply = (s: UserSettings) => qc.setQueryData<MeResp>(qk.me, (old) => (old ? { ...old, settings: s } : old));
  const save = async (patch: { dailyLimitUsdc?: string | null; sessionReminder?: boolean }, msg: string) => {
    setBusy(true);
    try {
      const s = await api.putSettings({ dailyLimitUsdc: patch.dailyLimitUsdc !== undefined ? patch.dailyLimitUsdc : st.dailyLimitUsdc, sessionReminder: patch.sessionReminder ?? st.sessionReminder });
      apply(s);
      toast({ tone: 'success', title: msg });
    } catch (e) {
      toast({ tone: 'error', title: 'Could not save your limit', body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const startBreak = async (days: 1 | 7 | 30) => {
    setBusy(true);
    try {
      apply(await api.startBreak(days));
      setAsk(null);
      toast({ tone: 'success', title: 'Break started', body: 'Buying and creating are paused. Selling and redeeming still work.' });
    } catch (e) {
      toast({ tone: 'error', title: 'Could not start the break', body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const limit = st.dailyLimitUsdc ? fromBase(st.dailyLimitUsdc) : null;
  const spent = fromBase(st.spentToday);
  const usedPct = limit ? Math.min(100, (spent / limit) * 100) : 0;
  const left = remainingDays(st.breakUntil);
  const onBreak = left > 0;
  const mins = Math.floor((Date.now() - tabStart) / 60_000) + 0 * tick;
  const options = BREAKS.filter((b) => b.days > left);

  return (
    <section id="limits" data-component="TradingLimits" className="mt-4 flex scroll-mt-24 flex-wrap items-start gap-x-8 gap-y-5 rounded-[20px] border border-violet/[0.14] p-[clamp(16px,2.4vw,24px)]" style={{ background: 'var(--gg-surface)' }}>
      <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-3.5">
        <div className="flex flex-col gap-1.5">
          <h2 className="font-display text-lg font-semibold leading-[1.2]">Trading limits</h2>
          <span className="text-[13px] leading-normal text-dim">Your own guardrails. They apply to new positions and new markets; selling, merging and redeeming always work.</span>
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex justify-between gap-2 font-mono text-xs font-medium leading-none">
            <span className="text-muted">Used today</span>
            <span className="text-body" data-testid="used-today">
              {limit != null ? `${usd(spent)} of ${usd(limit)}` : `${usd(spent)} · no limit set`}
            </span>
          </div>
          <span className="block h-1.5 overflow-hidden rounded-[3px] bg-white/[0.06]">
            <span className="block h-full rounded-[3px] transition-[width] duration-[600ms]" style={{ width: `${usedPct}%`, background: usedPct > 85 ? '#E046F0' : 'var(--gg-gradient-bar)' }} />
          </span>
        </div>
      </div>

      <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-2.5">
        <span className={eyebrow}>Daily limit</span>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Daily limit">
          {DAILY.map((v) => {
            const on = v == null ? st.dailyLimitUsdc == null : st.dailyLimitUsdc === toBase(String(v));
            return (
              <button key={String(v)} type="button" aria-pressed={on} disabled={busy || readOnly} onClick={() => void save({ dailyLimitUsdc: v == null ? null : toBase(String(v)) }, v == null ? 'Daily limit removed' : `Daily limit set to ${usd(v)}`)} className={cn('h-9 rounded-pill border px-3.5 font-sans text-[13px] font-medium transition-colors disabled:opacity-60', on ? 'border-violet/55 bg-violet/[0.22] text-white' : 'border-violet/[0.18] bg-transparent text-muted hover:border-violet/45')}>
                {v == null ? 'No limit' : `$${v.toLocaleString('en-US')}`}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-2.5">
        <span className={eyebrow}>Take a break</span>
        {onBreak ? (
          <div data-component="BreakActive" role="status" className="flex flex-col gap-1.5 rounded-xl border border-above/25 bg-above/[0.06] p-3 text-[13px] leading-[1.45] text-ink-2">
            <span>
              Break active until <b className="font-semibold text-above-text">{fmtDT(st.breakUntil!)}</b>. Buying and creating resume automatically. A break can be extended, never shortened.
            </span>
          </div>
        ) : null}
        {options.length > 0 && !ask ? (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={onBreak ? 'Extend break' : 'Take a break'}>
            {options.map((b) => (
              <button key={b.days} type="button" disabled={busy || readOnly} onClick={() => setAsk(b.days)} className="h-9 rounded-pill border border-violet/[0.18] bg-transparent px-3.5 font-sans text-[13px] font-medium text-muted transition-colors hover:border-violet/45 disabled:opacity-60">
                {onBreak ? 'Extend to ' : ''}
                {b.label}
              </button>
            ))}
          </div>
        ) : null}
        {ask ? (
          <div role="alertdialog" aria-label="Confirm break" className="flex animate-gg-in flex-col gap-2.5 rounded-xl border border-violet/30 bg-violet/[0.08] p-3">
            <span className="text-[13px] leading-[1.45] text-body">
              Pause buying and creating for {BREAKS.find((b) => b.days === ask)!.label}? You can still sell, merge and redeem. A break cannot be shortened once started.
            </span>
            <div className="flex gap-2">
              <button type="button" onClick={() => void startBreak(ask)} disabled={busy} className="gg-btn gg-btn-primary h-10 rounded-[10px] px-4 text-[13px]">
                Start break
              </button>
              <button type="button" onClick={() => setAsk(null)} className="gg-btn gg-btn-quiet h-10 rounded-[10px] px-4 text-[13px]">
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-3 text-[13px] text-ink-2">
          <span className="flex flex-col gap-[3px]">
            Hourly session reminder
            <span className="font-mono text-[11px] leading-none text-faint">Time in this tab: {Math.floor(mins / 60)}h {String(mins % 60).padStart(2, '0')}m</span>
          </span>
          <Switch on={st.sessionReminder} onChange={(v) => void save({ sessionReminder: v }, v ? 'Hourly reminder on' : 'Hourly reminder off')} label="Hourly session reminder" />
        </div>
      </div>
    </section>
  );
}
