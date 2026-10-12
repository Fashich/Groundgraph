'use client';

import { useMemo } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import type { VersionedTransaction } from '@solana/web3.js';
import { useSession } from '@/lib/queries';
import type { SignerLike } from '@/lib/tx';

/**
 * Whether this browser can sign for the open session. A session can be in `sign` mode while the wallet is not
 * connected yet (after a reload), which is reported as `needsReconnect`.
 */
export function useSigner() {
  const { data: session, isPending } = useSession();
  const { publicKey, connected, signTransaction, sendTransaction } = useWallet();
  return useMemo(() => {
    const addr = publicKey?.toBase58() ?? null;
    const sessionWallet = session?.wallet ?? null;
    const isSign = session?.mode === 'sign';
    const matches = connected && !!addr && addr === sessionWallet;
    const signer: SignerLike | null =
      isSign && matches && (signTransaction || sendTransaction)
        ? {
            signTransaction: signTransaction ? (tx: VersionedTransaction) => signTransaction(tx) : undefined,
            sendTransaction: sendTransaction ? (tx, c) => sendTransaction(tx, c) : undefined,
          }
        : null;
    return {
      session: session ?? null,
      loading: isPending,
      wallet: sessionWallet,
      isView: session?.mode === 'view',
      isSign,
      signer,
      canSign: !!signer,
      needsReconnect: isSign && !matches,
      mismatch: isSign && connected && !!addr && addr !== sessionWallet,
    };
  }, [session, isPending, publicKey, connected, signTransaction, sendTransaction]);
}
