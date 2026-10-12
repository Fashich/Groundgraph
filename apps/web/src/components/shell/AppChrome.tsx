'use client';

import type { ReactNode } from 'react';
import { TopNav } from './TopNav';
import { NetworkBanner } from './NetworkBanner';
import { DemoRibbon } from './DemoRibbon';
import { MobileTabBar } from './MobileTabBar';
import { ScrollRail } from './ScrollRail';
import { RequireSession } from './RequireSession';

export function AppChrome({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen pb-[calc(76px+env(safe-area-inset-bottom))] min-[760px]:pb-0">
      <TopNav variant="app" />
      <DemoRibbon />
      <NetworkBanner />
      <RequireSession>
        <main id="main" tabIndex={-1} className="outline-none">
          {children}
        </main>
      </RequireSession>
      <MobileTabBar />
      <ScrollRail />
    </div>
  );
}
