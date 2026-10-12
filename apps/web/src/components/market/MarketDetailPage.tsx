'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { Side } from '@groundgraph/sdk/api-types';
import { cn } from '@groundgraph/ui';
import { useChannel } from '@/components/live-provider';
import { Modal } from '@/components/common/Modal';
import { EmptyState, ErrorState, Skeleton } from '@/components/common/states';
import { useSigner } from '@/components/wallet/useSigner';
import { useWatch } from '@/components/markets/useWatch';
import { isApiError } from '@/lib/api';
import { cents } from '@/lib/format';
import { useIsMobile, useNow } from '@/lib/hooks';
import { flaggedLean, medianLead, radarFavors, sortWallets, type TradeTab } from '@/lib/market';
import { useMarket, useMarketWallets, usePositions } from '@/lib/queries';
import { DetailTabs, type DetailTab } from './DetailTabs';
import { MarketHeader } from './MarketHeader';
import { MiniGraph } from './MiniGraph';
import { PriceChart, type Tf } from './PriceChart';
import { ShareModal } from './ShareModal';
import { SignalSummary } from './SignalSummary';
import { TradePanel, type TradeDraft } from './TradePanel';
import { WalletDetailDrawer } from './WalletDetailPanel';
import { YourPosition } from './YourPosition';

