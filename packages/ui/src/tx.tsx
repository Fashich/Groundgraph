'use client';

import type { ReactNode } from 'react';
import { ProgressBar, Spinner } from './primitives';
import { cn } from './cn';

/** In-flight transaction: sign then confirm, with a progress bar. */
export function TxStatus({ label, sub, progress }: { label: string; sub: string; progress: number }) {
  return (
    <div data-component="TxStatus" role="status" aria-live="polite" className="flex animate-gg-in flex-col gap-3 rounded-[14px] border border-violet/25 bg-violet/[0.08] px-4 py-3.5">
      <div className="flex items-center gap-3">
        <Spinner />
        <div className="flex flex-col gap-[3px]">
          <span className="text-sm text-body">{label}</span>
          <span className="font-mono text-[11px] leading-none text-faint">{sub}</span>
        </div>
      </div>
      <ProgressBar pct={progress} />
    </div>
  );
}

export interface TxErrorAction {
  label: string;
  onClick: () => void;
}

export function TxError({ title, body, code, primary, secondary, onDismiss, dismissLabel = 'Dismiss' }: { title: string; body: ReactNode; code?: string; primary?: TxErrorAction; secondary?: TxErrorAction; onDismiss?: () => void; dismissLabel?: string }) {
  return (
    <div data-component="TxError" role="alert" className="flex animate-gg-sheet flex-col gap-2.5 rounded-[14px] border border-below/35 bg-below/[0.07] p-4">
      <div className="flex items-center gap-2.5">
        <span aria-hidden className="grid h-6 w-6 flex-none place-items-center rounded-full bg-below text-sm font-bold text-bg">!</span>
        <span className="font-display text-[15px] font-semibold leading-tight">{title}</span>
      </div>
      <span className="text-[13px] leading-normal text-ink-2">{body}</span>
      {code ? <code className="break-words font-mono text-[11px] leading-[1.4] text-faint">{code}</code> : null}
      <div className="flex flex-wrap gap-2">
        {primary ? (
          <button type="button" onClick={primary.onClick} className="gg-btn gg-btn-primary h-10 rounded-[10px] px-4 text-[13px]">
            {primary.label}
          </button>
        ) : null}
        {secondary ? (
          <button type="button" onClick={secondary.onClick} className="gg-btn gg-btn-ghost h-10 rounded-[10px] px-4 text-[13px]">
            {secondary.label}
          </button>
        ) : null}
        {onDismiss ? (
          <button type="button" onClick={onDismiss} className="gg-btn gg-btn-quiet h-10 rounded-[10px] px-4 text-[13px]">
            {dismissLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function TradeReceipt({ title, sub, footer }: { title: string; sub: ReactNode; footer: ReactNode }) {
  return (
    <div data-component="TradeReceipt" role="status" aria-live="polite" className={cn('flex animate-gg-sheet flex-col gap-2.5 rounded-[14px] border border-above/30 bg-above/[0.07] p-4')}>
      <div className="flex items-center gap-2.5">
        <span aria-hidden className="grid h-6 w-6 flex-none place-items-center rounded-full bg-above text-[13px] font-bold text-bg shadow-[0_0_16px_rgba(44,230,214,0.5)]">✓</span>
        <span className="font-display text-[15px] font-semibold leading-tight">{title}</span>
      </div>
      <span className="text-[13px] text-ink-2">{sub}</span>
      <div className="flex justify-between gap-2 font-mono text-[11px] leading-none text-faint">{footer}</div>
    </div>
  );
}
