'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { cn, scoreColor } from '@groundgraph/ui';
import { useMe, useSession } from '@/lib/queries';
import { useCopy, useUsdcBalance } from '@/lib/hooks';
import { fromBase, shortAddr, usd } from '@/lib/format';
import { useUi } from '@/lib/stores';
import { useWalletFlow } from '@/components/wallet/flow';
import { FaucetButton } from '@/components/wallet/FaucetButton';
import { env } from '@/lib/env';

/** Avatar blob used for wallets. Deterministic color rotation from the address so wallets are distinguishable. */
export function WalletAvatar({ size = 20, addr }: { size?: number; addr?: string }) {
  const rot = addr ? [...addr].reduce((a, c) => (a + c.charCodeAt(0)) % 360, 0) : 0;
  return <span aria-hidden className="flex-none rounded-full shadow-[0_0_10px_rgba(44,230,214,0.4)]" style={{ width: size, height: size, background: 'linear-gradient(135deg,#2CE6D6,#9B6BFF,#E046F0)', filter: `hue-rotate(${rot % 40}deg)` }} />;
}

export function WalletMenu({ onLanding }: { onLanding?: boolean }) {
  const { data: session } = useSession();
  const isView = session?.mode === 'view';
  const me = useMe(!!session);
  const bal = useUsdcBalance(session?.wallet, session?.mode === 'sign');
  const { disconnectAll, switchWallet } = useWalletFlow();
  const openWallet = useUi((s) => s.openWallet);
  const router = useRouter();
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [copied, copy] = useCopy();
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!session) return null;
  const score = me.data?.walletScore;
  const items: { label: string; hint?: string; run: () => void; tone?: string }[] = [
    onLanding ? { label: 'Launch app', hint: '→', run: () => router.push('/markets') } : { label: 'My positions', hint: 'P', run: () => router.push('/positions') },
    { label: 'Trading limits', hint: '', run: () => router.push('/positions#limits') },
    isView ? { label: 'Connect a signing wallet', hint: '', run: () => openWallet(path.startsWith('/') && path !== '/' ? path : null) } : { label: 'Switch wallet', hint: '', run: () => void switchWallet() },
    { label: 'Disconnect', hint: '', run: () => void disconnectAll(), tone: 'text-below-text' },
  ];

  return (
    <div data-component="WalletMenu" ref={root} className="relative">
      <button
        type="button"
        aria-label="Wallet menu"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen(!open)}
        className={cn('flex h-[38px] items-center gap-2 rounded-pill border bg-panel-2/60 px-3 font-mono text-[13px] font-medium text-body transition-colors hover:border-above/60', open ? 'border-above/60' : 'border-violet/25')}
      >
        <WalletAvatar addr={session.wallet} />
        <span className="max-[759px]:hidden">{shortAddr(session.wallet)}</span>
        {isView ? <span className="rounded-[5px] bg-violet/[0.18] px-1.5 py-[3px] font-mono text-[9px] font-semibold leading-none tracking-[0.06em] text-violet-pale max-[759px]:hidden">VIEW</span> : null}
        <span aria-hidden className={cn('text-[10px] text-faint transition-transform max-[759px]:hidden', open && 'rotate-180')}>
          ▾
        </span>
      </button>
      {open ? (
        <div data-component="WalletMenuPanel" role="menu" className="absolute right-0 top-[calc(100%+10px)] z-[1] flex w-[min(290px,calc(100vw-32px))] animate-gg-sheet flex-col gap-3 rounded-2xl border border-violet/25 bg-[rgba(14,11,24,0.97)] p-3.5 shadow-[0_24px_60px_rgba(0,0,0,0.55)] backdrop-blur-lg">
          <div className="flex items-center gap-3">
            <WalletAvatar size={40} addr={session.wallet} />
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-medium text-ink" title={session.wallet}>
                  {shortAddr(session.wallet)}
                </span>
                <button type="button" onClick={() => copy(session.wallet)} aria-label="Copy wallet address" className="rounded-md border border-violet/25 px-2 py-1 font-mono text-[10px] leading-none text-violet-pale hover:border-above/50">
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <span className="text-xs text-dim">{isView ? 'View-only session' : `${session.walletName ?? 'Wallet'} · signing`}</span>
            </div>
          </div>
          <div className="flex items-center justify-between rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2.5 text-xs text-muted">
            Your radar score
            {score ? (
              <b className="font-display text-lg font-semibold leading-none" style={{ color: scoreColor({ smart: score.smart, top: score.score >= 85 }) }}>
                {score.score}
              </b>
            ) : (
              <span className="font-mono text-[11px] text-faint">{me.isPending ? '...' : 'Not scored yet'}</span>
            )}
          </div>
          {!isView ? (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2.5 text-xs text-muted">
              <span>Test USDC</span>
              <span className="font-mono text-[13px] text-ink">{bal.data != null ? usd(fromBase(bal.data)) : env.usdcMint ? '...' : 'n/a'}</span>
            </div>
          ) : null}
          <div className="flex flex-col gap-0.5">
            {items.map((i) => (
              <button
                key={i.label}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  i.run();
                }}
                className={cn('flex h-[42px] items-center justify-between gap-2.5 rounded-[10px] px-2.5 text-left text-[13px] font-medium transition-colors hover:bg-violet/[0.12]', i.tone ?? 'text-body')}
              >
                {i.label}
                <span className="font-mono text-[11px] text-faint">{i.hint}</span>
              </button>
            ))}
          </div>
          {!isView && env.cluster !== 'mainnet-beta' ? <FaucetButton wallet={session.wallet} /> : null}
          {isView ? (
            <p className="text-xs leading-[1.45] text-dim">
              Viewing {shortAddr(session.wallet)}. Trading and publishing need a signing wallet.{' '}
              <Link href="/legal/terms" className="text-violet-light">
                Terms
              </Link>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
