'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@groundgraph/ui';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name. */
  label: string;
  children: ReactNode;
  /** When false Esc and the backdrop do nothing (mandatory dialogs). */
  closable?: boolean;
  z?: number;
  /** 'sheet' becomes a bottom sheet under 760px. 'center' stays centered. */
  variant?: 'sheet' | 'center';
  panelClassName?: string;
  className?: string;
  'data-component'?: string;
  /** Background scrim class. */
  scrim?: string;
  /** Initial focus target selector inside the panel. */
  initialFocus?: string;
}

let lockCount = 0;

/** Accessible dialog: focus trap, Esc, scroll lock, focus return. */
export function Modal({ open, onClose, label, children, closable = true, z = 80, variant = 'sheet', panelClassName, className, scrim = 'bg-[rgba(4,3,8,0.7)]', initialFocus, ...rest }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  const prev = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    prev.current = document.activeElement as HTMLElement | null;
    lockCount++;
    document.body.style.overflow = 'hidden';
    const t = setTimeout(() => {
      const root = panel.current;
      if (!root) return;
      const target = (initialFocus && root.querySelector<HTMLElement>(initialFocus)) || root.querySelector<HTMLElement>(FOCUSABLE) || root;
      target.focus({ preventScroll: true });
    }, 30);
    return () => {
      clearTimeout(t);
      lockCount = Math.max(0, lockCount - 1);
      if (lockCount === 0) document.body.style.overflow = '';
      prev.current?.focus?.({ preventScroll: true });
    };
  }, [open, initialFocus]);

  if (!open) return null;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && closable) {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const root = panel.current;
    if (!root) return;
    const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === root)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const sheet = variant === 'sheet';
  return (
    <div
      data-component={rest['data-component']}
      onKeyDown={onKey}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && closable) onClose();
      }}
      className={cn('fixed inset-0 flex justify-center backdrop-blur-[8px]', scrim, sheet ? 'items-end p-0 min-[760px]:items-center min-[760px]:p-4' : 'items-center p-3', className)}
      style={{ zIndex: z }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={cn('gg-overlay animate-gg-sheet outline-none', sheet ? 'max-h-[92vh] w-full overflow-y-auto rounded-t-[24px] min-[760px]:max-h-[calc(100vh-32px)] min-[760px]:rounded-[24px]' : 'rounded-[24px]', panelClassName)}
      >
        {children}
      </div>
    </div>
  );
}

export function ModalHeader({ title, sub, onClose, closeLabel = 'Close' }: { title: ReactNode; sub?: ReactNode; onClose?: () => void; closeLabel?: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="font-display text-[22px] font-semibold leading-[1.1]">{title}</span>
        {sub ? <span className="text-[13px] leading-[1.45] text-dim">{sub}</span> : null}
      </div>
      {onClose ? (
        <button type="button" onClick={onClose} aria-label={closeLabel} className="gg-btn-icon flex-none">
          ×
        </button>
      ) : null}
    </div>
  );
}
