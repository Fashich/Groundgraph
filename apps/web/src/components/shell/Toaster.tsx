'use client';

import { useUi } from '@/lib/stores';
import { cn } from '@groundgraph/ui';

/** aria-live toast region. Fills, errors and connection events are announced here. */
export function Toaster() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  return (
    <div aria-live="polite" aria-relevant="additions" data-component="Toaster" className="pointer-events-none fixed inset-x-0 bottom-[calc(76px+env(safe-area-inset-bottom))] z-[120] flex flex-col items-center gap-2 px-4 min-[760px]:bottom-6">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.tone === 'error' ? 'alert' : 'status'}
          className={cn(
            'pointer-events-auto flex w-full max-w-[420px] animate-gg-sheet items-start gap-3 rounded-[14px] border bg-panel-2/95 px-4 py-3 shadow-[0_20px_50px_rgba(0,0,0,0.5)] backdrop-blur-lg',
            t.tone === 'success' ? 'border-above/35' : t.tone === 'error' ? 'border-below/40' : 'border-violet/30',
          )}
        >
          <span aria-hidden className={cn('mt-1.5 h-2 w-2 flex-none rounded-full', t.tone === 'success' ? 'bg-above' : t.tone === 'error' ? 'bg-below' : 'bg-violet')} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-sm font-semibold leading-tight text-ink">{t.title}</span>
            {t.body ? <span className="text-[13px] leading-[1.4] text-muted">{t.body}</span> : null}
          </div>
          <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss notification" className="-m-2 grid h-10 w-10 flex-none place-items-center text-dim hover:text-ink">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