export function MarketDetailPage({ id }: { id: string }) {
  const sp = useSearchParams();
  const initialSide: Side = sp.get('side') === 'below' ? 'below' : 'above';
  const [tf, setTf] = useState<Tf>('ALL');
  const [tab, setTab] = useState<DetailTab>('smart');
  const [sel, setSel] = useState<string | null>(null);
  const [share, setShare] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [draft, setDraftState] = useState<TradeDraft>({ tab: sp.get('tab') === 'sell' ? 'sell' : 'buy', side: initialSide, amount: '', slip: 100 });
  const setDraft = useCallback((p: Partial<TradeDraft>) => setDraftState((d) => ({ ...d, ...p })), []);
  const mobile = useIsMobile();
  const now = useNow(30_000);
  const watch = useWatch();
  const signer = useSigner();

  const q = useMarket(id, tf);
  const m = q.data;
  useChannel(`market:${id}`);
  useChannel(`radar:${id}`);
  useChannel(m ? `oracle:${m.oracle.feedId}` : null);
  const wallets = useMarketWallets(id, !!m);
  const open = usePositions('open', !!signer.session);
  const redeem = usePositions('redeem', !!signer.session);
  const mine = useMemo(() => {
    const all = [...(open.data ?? []), ...(redeem.data ?? [])].filter((p) => p.marketId === id);
    const seen = new Set<string>();
    return all.filter((p) => (seen.has(`${p.side}-${p.status}`) ? false : (seen.add(`${p.side}-${p.status}`), true)));
  }, [open.data, redeem.data, id]);
  const openMine = useMemo(() => mine.filter((p) => p.status === 'open'), [mine]);

  const rows = wallets.data;
  const lean = useMemo(() => flaggedLean(rows), [rows]);
  const lead = useMemo(() => medianLead(rows), [rows]);
  const sorted = useMemo(() => (rows ? sortWallets(rows) : []), [rows]);
  const members = useMemo(() => (rows ? rows.map((r) => r.address) : null), [rows]);

  const pickWallet = useCallback((addr: string | null) => setSel(addr), []);
  const startTrade = (side: Side, tabId: TradeTab, amount = '') => {
    setDraft({ side, tab: tabId, amount });
    if (mobile) setSheet(true);
  };

  if (q.isPending && !m) return <DetailSkeleton />;
  if (q.isError && isApiError(q.error) && q.error.status === 404) {
    return (
      <div className="gg-page">
        <EmptyState title="Market not found" action={<Link href="/markets" className="gg-btn gg-btn-primary h-11 rounded-xl px-5 text-sm text-white hover:text-white">Back to markets</Link>}>
          This market does not exist or is not available in your region.
        </EmptyState>
      </div>
    );
  }
  if (q.isError && !m) {
    return (
      <div className="gg-page">
        <ErrorState title="Could not load this market" message={(q.error as Error).message} onRetry={() => void q.refetch()} />
      </div>
    );
  }
  if (!m) return <DetailSkeleton />;

  const insight = lead != null ? `Flagged wallets in this market have a median lead time of ${lead} min.` : m.flaggedEntries.length === 0 ? 'No flagged entries yet.' : `${m.flaggedEntries.length} flagged entries in this window.`;
  const selRow = sel ? sorted.find((r) => r.address === sel) : undefined;
  const favors = radarFavors(m.radar.state === 'ready' ? m.radar.edge : null);
  const isOpen = m.status === 'open';

  const panel = <TradePanel m={m} draft={draft} setDraft={setDraft} positions={openMine} onCloseSheet={mobile ? () => setSheet(false) : undefined} />;

  return (
    <div data-component="MarketDetailPage" data-market-id={m.id} className="mx-auto max-w-[1320px] animate-gg-in px-[clamp(16px,4vw,40px)] py-[clamp(20px,3vw,40px)] pb-[calc(clamp(20px,3vw,40px)+76px)] min-[760px]:pb-[clamp(20px,3vw,40px)]">
      <MarketHeader m={m} watched={watch.has(m.id)} onWatch={() => void watch.toggle(m.id)} onShare={() => setShare(true)} now={now} />
      <SignalSummary m={m} lean={lean} spark={m.spark} />

      <div className="mt-5 flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[999_1_480px] flex-col gap-5">
          <PriceChart m={m} tf={tf} onTf={setTf} insight={insight} onPickWallet={(a) => pickWallet(a)} loading={q.isFetching && q.isPlaceholderData} />
          <DetailTabs m={m} tab={tab} onTab={setTab} walletRows={rows} walletsLoading={wallets.isPending} walletsError={wallets.isError} lean={lean} selected={sel} onSelect={(a) => pickWallet(a)} />
        </div>
        <aside className="flex min-w-0 flex-[1_1_300px] flex-col gap-5 min-[900px]:sticky min-[900px]:top-[84px]">
          {mobile ? null : panel}
          <YourPosition m={m} positions={mine} onSell={(side, shares) => startTrade(side, 'sell', String(Math.floor(shares * 100) / 100))} onAddMore={(side) => startTrade(side, 'buy')} />
          <MiniGraph marketId={m.id} members={members} selected={sel} onSelect={pickWallet} />
        </aside>
      </div>

      {mobile && sheet ? (
        <Modal open onClose={() => setSheet(false)} label="Trade" z={84} variant="sheet" scrim="bg-[rgba(4,3,8,0.6)]" panelClassName="bg-transparent border-0 shadow-none">
          {panel}
        </Modal>
      ) : null}

      {mobile && isOpen && !sheet ? (
        <div data-component="MobileTradeBar" className="fixed inset-x-0 bottom-[calc(64px+env(safe-area-inset-bottom))] z-[61] grid grid-cols-2 gap-2 border-t border-violet/[0.14] bg-[rgba(10,8,18,0.92)] px-3 py-2.5 backdrop-blur-[18px]">
          <button type="button" onClick={() => startTrade('above', 'buy')} className={cn('gg-btn gg-btn-above h-12 rounded-xl text-sm')}>
            Buy ABOVE {cents(m.priceAbove)}
          </button>
          <button type="button" onClick={() => startTrade('below', 'buy')} className={cn('gg-btn gg-btn-below h-12 rounded-xl text-sm')}>
            Buy BELOW {cents(1 - m.priceAbove)}
          </button>
        </div>
      ) : null}

      <WalletDetailDrawer addr={sel} onClose={() => setSel(null)} market={{ marketId: m.id, priceAbove: m.priceAbove, radarSide: favors, row: selRow, rank: selRow ? sorted.indexOf(selRow) + 1 : null }} />
      {share ? <ShareModal m={m} onClose={() => setShare(false)} /> : null}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="mx-auto max-w-[1320px] px-[clamp(16px,4vw,40px)] py-10" aria-busy="true" aria-label="Loading market">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="mt-5 h-12 w-3/4" />
      <Skeleton className="mt-6 h-[130px] rounded-[20px]" />
      <div className="mt-5 flex flex-wrap gap-5">
        <Skeleton className="h-[480px] min-w-0 flex-[999_1_480px] rounded-[22px]" />
        <Skeleton className="h-[520px] flex-[1_1_300px] rounded-3xl" />
      </div>
    </div>
  );
}
