'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { env } from '@/lib/env';
import { LegalContext } from '@/components/wallet/legal-context';
import type { LegalDoc, LegalDocKey } from '@/lib/legal';
import { isApiError } from '@/lib/api';
import { LiveProvider } from '@/components/live-provider';
import { GlobalUi } from '@/components/shell/GlobalUi';

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: (count, err) => {
          if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
          return count < 2;
        },
      },
    },
  });
}

// Wallet Standard wallets are auto-detected, so no adapters are listed explicitly.
const NO_ADAPTERS: never[] = [];

export function Providers({ children, legal }: { children: ReactNode; legal: Record<LegalDocKey, LegalDoc> }) {
  const [client] = useState(makeClient);
  return (
    <QueryClientProvider client={client}>
      <ConnectionProvider endpoint={env.rpcUrl}>
        <WalletProvider wallets={NO_ADAPTERS} autoConnect onError={() => undefined}>
          <LegalContext.Provider value={legal}>
            <LiveProvider>
              {children}
              <GlobalUi />
            </LiveProvider>
          </LegalContext.Provider>
        </WalletProvider>
      </ConnectionProvider>
    </QueryClientProvider>
  );
}
