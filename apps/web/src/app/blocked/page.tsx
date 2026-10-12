import type { Metadata } from 'next';
import Link from 'next/link';
import { Logo } from '@/components/common/Logo';

export const metadata: Metadata = { title: 'Not available in your region', robots: { index: false } };

export default function Blocked() {
  return (
    <main id="main" className="grid min-h-screen place-items-center px-4 py-16">
      <div className="gg-card-strong flex w-full max-w-[560px] flex-col gap-5 p-8">
        <Logo />
        <h1 className="font-display text-[clamp(26px,4vw,34px)] font-semibold leading-[1.1] tracking-[-0.02em]">Groundgraph is not available where you are</h1>
        <p className="leading-relaxed text-muted">Price markets are restricted in some places, and the location of your connection looks like one of them. We have to keep buying and market creation closed here. This is not a judgement about you.</p>
        <p className="text-sm leading-relaxed text-dim">
          If you already hold shares you can still sell, merge and redeem them: connect your wallet and open <Link href="/positions">Positions</Link>.
        </p>
        <p className="text-sm leading-relaxed text-dim">If you think this is a mistake, for example you are on a VPN or a corporate network, reconnect from your usual network and try again. Nothing was collected from this visit beyond the country your request came from.</p>
        <p className="font-mono text-xs text-faint">HTTP 451 · Unavailable for legal reasons</p>
      </div>
    </main>
  );
}
