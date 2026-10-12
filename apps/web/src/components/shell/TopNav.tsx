'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button, cn } from '@groundgraph/ui';
import { Logo } from '@/components/common/Logo';
import { useSession } from '@/lib/queries';
import { useUi } from '@/lib/stores';
import { WalletMenu } from './WalletMenu';
import { APP_TABS, isActivePath } from './MobileTabBar';

const NAV = APP_TABS.filter((t) => t.href !== '/');

/** Landing variant: logo and wallet controls only. App variant adds the primary navigation. */
export function TopNav({ variant }: { variant: 'landing' | 'app' }) {
  const path = usePathname();
  const { data: session, isPending } = useSession();
  const openWallet = useUi((s) => s.openWallet);
  const landing = variant === 'landing';
  return (
    <header data-component="TopNav" className="sticky top-0 z-50 flex h-16 items-center gap-2 border-b border-violet/10 bg-bg/75 px-[clamp(16px,4vw,40px)] backdrop-blur-[18px] backdrop-saturate-[1.4] min-[900px]:gap-4">
      <Logo />
      {!landing ? (
        <nav data-component="AppNav" aria-label="Primary" className="ml-2 hidden animate-gg-in gap-0.5 min-[760px]:flex">
          {NAV.map((n) => {
            const on = isActivePath(path, n.href);
            return (
              <Link key={n.href} href={n.href} aria-current={on ? 'page' : undefined} className={cn('whitespace-nowrap rounded-pill px-3.5 py-2 text-sm font-medium leading-none transition-colors hover:text-white', on ? 'bg-violet/15 text-white' : 'text-dim')}>
                {n.label}
              </Link>
            );
          })}
        </nav>
      ) : null}
      <div className="ml-auto flex items-center gap-2.5">
        <div className="hidden items-center gap-2 rounded-pill border border-violet/15 px-3 py-[7px] font-mono text-xs font-medium leading-none text-muted min-[1100px]:flex" data-component="NetPill">
          <span aria-hidden className="gg-dot" />
          Solana Devnet
          <span className="text-faint">· unaudited</span>
        </div>
        {isPending ? (
          <span className="h-[38px] w-[132px] rounded-pill gg-skeleton" aria-hidden />
        ) : !session ? (
          <Button variant="primary" size="sm" className="h-[38px] px-4 text-sm" onClick={() => openWallet()}>
            Connect wallet
          </Button>
        ) : (
          <>
            <WalletMenu onLanding={landing} />
            {landing ? (
              <Link data-component="LaunchAppButton" href="/markets" className="gg-btn gg-btn-primary h-[38px] animate-gg-in px-4 text-sm text-white hover:text-white">
                Launch app →
              </Link>
            ) : null}
          </>
        )}
      </div>
    </header>
  );
}
