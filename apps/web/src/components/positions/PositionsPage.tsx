'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { ActivityRow, MeResp, PositionRow } from '@groundgraph/sdk/api-types';
import { Button, ReasonList, ScoreRing, Segmented, SideBadge, StatCard, TradeReceipt, cn } from '@groundgraph/ui';
import { EmptyState, ErrorState, Skeleton } from '@/components/common/states';
import { useSigner } from '@/components/wallet/useSigner';
import { ago, fmtDT, fromBase, shortAddr, signedUsd, txShort, usd } from '@/lib/format';
import { useFlash } from '@/lib/hooks';
import { POSITION_TABS, alignmentCounts, filterPositions, portfolioTotals, type LeanFilter, type PositionTab, type SideFilter } from '@/lib/positions';
import { useActivity, useMe, usePositions } from '@/lib/queries';
import { explorerTx } from '@/lib/solana';
import { useUi } from '@/lib/stores';
import { PositionRowCard, type PositionReceipt } from './PositionRow';
import { TradingLimits } from './TradingLimits';

const eyebrow = 'font-mono text-[11px] font-medium leading-none tracking-[0.06em] uppercase text-faint';
const panel = 'rounded-[20px] border border-violet/[0.14] p-[clamp(16px,2.4vw,24px)]';
const panelBg = { background: 'linear-gradient(180deg, rgba(28,22,44,0.62), rgba(14,11,24,0.62))' } as const;
const ABOVE = '#2CE6D6';
const BELOW = '#E046F0';

