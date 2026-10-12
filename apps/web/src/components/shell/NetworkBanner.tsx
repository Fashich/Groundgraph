'use client';

import { useEffect, useState } from 'react';
import { useNet, networkProblem } from '@/lib/stores';
import { useLiveControls } from '@/components/live-provider';

/** Shown when live updates lag by more than 5s, the socket is down, or an RPC call is slow. */
export function NetworkBanner() {
  const ws = useNet((s) => s.ws);
  const lagMs = useNet((s) => s.lagMs);
  const downSince = useNet((s) => s.downSince);
  const rpcSlow = useNet((s) => s.rpcSlow);
  const setRpcSlow = useNet((s) => s.setRpcSlow);
  const { reconnect } = useLiveControls();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const p = networkProblem({ ws, lagMs, downSince }, now);
  if (!p && !rpcSlow) return null;
  const text = rpcSlow && !p ? 'Solana RPC is responding slowly. Fills and balances may lag by a few seconds.' : p?.kind === 'lag' ? `Live updates are ${p.seconds}s behind. Prices shown may be slightly out of date.` : 'Live connection lost. Reconnecting automatically; prices shown may be out of date.';
  return (
    <div data-component="NetworkBanner" role="status" className="sticky top-16 z-[45] flex flex-wrap items-center justify-center gap-x-3.5 gap-y-2 border-b border-violet/30 bg-brand/40 px-4 py-2.5 text-center text-[13px] text-body backdrop-blur-xl">
      <span aria-hidden className="h-2 w-2 flex-none animate-gg-pulse-fast rounded-full bg-below" />
      {text}
      {p ? (
        <button type="button" onClick={reconnect} className="h-[30px] rounded-pill border border-white/30 bg-transparent px-3 text-xs font-semibold text-white">
          Reconnect now
        </button>
      ) : (
        <button type="button" onClick={() => setRpcSlow(false)} className="h-[30px] rounded-pill border border-white/30 bg-transparent px-3 text-xs font-semibold text-white">
          Dismiss
        </button>
      )}
    </div>
  );
}
