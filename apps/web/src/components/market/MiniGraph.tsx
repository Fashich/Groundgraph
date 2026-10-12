'use client';

import Link from 'next/link';
import { DemoDataLabel } from '@groundgraph/ui';
import { WalletGraph } from '@/components/graph/WalletGraph';
import { Skeleton } from '@/components/common/states';
import { useIsMobile } from '@/lib/hooks';
import { useRadar } from '@/lib/queries';

/** Wallet graph for this market. Lit nodes hold a position here. */
export function MiniGraph({ marketId, members, selected, onSelect }: { marketId: string; members: string[] | null; selected: string | null; onSelect: (addr: string | null) => void }) {
  const radar = useRadar();
  const lite = useIsMobile();
  const empty = radar.data && radar.data.nodes.length === 0;
  return (
    <section data-component="MiniGraph" className="overflow-hidden rounded-[22px] border border-violet/[0.14]" style={{ background: 'radial-gradient(80% 80% at 50% 50%,rgba(91,44,143,0.25),rgba(14,11,24,0.7))' }}>
      <div className="flex items-center justify-between gap-2 px-[18px] pt-4">
        <span className="font-display text-[15px] font-semibold leading-none">Wallet graph · this market</span>
        <span className="flex items-center gap-2">
          <DemoDataLabel source={radar.data?.dataSource} />
          <Link href="/radar" className="font-mono text-xs font-medium">
            Radar ↗
          </Link>
        </span>
      </div>
      <div className="relative h-[260px]">
        {radar.isPending ? <Skeleton className="absolute inset-3 rounded-2xl" /> : null}
        {radar.isError ? <div className="grid h-full place-items-center px-6 text-center text-xs text-dim">The wallet graph is unavailable right now.</div> : null}
        {empty ? <div className="grid h-full place-items-center px-6 text-center text-xs text-dim">The graph is building. Wallets appear after the first scored run.</div> : null}
        {radar.data && !empty ? (
          <WalletGraph data={radar.data} mode="mini" lite={lite} market={marketId} members={members} selected={selected} onSelect={onSelect} className="absolute inset-0" label="Wallet graph for this market. Lit nodes hold a position here." />
        ) : null}
      </div>
      <div className="px-[18px] pb-3.5 font-mono text-[11px] leading-[1.4] text-faint">Lit nodes hold a position here. Tap one for its breakdown.</div>
    </section>
  );
}
