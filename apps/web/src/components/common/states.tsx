'use client';

import type { ReactNode } from 'react';
import { Button, cn } from '@groundgraph/ui';

/** Dashed empty or building state. Honest: says why there is no data. */
export function EmptyState({ title, children, action, className }: { title?: ReactNode; children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div data-component="EmptyState" className={cn('flex flex-col items-center gap-3 rounded-[20px] border border-dashed border-violet/20 px-6 py-12 text-center text-dim', className)}>
      {title ? <span className="font-display text-lg font-semibold text-ink-2">{title}</span> : null}
      <div className="max-w-[460px] text-sm leading-relaxed">{children}</div>
      {action}
    </div>
  );
}

export function ErrorState({ title = 'Could not load this', message, onRetry, className }: { title?: string; message?: string; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" data-component="ErrorState" className={cn('flex flex-col items-center gap-3 rounded-[20px] border border-below/25 bg-below/[0.05] px-6 py-10 text-center', className)}>
      <span className="font-display text-lg font-semibold text-ink-2">{title}</span>
      {message ? <span className="max-w-[460px] text-sm text-dim">{message}</span> : null}
      {onRetry ? (
        <Button variant="quiet" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div aria-hidden className={cn('gg-skeleton', className)} style={style} />;
}
