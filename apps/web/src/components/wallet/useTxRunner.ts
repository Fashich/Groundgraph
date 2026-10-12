'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { UnsignedTx } from '@groundgraph/sdk/api-types';
import { getConnection } from '@/lib/solana';
import { TxFailure, failureCopy, nextPriorityFee, runTx, toFailure, type ActionId, type FailureCopy, type TxProgress } from '@/lib/tx';
import { useUi } from '@/lib/stores';
import { useSigner } from './useSigner';
import { useWalletFlow } from './flow';

export type TxPhase =
  | { kind: 'idle' }
  | { kind: 'busy'; p: TxProgress }
  | { kind: 'error'; failure: TxFailure }
  | { kind: 'done'; signature: string; tx: UnsignedTx };

/**
 * Shared transaction state machine: build (server) -> sign (wallet) -> send -> confirm.
 * Failures keep their kind so the UI can offer the right recovery (retry with higher priority fee, wider slippage, ...).
 */
export function useTxRunner() {
  const signer = useSigner();
  const flow = useWalletFlow();
  const router = useRouter();
  const openWallet = useUi((s) => s.openWallet);
  const openLegal = useUi((s) => s.openLegal);
  const [phase, setPhase] = useState<TxPhase>({ kind: 'idle' });
  const priority = useRef<number | undefined>(undefined);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(
    async (build: (priorityFeeMicroLamports: number | undefined) => Promise<UnsignedTx>): Promise<{ signature: string; tx: UnsignedTx } | null> => {
      const set = (p: TxPhase) => {
        if (alive.current) setPhase(p);
      };
      set({ kind: 'busy', p: { step: 'build', label: 'Preparing transaction', sub: 'Building an unsigned transaction on the server', pct: 8 } });
      try {
        const res = await runTx({
          build: () => build(priority.current),
          signer: signer.signer,
          connection: getConnection(),
          onProgress: (p) => set({ kind: 'busy', p }),
        });
        set({ kind: 'done', signature: res.signature, tx: res.tx });
        return res;
      } catch (e) {
        set({ kind: 'error', failure: toFailure(e) });
        return null;
      }
    },
    [signer.signer],
  );

  const reset = useCallback(() => setPhase({ kind: 'idle' }), []);
  const bumpPriority = useCallback(() => {
    priority.current = nextPriorityFee(priority.current);
    return priority.current;
  }, []);

  /** Handle the generic recovery actions. Returns true when handled here. */
  const handleGeneric = useCallback(
    (id: ActionId): boolean => {
      switch (id) {
        case 'dismiss':
          reset();
          return true;
        case 'connect':
          reset();
          if (signer.needsReconnect && signer.session) void flow.reconnectSigner();
          else openWallet(typeof window !== 'undefined' ? window.location.pathname + window.location.search : null);
          return true;
        case 'accept_tos':
          reset();
          openLegal({ reason: 'refresh' });
          return true;
        case 'open_limits':
          reset();
          router.push('/positions#limits');
          return true;
        default:
          return false;
      }
    },
    [flow, openLegal, openWallet, reset, router, signer.needsReconnect, signer.session],
  );

  return { phase, run, reset, bumpPriority, handleGeneric, signer };
}

export type { FailureCopy };
export { failureCopy };