export function PositionsPage() {
  const signer = useSigner();
  const openWallet = useUi((s) => s.openWallet);
  const session = signer.session;
  const enabled = !!session;

  const me = useMe(enabled);
  const open = usePositions('open', enabled);
  const redeem = usePositions('redeem', enabled);
  const resolved = usePositions('resolved', enabled);
  const activity = useActivity(enabled);

  const [tab, setTab] = useState<PositionTab>('open');
  const [receipts, setReceipts] = useState<PositionReceipt[]>([]);
  const [side, setSide] = useState<SideFilter>('all');
  const [lean, setLean] = useState<LeanFilter>('all');

  // Land on "To redeem" the first time something is waiting for the user, unless they already picked a tab.
  const [picked, setPicked] = useState(false);
  const redeemCount = redeem.data?.length ?? 0;
  const openCount = open.data?.length ?? 0;
  useEffect(() => {
    if (!picked && open.isSuccess && redeem.isSuccess && openCount === 0 && redeemCount > 0) setTab('redeem');
  }, [picked, open.isSuccess, redeem.isSuccess, openCount, redeemCount]);

  const totals = useMemo(() => portfolioTotals(open.data ?? [], redeem.data ?? [], resolved.data ?? []), [open.data, redeem.data, resolved.data]);
  const align = useMemo(() => alignmentCounts(open.data ?? []), [open.data]);
  const loadingAll = open.isPending || redeem.isPending || resolved.isPending;
  const readOnly = !signer.isSign;

  const rows = tab === 'open' ? open : tab === 'redeem' ? redeem : resolved;
  const allForTab = rows.data ?? [];
  const shown = useMemo(() => filterPositions(allForTab, side, tab === 'open' ? lean : 'all'), [allForTab, side, lean, tab]);
  const counts: Record<PositionTab, number | null> = { open: open.data?.length ?? null, redeem: redeem.data?.length ?? null, resolved: resolved.data?.length ?? null };

  const subtitle = !session ? 'Not connected' : session.mode === 'view' ? `Viewing ${shortAddr(session.wallet)} · read only` : `${session.walletName ?? 'Wallet'} · ${shortAddr(session.wallet)} · devnet`;

  return (
    <div data-component="PositionsPage" className="gg-page animate-gg-in">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2.5">
          <h1 className="m-0 font-display text-[clamp(30px,4vw,46px)] font-semibold leading-none tracking-[-0.03em]">Positions</h1>
          <span className="flex items-center gap-2 text-sm text-dim">
            <span aria-hidden className={cn('gg-dot', !session && 'opacity-40')} />
            {signer.loading ? 'Checking session' : subtitle}
          </span>
        </div>
        {session ? (
          <Link href="/markets" className="gg-btn gg-btn-ghost h-11 rounded-pill px-5 text-sm">
            Browse markets
          </Link>
        ) : null}
      </div>

      {signer.loading ? (
        <div className="mt-7 grid gap-3 min-[760px]:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[112px] rounded-[18px]" />
          ))}
        </div>
      ) : !session ? (
        <ConnectPrompt onConnect={() => openWallet('/positions')} />
      ) : (
        <>
          {open.isError && redeem.isError && resolved.isError ? (
            <ErrorState className="mt-7" title="Could not load your positions" message="The API did not answer. Your funds are not affected." onRetry={() => void Promise.all([open.refetch(), redeem.refetch(), resolved.refetch()])} />
          ) : (
            <Summary totals={totals} loading={loadingAll} />
          )}

          <div className="mt-4 flex flex-wrap items-stretch gap-4">
            <PortfolioPanel totals={totals} open={open.data ?? []} loading={loadingAll} />
            <WalletScorePanel me={me.data} loading={me.isPending} error={me.isError} align={align} openCount={totals.openCount} />
          </div>

          {me.data ? <TradingLimits me={me.data} readOnly={readOnly} /> : null}

          <div data-component="PositionTabs" className="mt-8 flex flex-wrap items-center justify-between gap-2.5">
            <Segmented
              role="tablist"
              ariaLabel="Position tabs"
              value={tab}
              onChange={(t) => {
                setPicked(true);
                setTab(t);
              }}
              options={POSITION_TABS.map((t) => ({ value: t.id, label: t.label, count: counts[t.id], countTone: t.id === 'redeem' && (counts.redeem ?? 0) > 0 ? ('violet' as const) : ('dim' as const) }))}
            />
            <div className="flex flex-wrap gap-2">
              <Segmented
                ariaLabel="Filter by side"
                label="Side"
                value={side}
                onChange={setSide}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'above', label: 'Above' },
                  { value: 'below', label: 'Below' },
                ]}
              />
              {tab === 'open' ? (
                <Segmented
                  ariaLabel="Filter by radar lean"
                  label="Radar"
                  value={lean}
                  onChange={setLean}
                  options={[
                    { value: 'all', label: 'All' },
                    { value: 'with', label: 'With' },
                    { value: 'against', label: 'Against' },
                  ]}
                />
              ) : null}
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-2.5" role="tabpanel" aria-label={`${tab} positions`}>
            {receipts.map((r) => (
              <TradeReceipt
                key={r.id}
                title={r.title}
                sub={r.sub}
                footer={
                  <>
                    <a href={explorerTx(r.signature)} target="_blank" rel="noopener noreferrer" className="text-faint hover:text-above">
                      tx {txShort(r.signature)} ↗
                    </a>
                    <button type="button" className="text-dim hover:text-ink" onClick={() => setReceipts((cur) => cur.filter((x) => x.id !== r.id))}>
                      Dismiss
                    </button>
                  </>
                }
              />
            ))}
            {rows.isPending ? (
              [0, 1, 2].map((i) => <Skeleton key={i} className="h-[168px] rounded-[18px]" />)
            ) : rows.isError ? (
              <ErrorState title="Could not load this tab" onRetry={() => void rows.refetch()} />
            ) : shown.length === 0 ? (
              <EmptyState
                title={allForTab.length === 0 ? emptyTitle(tab) : 'No positions match these filters'}
                action={
                  allForTab.length === 0 ? (
                    <Link href="/markets" className="gg-btn gg-btn-primary h-11 rounded-xl px-5 text-sm text-white hover:text-white">
                      Browse markets
                    </Link>
                  ) : (
                    <Button
                      variant="quiet"
                      size="sm"
                      onClick={() => {
                        setSide('all');
                        setLean('all');
                      }}
                    >
                      Clear filters
                    </Button>
                  )
                }
              >
                {allForTab.length === 0 ? emptyBody(tab, readOnly) : 'Try another side or radar filter.'}
              </EmptyState>
            ) : (
              shown.map((p) => <PositionRowCard key={`${tab}-${p.marketId}-${p.side}-${p.shares}`} p={p} all={allForTab} readOnly={readOnly} onDone={(r) => setReceipts((cur) => [r, ...cur.filter((x) => x.id !== r.id)])} />)
            )}
          </div>

          <h2 className="mb-3 mt-10 font-display text-xl font-semibold leading-none">Activity</h2>
          <ActivityLog q={activity} />
        </>
      )}
    </div>
  );
}

