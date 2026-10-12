'use client';

import { Toaster } from './Toaster';
import { WalletConnectModal } from '@/components/wallet/WalletConnectModal';
import { LegalModal } from '@/components/wallet/LegalModal';

/** Overlays that can open from anywhere: wallet connect, legal gate, toasts. */
export function GlobalUi() {
  return (
    <>
      <WalletConnectModal />
      <LegalModal />
      <Toaster />
    </>
  );
}
