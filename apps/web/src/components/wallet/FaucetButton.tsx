'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Spinner } from '@groundgraph/ui';
import { api, isApiError } from '@/lib/api';
import { useUi } from '@/lib/stores';
import { fromBase, usd } from '@/lib/format';

/** Devnet only: mints test USDC to the connected wallet through POST /faucet/usdc. */
export function FaucetButton({ wallet, variant = 'quiet', size = 'sm', label = 'Get test USDC', className }: { wallet: string; variant?: 'primary' | 'quiet' | 'ghost'; size?: 'sm' | 'md'; label?: string; className?: string }) {
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.faucet(wallet);
      toast({ tone: 'success', title: `Received ${usd(fromBase(r.amount))} test USDC`, body: 'Devnet test tokens have no monetary value.' });
      void qc.invalidateQueries({ queryKey: ['balance'] });
      window.setTimeout(() => void qc.invalidateQueries({ queryKey: ['balance'] }), 2500);
    } catch (e) {
      if (isApiError(e, 'faucet_unavailable') || isApiError(e, 'rate_limited')) toast({ tone: 'error', title: 'Faucet is unavailable right now', body: e.message });
      else toast({ tone: 'error', title: 'Could not get test USDC', body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant={variant} size={size} onClick={() => void run()} disabled={busy} className={className}>
      {busy ? <Spinner size={14} /> : null}
      {label}
    </Button>
  );
}