function emptyTitle(t: PositionTab): string {
  return t === 'open' ? 'No open positions' : t === 'redeem' ? 'Nothing to redeem' : 'No resolved positions yet';
}
function emptyBody(t: PositionTab, readOnly: boolean): string {
  if (t === 'open') return readOnly ? 'This address has no open positions on devnet.' : 'Pick a market, choose ABOVE or BELOW, and your position shows up here.';
  if (t === 'redeem') return 'When a market you hold settles, any USDC owed to you appears here to redeem.';
  return 'Settled and voided markets you held show up here once they resolve.';
}

function ConnectPrompt({ onConnect }: { onConnect: () => void }) {
  return (
    <div
      data-component="ConnectPrompt"
      className="mt-7 flex flex-col items-center gap-4 rounded-3xl border border-dashed border-violet/25 px-6 py-[clamp(32px,6vw,72px)] text-center"
      style={{ background: 'radial-gradient(70% 90% at 50% 0%, rgba(91,44,143,0.22), transparent 70%)' }}
    >
      <img src="/gg-icon.png" alt="" width={56} height={56} className="h-14 w-14 rounded-[14px] opacity-90" />
      <h2 className="m-0 font-display text-2xl font-semibold leading-[1.2]">Connect a wallet to see your positions</h2>
      <p className="m-0 max-w-[420px] text-dim">Your open positions, resolved payouts, and how they line up with the smart money radar. You can also paste an address to look, read only.</p>
      <Button size="lg" onClick={onConnect} data-testid="connect-positions">
        Connect wallet
      </Button>
    </div>
  );
}

/* ----------------------------- summary ----------------------------- */

function Flashy({ value, children }: { value: unknown; children: (flash: boolean) => React.ReactNode }) {
  return <>{children(useFlash(value))}</>;
}

function Summary({ totals, loading }: { totals: ReturnType<typeof portfolioTotals>; loading: boolean }) {
  if (loading) {
    return (
      <div className="mt-7 grid grid-cols-2 gap-3 min-[760px]:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[112px] rounded-[18px]" />
        ))}
      </div>
    );
  }
  const u = totals.unrealized;
  const r = totals.resolvedPnl;
  const items = [
    { k: 'open', label: 'Open value', value: usd(totals.openValue), color: undefined, sub: `${totals.openCount} open ${totals.openCount === 1 ? 'position' : 'positions'} · cost ${usd(totals.openCost)}`, raw: totals.openValue },
    { k: 'unrealized', label: 'Unrealized P&L', value: signedUsd(u), color: u === 0 ? undefined : u > 0 ? ABOVE : BELOW, sub: 'Marked to the current pool price', raw: u },
    { k: 'redeem', label: 'To redeem', value: usd(totals.toRedeem), color: totals.toRedeem > 0 ? '#B48CFF' : undefined, sub: totals.redeemCount === 0 ? 'Nothing settled and waiting' : `${totals.redeemCount} settled ${totals.redeemCount === 1 ? 'position' : 'positions'}`, raw: totals.toRedeem },
    { k: 'resolved', label: 'Resolved P&L', value: signedUsd(r), color: r === 0 ? undefined : r > 0 ? ABOVE : BELOW, sub: `From ${totals.resolvedCount} settled ${totals.resolvedCount === 1 ? 'position' : 'positions'}`, raw: r },
  ];
  return (
    <div data-component="PortfolioSummary" className="mt-7 grid grid-cols-2 gap-3 min-[760px]:grid-cols-4">
      {items.map((s) => (
        <Flashy key={s.k} value={s.raw}>
          {(flash) => <StatCard label={s.label} value={<span data-testid={`stat-${s.k}`}>{s.value}</span>} sub={s.sub} valueColor={s.color} glow={flash} className="min-w-0" />}
        </Flashy>
      ))}
    </div>
  );
}

