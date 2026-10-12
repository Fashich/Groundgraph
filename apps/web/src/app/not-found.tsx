import type { Metadata } from 'next';
import Link from 'next/link';
import { Logo } from '@/components/common/Logo';

export const metadata: Metadata = { title: 'Page not found', robots: { index: false } };

export default function NotFound() {
  return (
    <main id="main" className="grid min-h-screen place-items-center px-4 py-16">
      <div className="gg-card-strong flex w-full max-w-[520px] flex-col gap-5 p-8">
        <Logo />
        <p className="m-0 font-mono text-xs tracking-[0.06em] text-faint">404</p>
        <h1 className="m-0 font-display text-[clamp(26px,4vw,34px)] font-semibold leading-[1.1] tracking-[-0.02em]">This page does not exist</h1>
        <p className="m-0 leading-relaxed text-muted">The link may be old or mistyped. Try the markets list or head back home.</p>
        <div className="flex flex-wrap gap-3">
          <Link href="/markets" className="gg-btn gg-btn-primary h-11 rounded-xl px-5 text-sm text-white hover:text-white">
            Browse markets
          </Link>
          <Link href="/" className="gg-btn gg-btn-ghost h-11 rounded-xl px-5 text-sm">
            Home
          </Link>
        </div>
      </div>
    </main>
  );
}
