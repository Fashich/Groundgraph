import Link from 'next/link';
import { DevnetTag } from '@groundgraph/ui';

/** Brand mark. Uses the plain <img> element on purpose: the logo is a tiny static asset. */
export function Logo({ href = '/', showWord = true, showDevnet = true }: { href?: string; showWord?: boolean; showDevnet?: boolean }) {
  return (
    <Link href={href} aria-label="Groundgraph home" className="flex flex-none items-center gap-2.5 text-body hover:text-body">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/gg-icon.png" alt="" width={30} height={30} className="block h-[30px] w-[30px] rounded-lg" />
      {showWord ? <span className="font-display text-[19px] font-semibold leading-none tracking-[-0.02em] text-body max-[419px]:hidden">Groundgraph</span> : null}
      {showDevnet ? <DevnetTag /> : null}
    </Link>
  );
}