/** Portfolio value and where it sits. The value-over-time line is not drawn: the API publishes no portfolio history yet. */
function PortfolioPanel({ totals, open, loading }: { totals: ReturnType<typeof portfolioTotals>; open: PositionRow[]; loading: boolean }) {
  const total = totals.openValue + totals.toRedeem;
  const ex = totals.exposure;
  const exTotal = ex.above + ex.below;
  const top = [...open].sort((a, b) => fromBase(b.value) - fromBase(a.value)).slice(0, 4);
  return (
    <section data-component="PnlChart" className={cn(panel, 'flex min-w-0 flex-[999_1_520px] flex-col gap-4')} style={panelBg}>
      <div className="flex flex-col gap-2">
        <span className={eyebrow}>Portfolio value</span>
        {loading ? <Skeleton className="h-9 w-40" /> : <span className="font-display text-[34px] font-semibold leading-none tracking-[-0.02em] text-ink">{usd(total)}</span>}
        <span className="text-xs text-dim">Open positions at the current pool price plus anything waiting to be redeemed.</span>
      </div>
      <div className="flex flex-col gap-2.5">
        <span className={eyebrow}>Exposure by side</span>
        {exTotal > 0 ? (
          <>
            <div className="flex h-2.5 overflow-hidden rounded-pill bg-white/[0.06]" role="img" aria-label={`ABOVE ${usd(ex.above)}, BELOW ${usd(ex.below)}`}>
              <span style={{ width: `${(ex.above / exTotal) * 100}%`, background: ABOVE }} />
              <span style={{ width: `${(ex.below / exTotal) * 100}%`, background: BELOW }} />
            </div>
            <div className="flex justify-between font-mono text-xs">
              <span style={{ color: ABOVE }}>ABOVE {usd(ex.above)}</span>
              <span style={{ color: BELOW }}>BELOW {usd(ex.below)}</span>
            </div>
          </>
        ) : (
          <span className="text-sm text-dim">{loading ? 'Loading' : 'No open exposure.'}</span>
        )}
      </div>
      {top.length > 0 ? (
        <div className="flex flex-col gap-2.5" data-testid="largest-positions">
          <span className={eyebrow}>Largest open positions</span>
          {top.map((p) => {
            const v = fromBase(p.value);
            return (
              <Link key={`${p.marketId}-${p.side}`} href={`/markets/${p.marketId}`} className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 text-[13px] text-ink-2 hover:text-above">
                <SideBadge side={p.side} />
                <span className="flex min-w-0 flex-col gap-1.5">
                  <span className="truncate">{p.question}</span>
                  <span className="h-1 overflow-hidden rounded-[2px] bg-white/[0.06]">
                    <span className="block h-full" style={{ width: `${totals.openValue > 0 ? Math.max(2, (v / totals.openValue) * 100) : 0}%`, background: p.side === 'above' ? ABOVE : BELOW }} />
                  </span>
                </span>
                <span className="font-mono text-xs tabular-nums">{usd(v)}</span>
              </Link>
            );
          })}
        </div>
      ) : null}
      <div className="mt-auto rounded-xl border border-dashed border-violet/20 px-3.5 py-3 text-xs leading-[1.5] text-dim">
        <strong className="font-semibold text-muted">Value history: building.</strong> A portfolio line chart needs a recorded history, and the API does not publish one yet. Nothing is estimated here.
      </div>
    </section>
  );
}

/* ----------------------------- wallet score ----------------------------- */

