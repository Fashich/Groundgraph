'use client';

import { useEffect, useState } from 'react';
import type { MarketDetail, MarketWalletRow, TradeRow } from '@groundgraph/sdk/api-types';
import { FEATURE_ABBR, FEATURE_COLORS, FEATURE_LABELS, cn, scoreColor } from '@groundgraph/ui';
import { EmptyState, ErrorState, Skeleton } from '@/components/common/states';
import { ago, cents, fmtDT, fromBase, shortAddr, usd, usdFromU64 } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { bpsPct, feeSegments, leadFill, sortWallets, type Lean } from '@/lib/market';
import { explorerAddr } from '@/lib/solana';
import { useTrades } from '@/lib/queries';

export type DetailTab = 'smart' | 'trades' | 'rules' | 'pool';

const eyebrow = 'font-mono text-[10px] font-medium leading-[1.2] tracking-[0.06em] uppercase text-faint';

export function DetailTabs({
  m,
  tab,
  onTab,
  walletRows,
  walletsLoading,
  walletsError,
  lean,
  selected,
  onSelect,
}: {
  m: MarketDetail;
  tab: DetailTab;
  onTab: (t: DetailTab) => void;
  walletRows: MarketWalletRow[] | undefined;
  walletsLoading: boolean;
  walletsError: boolean;
  lean: Lean | null;
  selected: string | null;
  onSelect: (addr: string) => void;
}) {
  const trades = useTrades(m.id, tab === 'trades');
  const tradeCount = trades.data?.pages.flatMap((p) => p.items).length;
  const smartCount = walletRows?.filter((r) => r.smart).length;
  const tabs: { id: DetailTab; label: string; count?: number | null }[] = [
    { id: 'smart', label: 'Smart money', count: smartCount ?? null },
    { id: 'trades', label: 'Live trades', count: tradeCount ?? null },
    { id: 'rules', label: 'Rules' },
    { id: 'pool', label: 'Pool' },
  ];
  return (
    <section
      data-component="DetailTabs"
      className="flex flex-col gap-5 rounded-[22px] border border-above/[0.16] p-[clamp(16px,2.4vw,28px)]"
      style={{ background: 'var(--gg-surface)' }}
    >
      <div role="tablist" aria-label="Market details" className="gg-no-scrollbar flex gap-[22px] overflow-x-auto overflow-y-hidden border-b border-violet/[0.14]">
        {tabs.map((t) => {
          const on = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`dt-${t.id}`}
              aria-selected={on}
              aria-controls={`dp-${t.id}`}
              onClick={() => onTab(t.id)}
              className={cn(
                '-mb-px flex h-11 flex-none items-center gap-2 border-0 border-b-2 bg-transparent p-0 font-sans text-sm font-semibold transition-colors',
                on ? 'border-violet text-ink' : 'border-transparent text-dim hover:text-body',
              )}
            >
              {t.label}
              {t.count != null ? <span className="rounded-pill bg-violet/[0.14] px-[7px] py-[3px] font-mono text-[10px] font-medium leading-none text-violet-pale">{t.count}</span> : null}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={`dp-${tab}`} aria-labelledby={`dt-${tab}`}>
        {tab === 'smart' ? <WalletScoringPanel m={m} rows={walletRows} loading={walletsLoading} error={walletsError} lean={lean} selected={selected} onSelect={onSelect} /> : null}
        {tab === 'trades' ? <TradeFeed query={trades} onSelect={onSelect} /> : null}
        {tab === 'rules' ? <ResolutionRules m={m} /> : null}
        {tab === 'pool' ? <PoolStats m={m} /> : null}
      </div>
    </section>
  );
}

/* ------------------------------ smart money ------------------------------ */

export function WalletScoringPanel({
  m,
  rows,
  loading,
  error,
  lean,
  selected,
  onSelect,
}: {
  m: MarketDetail;
  rows: MarketWalletRow[] | undefined;
  loading: boolean;
  error: boolean;
  lean: Lean | null;
  selected: string | null;
  onSelect: (addr: string) => void;
}) {
  const sorted = rows ? sortWallets(rows) : [];
  const r = m.radar;
  const ready = r.state === 'ready' && r.p != null;
  return (
    <div data-component="WalletScoringPanel" className="flex animate-gg-in flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <span className="max-w-[380px] text-[13px] text-dim">Wallets positioned in this market, ranked by smart money score. Select one to see why it was flagged.</span>
        <div className="flex gap-6">
          <Agg v={ready ? `${Math.round((r.p as number) * 100)}%` : 'Building'} l="Radar P(above)" color="#2CE6D6" />
          <Agg v={lean ? `${Math.max(lean.abovePct, lean.belowPct)}% ${lean.abovePct >= lean.belowPct ? 'ABOVE' : 'BELOW'}` : 'None yet'} l="Flagged vol. lean" color={lean && lean.abovePct < lean.belowPct ? '#E046F0' : '#2CE6D6'} />
          <Agg v={String(rows ? rows.filter((x) => x.smart).length : r.n)} l="Flagged" color="#EDEBF5" />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {loading ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[74px] rounded-[14px]" />) : null}
        {error ? <ErrorState title="Could not load wallets" message="The wallet list for this market is unavailable right now." /> : null}
        {!loading && !error && sorted.length === 0 ? (
          <EmptyState title="No scored trades yet">The radar ranks wallets after the first 10 scored trades in a market.</EmptyState>
        ) : null}
        {sorted.map((w, i) => (
          <WalletRow key={w.address} w={w} rank={i + 1} on={selected === w.address} onPick={() => onSelect(w.address)} />
        ))}
      </div>
    </div>
  );
}

function Agg({ v, l, color }: { v: string; l: string; color: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-display text-[22px] font-semibold leading-none" style={{ color }}>
        {v}
      </span>
      <span className={eyebrow}>{l}</span>
    </div>
  );
}

function WalletRow({ w, rank, on, onPick }: { w: MarketWalletRow; rank: number; on: boolean; onPick: () => void }) {
  const feats = [
    { k: 'whaleOverlap' as const, v: w.features.whaleOverlap, t: `${Math.round(w.features.whaleOverlap * 100)}%` },
    { k: 'entryTiming' as const, v: w.features.entryTiming, t: `${Math.round(w.features.entryTiming * 100)}%` },
    { k: 'hitRate' as const, v: w.features.hitRate, t: `${Math.round(w.features.hitRate * 100)}%` },
    { k: 'centrality' as const, v: w.features.centrality, t: `${Math.round(w.features.centrality * 100)}%` },
    { k: 'leadTime' as const, v: leadFill(w.features.leadTimeMin), t: `${w.features.leadTimeMin} min median lead` },
  ];
  const sideC = w.side === 'above' ? 'text-above bg-above/[0.1]' : 'text-below bg-below/[0.1]';
  return (
    <button
      type="button"
      data-component="WalletRow"
      aria-pressed={on}
      onClick={onPick}
      className={cn('block w-full cursor-pointer rounded-[14px] border text-left transition-colors hover:border-violet/35', on ? 'border-above/40 bg-above/[0.06]' : 'border-white/[0.06] bg-white/[0.025]')}
    >
      <div className="grid grid-cols-[28px_minmax(0,1fr)_auto_auto] items-center gap-3 px-3.5 py-3">
        <span className="font-mono text-xs font-medium leading-none text-faint">{String(rank).padStart(2, '0')}</span>
        <div className="flex min-w-0 flex-col gap-[3px]">
          <span className="font-mono text-[13px] font-medium leading-none text-body">{shortAddr(w.address)}</span>
          <span className="overflow-hidden text-ellipsis whitespace-nowrap text-xs text-dim">
            {w.sybil ? 'Sybil-suspect · ' : ''}
            {usdFromU64(w.usdc)} · in at {cents(w.entryPrice)}
          </span>
        </div>
        <span className={cn('rounded-md px-2 py-1 font-mono text-[11px] font-semibold leading-none', sideC)}>{w.side.toUpperCase()}</span>
        <span className="min-w-8 text-right font-display text-xl font-semibold leading-none" style={{ color: scoreColor(w) }}>
          {w.score}
        </span>
      </div>
      <div className="grid grid-cols-5 gap-1.5 pb-3 pl-[54px] pr-3.5">
        {feats.map((f) => (
          <div key={f.k} className="flex flex-col gap-1" title={`${FEATURE_LABELS[f.k]}: ${f.t}`}>
            <span className="h-1 overflow-hidden rounded-sm bg-white/[0.06]">
              <span className="block h-full" style={{ width: `${Math.round(f.v * 100)}%`, background: FEATURE_COLORS[f.k] }} />
            </span>
            <span className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[10px] leading-[1.1] text-faint">{FEATURE_ABBR[f.k]}</span>
          </div>
        ))}
      </div>
    </button>
  );
}

/* ------------------------------ live trades ------------------------------ */

type TradesQuery = ReturnType<typeof useTrades>;

export function TradeFeed({ query, onSelect }: { query: TradesQuery; onSelect: (addr: string) => void }) {
  const now = useNow(15_000);
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div data-component="TradeFeed" className="flex animate-gg-in flex-col">
      <div className="grid grid-cols-[64px_minmax(0,1fr)_92px_72px] gap-2.5 px-3 pb-2.5 font-mono text-[10px] font-medium uppercase leading-none tracking-[0.06em] text-faint min-[760px]:grid-cols-[84px_minmax(0,1fr)_110px_90px_70px]">
        <span>Time</span>
        <span>Wallet</span>
        <span>Side</span>
        <span className="text-right">Size</span>
        <span className="hidden text-right min-[760px]:block">Price</span>
      </div>
      {query.isPending ? Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="mb-1.5 h-10 rounded-[10px]" />) : null}
      {query.isError ? <ErrorState title="Could not load trades" onRetry={() => void query.refetch()} /> : null}
      {!query.isPending && !query.isError && items.length === 0 ? <EmptyState title="No trades yet">The first trade in this market will appear here.</EmptyState> : null}
      {items.map((t) => (
        <TradeItem key={t.id} t={t} now={now} onSelect={onSelect} />
      ))}
      {query.hasNextPage ? (
        <button type="button" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage} className="gg-btn gg-btn-quiet mx-auto mt-3 h-10 rounded-[10px] px-4 text-[13px]">
          {query.isFetchingNextPage ? 'Loading' : 'Load more'}
        </button>
      ) : null}
    </div>
  );
}

