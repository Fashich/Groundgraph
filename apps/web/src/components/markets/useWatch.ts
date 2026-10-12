'use client';

import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useSession, useWatched } from '@/lib/queries';
import { useUi } from '@/lib/stores';

/** Watchlist state and toggle. Toggling needs a session; view-only sessions can watch too. */
export function useWatch() {
  const { data: session } = useSession();
  const watched = useWatched(!!session);
  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);
  const set = watched.data ?? new Set<string>();
  return {
    has: (id: string) => set.has(id),
    toggle: async (id: string) => {
      const prev = new Set(set);
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      qc.setQueryData(['watched'], next);
      try {
        const r = await api.watch(id);
        const fixed = new Set(next);
        if (r.watching) fixed.add(id);
        else fixed.delete(id);
        qc.setQueryData(['watched'], fixed);
        void qc.invalidateQueries({ queryKey: ['markets'] });
      } catch (e) {
        qc.setQueryData(['watched'], prev);
        toast({ tone: 'error', title: 'Could not update your watchlist', body: (e as Error).message });
      }
    },
  };
}