function WalletScorePanel({ me, loading, error, align, openCount }: { me: MeResp | undefined; loading: boolean; error: boolean; align: ReturnType<typeof alignmentCounts>; openCount: number }) {
  const ws = me?.walletScore ?? null;
  const decided = align.with + align.against;
  return (
    <section data-component="YourWalletScore" className={cn(panel, 'flex min-w-0 flex-[1_1_320px] flex-col gap-4')} style={{ background: 'radial-gradient(90% 90% at 100% 0%, rgba(91,44,143,0.3), rgba(14,11,24,0.7))', borderColor: 'rgba(155,107,255,0.2)' }}>
      <span className={eyebrow}>How the radar sees you</span>
      {loading ? (
        <Skeleton className="h-[72px] w-full" />
      ) : error ? (
        <span className="text-sm text-dim">Your wallet score could not be loaded.</span>
      ) : ws ? (
        <>
          <div className="flex items-center gap-4">
            <ScoreRing score={ws.score} color={ws.smart ? ABOVE : '#9B6BFF'} size={72} />
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="font-display text-base font-semibold leading-[1.2]">{ws.smart ? 'Flagged as smart money' : 'Not flagged'}</span>
              <span className="text-xs leading-[1.45] text-dim">{ws.smart ? 'Your wallet clears the smart money threshold on its past trades.' : 'Scores of 70 and above are flagged. This is a description of past trades, not a forecast.'}</span>
            </div>
          </div>
          {ws.reasons.length > 0 ? <ReasonList reasons={ws.reasons.slice(0, 4)} /> : null}
        </>
      ) : (
        <div className="rounded-xl border border-dashed border-violet/20 px-3.5 py-3 text-sm leading-[1.5] text-dim">
          <strong className="font-semibold text-muted">Score: building.</strong> This wallet has too little scored history for the radar to rate it yet.
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1.5 rounded-xl border border-above/[0.18] bg-above/[0.06] p-3">
          <span className="font-display text-lg font-semibold leading-none" style={{ color: ABOVE }} data-testid="with-count">
            {align.with}
          </span>
          <span className="text-xs text-dim">open with the radar lean</span>
        </div>
        <div className="flex flex-col gap-1.5 rounded-xl border border-below/[0.16] bg-below/5 p-3">
          <span className="font-display text-lg font-semibold leading-none" style={{ color: BELOW }} data-testid="against-count">
            {align.against}
          </span>
          <span className="text-xs text-dim">open against it</span>
        </div>
      </div>
      <span className="text-[11px] leading-[1.5] text-faint">
        {openCount === 0 ? 'Counts use the radar lean today. ' : decided === 0 ? 'No open position has a radar lean yet. ' : 'Counts use the radar lean today, not at the time you entered. '}A record of how you did with or against the radar needs the lean at entry, which is not published yet.
      </span>
    </section>
  );
}

/* ----------------------------- activity ----------------------------- */

const TYPE_LABEL: Record<ActivityRow['type'], string> = { buy: 'Buy', sell: 'Sell', merge: 'Merge', redeem: 'Redeem', create: 'Create', break: 'Break', limit: 'Limit' };

function ActivityLog({ q }: { q: ReturnType<typeof useActivity> }) {
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  if (q.isPending) return <Skeleton className="h-[220px] rounded-2xl" />;
  if (q.isError) return <ErrorState title="Could not load activity" onRetry={() => void q.refetch()} />;
  if (items.length === 0) return <EmptyState>No activity yet. Trades, redemptions, limits and breaks are listed here.</EmptyState>;
  return (
    <div data-component="ActivityLog" className="flex flex-col overflow-hidden rounded-2xl border border-violet/[0.12]">
      {items.map((a, i) => (
        <div key={`${a.ts}-${i}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-b border-violet/[0.08] px-4 py-3.5 text-[13px] last:border-b-0">
          <span className="flex min-w-0 flex-[1_1_300px] items-center gap-3">
            <span className="w-14 flex-none font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-faint">{TYPE_LABEL[a.type]}</span>
            {a.marketId ? (
              <Link href={`/markets/${a.marketId}`} className="min-w-0 text-ink-2 hover:text-above">
                {a.summary}
              </Link>
            ) : (
              <span className="min-w-0 text-ink-2">{a.summary}</span>
            )}
          </span>
          <span className="flex items-center gap-3 font-mono text-[11px] text-faint">
            {a.txSig ? (
              <a href={explorerTx(a.txSig)} target="_blank" rel="noopener noreferrer" className="hover:text-above">
                tx {txShort(a.txSig)} ↗
              </a>
            ) : null}
            <span title={fmtDT(a.ts)}>{ago(a.ts) === 'now' ? 'just now' : `${ago(a.ts)} ago`}</span>
          </span>
        </div>
      ))}
      {q.hasNextPage ? (
        <button type="button" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage} className="gg-btn gg-btn-quiet m-3 h-10 rounded-[10px] text-[13px]">
          {q.isFetchingNextPage ? 'Loading' : 'Load older activity'}
        </button>
      ) : null}
    </div>
  );
}
