'use client';

import { Suspense, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { TopNav } from '@/components/shell/TopNav';
import { NetworkBanner } from '@/components/shell/NetworkBanner';
import { ScrollRail } from '@/components/shell/ScrollRail';
import { SiteFooter } from '@/components/shell/SiteFooter';
import { useUi } from '@/lib/stores';
import { useSession } from '@/lib/queries';
import { Hero } from './Hero';
import { Explainable, FinalCta, HedgeUseCase, HowItWorks, TwoEngines } from './Sections';

/** Opens the wallet modal when an app route sent the visitor here with ?connect=1&next=. */
function ConnectGate() {
  const sp = useSearchParams();
  const { data: session, isPending } = useSession();
  const openWallet = useUi((s) => s.openWallet);
  const connect = sp.get('connect');
  const next = sp.get('next');
  useEffect(() => {
    if (isPending) return;
    if (connect && !session) openWallet(next && next.startsWith('/') && !next.startsWith('//') ? next : null);
    if (connect) window.history.replaceState(null, '', '/');
  }, [connect, next, session, isPending, openWallet]);
  return null;
}

export function LandingPage() {
  return (
    <div>
      <TopNav variant="landing" />
      <NetworkBanner />
      <Suspense fallback={null}>
        <ConnectGate />
      </Suspense>
      <main id="main" tabIndex={-1} data-screen="landing" className="animate-gg-in outline-none">
        <Hero />
        <HowItWorks />
        <TwoEngines />
        <HedgeUseCase />
        <Explainable />
        <section className="mx-auto max-w-[1240px] px-[clamp(16px,4vw,40px)] pb-[clamp(56px,8vw,120px)] pt-[clamp(56px,8vw,120px)]">
          <FinalCta />
          <SiteFooter />
        </section>
      </main>
      <ScrollRail />
    </div>
  );
}
