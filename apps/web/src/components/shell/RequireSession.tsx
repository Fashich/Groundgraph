'use client';

import { useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Spinner } from '@groundgraph/ui';
import { useSession } from '@/lib/queries';
import { useUi } from '@/lib/stores';
import { ErrorState } from '@/components/common/states';
import { useChannel } from '@/components/live-provider';

/**
 * Gate for app routes. No session: go to the landing page with the wallet modal open and `?next=` set.
 * A signing session whose Terms version is out of date reopens the legal modal.
 */
export function RequireSession({ children }: { children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const { data: session, isPending, isError, refetch } = useSession();
  const openLegal = useUi((s) => s.openLegal);
  useChannel(session ? 'me' : null);

  useEffect(() => {
    if (isPending || isError || session) return;
    const next = `${path}${typeof window !== 'undefined' ? window.location.search : ''}`;
    router.replace(`/?connect=1&next=${encodeURIComponent(next)}`);
  }, [isPending, isError, session, path, router]);

  useEffect(() => {
    if (session && session.mode === 'sign' && !session.tosAccepted) openLegal({ reason: 'refresh' });
  }, [session, openLegal]);

  if (isError) {
    return (
      <div className="gg-page">
        <ErrorState title="Cannot reach Groundgraph" message="The API did not respond, so your session could not be checked. Nothing was changed." onRetry={() => void refetch()} />
      </div>
    );
  }
  if (isPending || !session) {
    return (
      <div className="grid min-h-[60vh] place-items-center" role="status" aria-live="polite">
        <div className="flex flex-col items-center gap-3 text-sm text-dim">
          <Spinner size={28} />
          {isPending ? 'Checking your session' : 'Taking you to connect a wallet'}
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