function TradeItem({ t, now, onSelect }: { t: TradeRow; now: number; onSelect: (a: string) => void }) {
  const [fresh, setFresh] = useState(() => Date.now() - new Date(t.ts).getTime() < 8_000);
  useEffect(() => {
    if (!fresh) return;
    const id = setTimeout(() => setFresh(false), 900);
    return () => clearTimeout(id);
  }, [fresh]);
  const above = t.side === 'above';
  return (
    <button
      type="button"
      data-component="TradeRow"
      onClick={() => onSelect(t.wallet)}
      className={cn(
        'grid w-full grid-cols-[64px_minmax(0,1fr)_92px_72px] items-center gap-2.5 rounded-[10px] border-0 px-3 py-[11px] text-left transition-colors duration-[800ms] hover:bg-violet/[0.06] min-[760px]:grid-cols-[84px_minmax(0,1fr)_110px_90px_70px]',
        fresh ? 'bg-above/[0.1]' : 'bg-transparent',
      )}
    >
      <span className="font-mono text-xs leading-none text-faint">{ago(t.ts, now)}</span>
      <span className="flex min-w-0 items-center gap-2">
        <span className={cn('overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs font-medium leading-none', t.flagged ? 'text-above' : 'text-body')}>{shortAddr(t.wallet)}</span>
        {t.flagged ? <span className="flex-none rounded-[5px] bg-above/[0.14] px-1.5 py-[3px] font-mono text-[10px] font-semibold leading-none text-above">SMART</span> : null}
      </span>
      <span className={cn('justify-self-start rounded-[5px] px-[7px] py-[3px] font-mono text-[10px] font-semibold leading-none', above ? 'bg-above/[0.1] text-above' : 'bg-below/[0.1] text-below')}>
        {t.dir.toUpperCase()} {t.side.toUpperCase()}
      </span>
      <span className="text-right font-mono text-xs font-medium leading-none text-body">{usd(fromBase(t.usdc))}</span>
      <span className="hidden text-right font-mono text-xs font-medium leading-none text-muted min-[760px]:block">{cents(t.priceAfter)}</span>
    </button>
  );
}

