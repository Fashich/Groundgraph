'use client';

import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

/* ------------------------------ Button ------------------------------ */

export type ButtonVariant = 'primary' | 'ghost' | 'quiet' | 'above' | 'below' | 'plain';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Visual height. Touch devices should use 'lg' or 'md' (>= 44px). */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Looks and announces as disabled but stays focusable and clickable (used for "Connect a signing wallet" CTAs). */
  softDisabled?: boolean;
}

const BTN_SIZE: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'h-9 px-3.5 text-[13px]',
  md: 'h-11 px-[18px] text-[14px]',
  lg: 'h-12 px-6 text-[15px]',
  xl: 'h-[52px] px-[26px] text-[16px]',
};

export function Button({ variant = 'primary', size = 'md', softDisabled, className, children, ...rest }: ButtonProps) {
  const v = variant === 'plain' ? '' : `gg-btn-${variant}`;
  return (
    <button
      type="button"
      {...rest}
      aria-disabled={softDisabled || rest.disabled || undefined}
      className={cn('gg-btn', v, BTN_SIZE[size], softDisabled && 'opacity-60', className)}
    >
      {children}
    </button>
  );
}

export function IconButton({ className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...rest} className={cn('gg-btn-icon', className)}>
      {children}
    </button>
  );
}

/* ------------------------------ Text bits ------------------------------ */

export function Eyebrow({ children, className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span {...rest} className={cn('gg-eyebrow', className)}>
      {children}
    </span>
  );
}

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('gg-section-label', className)}>{children}</div>;
}

export function Pill({ children, className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span {...rest} className={cn('gg-pill', className)}>
      {children}
    </span>
  );
}

/* ------------------------------ Segmented control ------------------------------ */

export interface SegOption<T extends string> {
  value: T;
  label: ReactNode;
  count?: number | null;
  countTone?: 'dim' | 'violet';
  disabled?: boolean;
}

export interface SegmentedProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: SegOption<T>[];
  label?: string;
  ariaLabel: string;
  /** tablist renders role=tab with aria-selected; group renders aria-pressed buttons. */
  role?: 'tablist' | 'group';
  className?: string;
  btnClassName?: string;
  'data-component'?: string;
}

export function Segmented<T extends string>({ value, onChange, options, label, ariaLabel, role = 'group', className, btnClassName, ...rest }: SegmentedProps<T>) {
  const tab = role === 'tablist';
  return (
    <div role={role} aria-label={ariaLabel} className={cn('gg-seg', className)} data-component={rest['data-component']}>
      {label ? <span className="gg-seg-label">{label}</span> : null}
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role={tab ? 'tab' : undefined}
            aria-selected={tab ? on : undefined}
            aria-pressed={tab ? undefined : on}
            data-on={on}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cn('gg-seg-btn', o.count != null && 'inline-flex items-center gap-1.5', btnClassName)}
          >
            {o.label}
            {o.count != null ? <span className={cn('font-mono text-[11px]', o.countTone === 'violet' ? 'text-violet-pale' : 'text-faint')}>{o.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function Chip({ on, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { on?: boolean }) {
  return (
    <button type="button" {...rest} aria-pressed={on} data-on={on} className={cn('gg-chip', className)}>
      {children}
    </button>
  );
}

/* ------------------------------ Toggles ------------------------------ */

export function Switch({ on, onChange, label, className, id }: { on: boolean; onChange: (next: boolean) => void; label: string; className?: string; id?: string }) {
  return <button type="button" id={id} role="switch" aria-checked={on} aria-label={label} data-on={on} onClick={() => onChange(!on)} className={cn('gg-switch', className)} />;
}

export function Checkbox({ checked, onChange, label, children, className }: { checked: boolean; onChange: (next: boolean) => void; label?: string; children?: ReactNode; className?: string }) {
  return (
    <label className={cn('relative flex cursor-pointer items-start gap-3', className)}>
      <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
      <span aria-hidden className="gg-check mt-px peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-above" data-on={checked}>
        {checked ? '✓' : ''}
      </span>
      {children}
    </label>
  );
}

/* ------------------------------ Indicators ------------------------------ */

export function Spinner({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <span
      role="presentation"
      className={cn('inline-block flex-none animate-gg-spin rounded-full border-2 border-violet/20 border-t-above', className)}
      style={{ width: size, height: size }}
    />
  );
}

export function LiveDot({ tone = 'above', className }: { tone?: 'above' | 'below'; className?: string }) {
  return <span aria-hidden className={cn('gg-dot', tone === 'below' && 'gg-dot-below', className)} />;
}

export function ProgressBar({ pct, className, barClassName }: { pct: number; className?: string; barClassName?: string }) {
  return (
    <span className={cn('block h-[3px] overflow-hidden rounded-sm bg-white/[0.06]', className)}>
      <span className={cn('block h-full bg-[linear-gradient(90deg,#9B6BFF,#2CE6D6)] transition-[width] duration-[900ms] ease-in-out', barClassName)} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </span>
  );
}

export function Card({ children, className, strong, ...rest }: HTMLAttributes<HTMLDivElement> & { strong?: boolean }) {
  return (
    <div {...rest} className={cn(strong ? 'gg-card-strong' : 'gg-card', className)}>
      {children}
    </div>
  );
}
