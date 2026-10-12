'use client';

import Link from 'next/link';
import { useState } from 'react';
import { DisputeModal } from '@/components/wallet/DisputeModal';

export function SiteFooter() {
  const [dispute, setDispute] = useState(false);
  const link = 'text-sm text-ink-2 transition-colors hover:text-above';
  return (
    <footer data-component="SiteFooter" className="mt-[72px] flex flex-col gap-7 border-t border-violet/[0.12] pt-8">
      <div className="flex flex-wrap justify-between gap-x-12 gap-y-8">
        <div className="flex max-w-[360px] flex-[1_1_260px] flex-col gap-3.5">
          <div className="flex items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/gg-icon.png" alt="" width={28} height={28} className="h-7 w-7 rounded-lg" />
            <span className="font-display text-[17px] font-semibold leading-none text-body">Groundgraph</span>
          </div>
          <p className="text-sm leading-[1.6] text-dim">Price markets with an explainable smart money radar, built on Solana. Runs on devnet with a test token.</p>
        </div>
        <div className="flex flex-wrap gap-x-16 gap-y-8">
          <div className="flex min-w-[150px] flex-col gap-3">
            <span className="gg-eyebrow">Product</span>
            <button type="button" className={`${link} text-left`} onClick={() => setDispute(true)}>
              Dispute a wallet flag
            </button>
          </div>
          <div className="flex min-w-[150px] flex-col gap-3">
            <span className="gg-eyebrow">Legal</span>
            <Link href="/legal/terms" className={link}>
              Terms of Service
            </Link>
            <Link href="/legal/privacy" className={link}>
              Privacy Policy
            </Link>
            <Link href="/legal/risk" className={link}>
              Risk Disclosure
            </Link>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap justify-between gap-x-6 gap-y-2.5 border-t border-violet/[0.08] pt-5 font-mono text-xs leading-[1.6] text-faint">
        <span>© 2026 Groundgraph · Not financial advice. Price markets carry risk of loss.</span>
        <span>Built on Solana · Prices by Pyth</span>
      </div>
      <DisputeModal open={dispute} onClose={() => setDispute(false)} />
    </footer>
  );
}