/* ------------------------------ rules ------------------------------ */

export function ResolutionRules({ m }: { m: MarketDetail }) {
  const rows: { k: string; v: string }[] = [
    { k: 'Oracle', v: `Pyth ${m.oracle.symbol}` },
    { k: 'Feed id', v: m.rules.oracleFeedId ? `${m.rules.oracleFeedId.slice(0, 10)}…${m.rules.oracleFeedId.slice(-6)}` : 'n/a' },
    { k: 'Resolution rule', v: m.rules.settleRule },
    { k: 'Stale feed', v: 'Buys pause if the price is older than 60 seconds' },
    { k: 'Resolves', v: fmtDT(m.endsAt) },
    { k: 'Trading closes', v: fmtDT(m.tradingEndsAt) },
    { k: 'Settlement', v: 'Each share settles at $1 or $0. Redeem after settlement.' },
  ];
  if (m.status === 'settled') {
    rows.push({ k: 'Settled outcome', v: m.outcome ? m.outcome.toUpperCase() : 'n/a' });
    if (m.settlePrice != null) rows.push({ k: 'Settlement price', v: `$${m.settlePrice.toLocaleString('en-US', { maximumFractionDigits: 6 })}` });
    if (m.settlePublishTs) rows.push({ k: 'Price published', v: fmtDT(m.settlePublishTs) });
  }
  return (
    <div data-component="ResolutionRules" className="flex animate-gg-in flex-col gap-4">
      <p className="font-display text-base font-medium leading-[1.55] text-ink [text-wrap:pretty]">{m.rules.text}</p>
      <dl className="m-0 flex flex-col overflow-hidden rounded-[14px] border border-violet/[0.12]">
        {rows.map((r) => (
          <div key={r.k} className="flex justify-between gap-4 border-b border-violet/[0.08] px-3.5 py-3 text-[13px] last:border-b-0">
            <dt className="flex-none text-dim">{r.k}</dt>
            <dd className="m-0 text-right font-mono text-xs text-body">{r.v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/* ------------------------------ pool ------------------------------ */

export function PoolStats({ m }: { m: MarketDetail }) {
  const a = fromBase(m.pool.reserveAbove);
  const b = fromBase(m.pool.reserveBelow);
  const total = a + b;
  const aW = total > 0 ? (a / total) * 100 : 50;
  const segs = feeSegments(m.feeBreakdown);
  const stats = [
    { l: 'Complete sets', v: fromBase(m.pool.completeSets).toLocaleString('en-US', { maximumFractionDigits: 2 }) },
    { l: 'Fee pool', v: usd(fromBase(m.pool.feePool)) },
    { l: 'Pool depth', v: usdFromU64(m.liquidity) },
    { l: 'Volume', v: usdFromU64(m.volume) },
  ];
  return (
    <div data-component="PoolStats" className="flex animate-gg-in flex-col gap-[18px]">
      <div className="flex flex-col gap-2.5">
        <div className="flex justify-between gap-2 font-mono text-xs font-medium leading-none">
          <span className="text-above">ABOVE reserve · {a.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
          <span className="text-below">BELOW reserve · {b.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
        </div>
        <div className="flex h-3 gap-0.5 overflow-hidden rounded-md" role="img" aria-label={`ABOVE reserve ${Math.round(aW)}%, BELOW reserve ${Math.round(100 - aW)}%`}>
          <span className="transition-[width] duration-[600ms]" style={{ width: `${aW}%`, background: 'linear-gradient(90deg,rgba(44,230,214,0.5),#2CE6D6)' }} />
          <span className="flex-1" style={{ background: 'linear-gradient(90deg,#E046F0,rgba(224,70,240,0.5))' }} />
        </div>
        <span className="text-[13px] text-dim">Price comes from the reserve ratio: the fewer ABOVE shares left in the pool, the more ABOVE costs.</span>
      </div>
      <div data-component="DynamicFee" className="flex flex-col gap-3 rounded-[14px] border border-violet/20 bg-violet/[0.06] p-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-display text-[15px] font-semibold leading-[1.2]">{m.dynamicFee ? 'Dynamic fee now' : 'Fixed fee'}</span>
          <span className="font-display text-2xl font-semibold leading-none text-violet-pale" data-testid="fee-now">
            {bpsPct(m.dynamicFee ? m.feeBreakdown.totalBps : m.feeBpsNow)}
          </span>
        </div>
        {m.dynamicFee ? (
          <>
            <div className="flex h-2 gap-0.5 overflow-hidden rounded bg-white/[0.05]" role="img" aria-label="Fee breakdown">
              {segs.map((s) => (
                <span key={s.key} className="transition-[width] duration-[600ms]" style={{ width: `${s.pct}%`, background: s.color }} />
              ))}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-2 font-mono text-[11px] leading-[1.3] text-muted">
              {segs.map((s) => (
                <span key={s.key} className="flex items-center gap-1.5" data-testid={`fee-seg-${s.key}`}>
                  <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />
                  {s.label} {bpsPct(s.bps)}
                </span>
              ))}
            </div>
            <span className="text-[13px] leading-normal text-dim">
              Fees rise as resolution nears and when flagged wallets trade, so informed flow pays LPs instead of draining them. Capped at {bpsPct(m.feeBreakdown.capBps)}.
            </span>
          </>
        ) : (
          <span className="text-[13px] leading-normal text-dim">This market charges a flat {bpsPct(m.baseFeeBps)} on every trade.</span>
        )}
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2">
        {stats.map((x) => (
          <div key={x.l} className="flex flex-col gap-1.5 rounded-xl bg-white/[0.03] p-3.5">
            <span className="font-display text-lg font-semibold leading-none">{x.v}</span>
            <span className={eyebrow}>{x.l}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-1.5 text-xs text-dim">
        <span className={eyebrow}>On-chain accounts</span>
        {[
          ['Market', m.id],
          ['Vault', m.pool.vault],
          ['ABOVE mint', m.pool.aboveMint],
          ['BELOW mint', m.pool.belowMint],
        ].map(([k, v]) => (
          <a key={k} href={explorerAddr(v as string)} target="_blank" rel="noopener noreferrer" className="flex justify-between gap-3 font-mono text-[11px] text-muted hover:text-above">
            <span>{k}</span>
            <span>{shortAddr(v as string)} ↗</span>
          </a>
        ))}
      </div>
    </div>
  );
}

