import type { ActivityRow, MarketDetail, MarketSummary, PositionRow, Quote, Side, TradeDir, TradeRow, UserSettings, WalletDetail } from '@groundgraph/sdk/api-types';
import * as amm from './amm';
import {
  ASSETS,
  CLUSTERS,
  DATA_SOURCE,
  DAY,
  HOUR,
  MODEL_VERSION,
  assetBySymbol,
  buildMarkets,
  buildWallets,
  flaggedEntries,
  makeQuestion,
  marketWalletRows,
  radarFor,
  ruleText,
  seededTrades,
  walletDetail,
  type MockMarket,
  type MockWallet,
} from './fixtures';
import { fakeAddress, hashStr, mulberry32 } from './rng';

export interface MockConfig {
  /** Push live deltas over WebSocket on a timer. */
  wsPush: boolean;
  /** Pretend server messages are this old (ms), to exercise the lag banner. */
  wsLagMs: number;
  /** RPC behaviour: 'normal' confirms quickly, 'slow' confirms after 15s, 'expire' never confirms. */
  rpc: 'normal' | 'slow' | 'expire';
  /** Next transaction build fails with this API error code (then resets). */
  failNext: string | null;
  /** Radar track record state. */
  trackBuilding: boolean;
  /** Current ToS version the API requires. */
  tosVersion: string;
  /** Block all transaction builds with geo_blocked. */
  geoBlockTx: boolean;
  /** Extra latency for every API call (ms). */
  latencyMs: number;
}

export const DEFAULT_CONFIG: MockConfig = { wsPush: true, wsLagMs: 0, rpc: 'normal', failNext: null, trackBuilding: false, tosVersion: process.env.NEXT_PUBLIC_TOS_VERSION || '2026-10-01', geoBlockTx: false, latencyMs: 0 };

export class ApiFail extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

interface Pos {
  shares: bigint;
  cost: bigint;
}
interface Settings {
  dailyLimit: bigint | null;
  breakUntil: number | null;
  sessionReminder: boolean;
  spent: bigint;
}

export interface Session {
  id: string;
  wallet: string;
  mode: 'sign' | 'view';
  walletName: string | null;
  tosVersion: string | null;
  expiresAt: number;
}

export const USDC = 1_000_000n;
const MIN_TRADE = USDC;

export class MockState {
  t0 = Date.now();
  cfg: MockConfig = { ...DEFAULT_CONFIG };
  wallets: MockWallet[];
  edges;
  markets: MockMarket[] = [];
  trades = new Map<string, TradeRow[]>();
  sessions = new Map<string, Session>();
  nonces = new Map<string, { nonce: string; issuedAt: number; exp: number }>();
  balances = new Map<string, bigint>();
  positions = new Map<string, Map<string, Pos>>();
  redeemedRows = new Map<string, PositionRow[]>();
  activity = new Map<string, ActivityRow[]>();
  settings = new Map<string, Settings>();
  watch = new Map<string, Set<string>>();
  tracked = new Map<string, Set<string>>();
  flow = new Map<string, { v: number; ts: number }>();
  oracle = new Map<string, number>();
  seq = new Map<string, number>();
  rng = mulberry32(99);

  constructor() {
    const b = buildWallets();
    this.wallets = b.wallets;
    this.edges = b.edges;
    this.reset();
  }

  /** Back to the initial fixtures. Used by tests between scenarios. */
  reset() {
    this.t0 = Date.now();
    this.cfg = { ...DEFAULT_CONFIG };
    this.markets = buildMarkets(this.wallets, this.t0);
    this.trades.clear();
    for (const m of this.markets) this.trades.set(m.id, seededTrades(m, this.wallets, this.t0));
    this.sessions.clear();
    this.nonces.clear();
    this.balances.clear();
    this.positions.clear();
    this.redeemedRows.clear();
    this.activity.clear();
    this.settings.clear();
    this.watch.clear();
    this.tracked.clear();
    this.flow.clear();
    this.oracle.clear();
    this.seq.clear();
    this.rng = mulberry32(99);
  }

  now() {
    return Date.now();
  }

  nextSeq(ch: string): number {
    const n = (this.seq.get(ch) ?? 0) + 1;
    this.seq.set(ch, n);
    return n;
  }

  height(): number {
    return 310_000_000 + Math.floor((Date.now() - this.t0) / 400);
  }

  /* ------------------------------ markets ------------------------------ */

  market(id: string): MockMarket {
    const m = this.markets.find((x) => x.id === id);
    if (!m) throw new ApiFail(404, 'not_found', 'Market not found');
    return m;
  }

  price(m: MockMarket): number {
    return m.status === 'settled' ? (m.outcome === 'above' ? 1 : 0) : amm.priceAbove(m.pool);
  }

  assetPrice(symbol: string): number {
    const a = assetBySymbol(symbol);
    if (!a) return 1;
    return this.oracle.get(symbol) ?? a.price;
  }

  bumpOracle(symbol: string) {
    const a = assetBySymbol(symbol);
    if (!a) return null;
    const p = this.assetPrice(symbol) * (1 + (this.rng() - 0.5) * 0.001);
    this.oracle.set(symbol, p);
    return p;
  }

  hoursLeft(m: MockMarket): number {
    return (m.settleTs - Date.now()) / HOUR;
  }

  flowBps(m: MockMarket): number {
    const f = this.flow.get(m.id);
    if (!f) return 0;
    const decayed = f.v * Math.exp(-(Date.now() - f.ts) / (20 * 60_000));
    return Math.min(100, Math.round(decayed * 100));
  }

  fee(m: MockMarket) {
    const baseBps = m.baseFeeBps;
    const nearBps = m.dynamicFee ? Math.min(100, Math.round(100 * Math.max(0, 1 - this.hoursLeft(m) / 24))) : 0;
    const flowBps = m.dynamicFee ? this.flowBps(m) : 0;
    const capBps = 300;
    return { baseBps, nearBps, flowBps, totalBps: Math.min(capBps, baseBps + nearBps + flowBps), capBps };
  }

  oracleInfo(m: MockMarket) {
    const a = assetBySymbol(m.asset.split('/')[0]!) ?? ASSETS[0]!;
    const stale = !!m.oracleStale;
    const age = stale ? 187 : 2 + Math.floor((Date.now() / 1000) % 6);
    return { feedId: a.feedId, symbol: a.feed, price: stale ? null : this.assetPrice(a.symbol), conf: stale ? null : this.assetPrice(a.symbol) * 0.0004, publishTs: stale ? null : new Date(Date.now() - age * 1000).toISOString(), ageSec: stale ? null : age, stale };
  }

  series(m: MockMarket, tf: '1D' | '3D' | '1W' | 'ALL') {
    const per = tf === '1D' ? 1 : tf === '3D' ? 3 : tf === '1W' ? 7 : 14;
    const n = m.series.length;
    const want = 96;
    const take = Math.min(n, per * want);
    const start = n - take;
    const step = Math.max(1, Math.floor(take / want));
    const pts: { ts: string; priceAbove: number }[] = [];
    for (let i = start; i < n; i += step) pts.push({ ts: new Date(this.t0 - (n - 1 - i) * 15 * 60_000 + (Date.now() - this.t0)).toISOString(), priceAbove: m.series[i]! });
    const last = this.price(m);
    pts[pts.length - 1] = { ts: new Date().toISOString(), priceAbove: last };
    return pts;
  }

  summary(m: MockMarket): MarketSummary {
    const price = this.price(m);
    const n = m.series.length;
    const ago24 = m.series[Math.max(0, n - 1 - 96)] ?? price;
    const fee = this.fee(m);
    return {
      id: m.id,
      question: m.question,
      kind: m.kind,
      direction: m.kind === 'touch' ? (m.dir === 'above' ? 'up' : 'down') : null,
      assetSymbol: m.asset,
      category: m.category,
      targetPrice: m.target,
      status: m.status,
      outcome: m.outcome,
      priceAbove: price,
      implied: price,
      ch24: Math.round((price - ago24) * 1000) / 10,
      spark: m.series.slice(-96).filter((_, i) => i % 2 === 0).slice(-48).concat([price]).slice(-48),
      radar: radarFor(m, this.wallets, price),
      feeBpsNow: fee.totalBps,
      baseFeeBps: m.baseFeeBps,
      dynamicFee: m.dynamicFee,
      endsAt: new Date(m.settleTs).toISOString(),
      tradingEndsAt: new Date(m.tradingEndsTs).toISOString(),
      volume: m.volume.toString(),
      liquidity: m.completeSets.toString(),
      traders: m.traders,
      creator: m.creator,
      isFeatured: m.featured,
    };
  }

  detail(m: MockMarket, tf: '1D' | '3D' | '1W' | 'ALL'): MarketDetail {
    const rules = ruleText(m);
    const o = this.oracleInfo(m);
    const asset = assetBySymbol(m.asset);
    const spot = o.price ?? asset?.price ?? 1;
    return {
      ...this.summary(m),
      history: { tf, points: this.series(m, tf) },
      flaggedEntries: flaggedEntries(m, this.wallets),
      fairValue: asset ? this.fairValue(m.asset, m.target, m.settleTs, m.kind, m.dir === 'below' ? 'down' : 'up') : null,
      oracle: o,
      rules: { text: rules.text, settleRule: rules.settleRule, oracleFeedId: o.feedId },
      pool: { reserveAbove: m.pool.ra.toString(), reserveBelow: m.pool.rb.toString(), completeSets: m.completeSets.toString(), feePool: m.feeFeePool.toString(), vault: fakeAddress(mulberry32(hashStr(m.id + 'v'))), aboveMint: fakeAddress(mulberry32(hashStr(m.id + 'a'))), belowMint: fakeAddress(mulberry32(hashStr(m.id + 'b'))), lpMint: fakeAddress(mulberry32(hashStr(m.id + 'l'))) },
      feeBreakdown: this.fee(m),
      settlePrice: m.status === 'settled' ? (m.outcome === 'above' ? m.target * 1.04 : m.target * 0.95) : null,
      settlePublishTs: m.status === 'settled' ? new Date(m.settleTs).toISOString() : null,
      ...(spot ? {} : {}),
    };
  }

  fairValue(asset: string, target: number, settleTs: number, kind: string, direction: string) {
    const a = assetBySymbol(asset) ?? ASSETS[0]!;
    const S = this.assetPrice(a.symbol);
    const T = Math.max(1e-6, (settleTs - Date.now()) / (365 * DAY));
    const sig = a.vol;
    const N = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));
    let p: number;
    if (kind === 'touch') {
      const z = Math.abs(Math.log(target / S)) / (sig * Math.sqrt(T));
      const touch = Math.min(0.99, 2 * (1 - N(z)));
      p = direction === 'down' ? 1 - touch : touch;
    } else {
      const d2 = (Math.log(S / target) - 0.5 * sig * sig * T) / (sig * Math.sqrt(T));
      p = N(d2);
    }
    return { spot: S, vol: sig, pAbove: Math.min(0.99, Math.max(0.01, p)), ts: new Date().toISOString() };
  }

  /* ------------------------------ accounts ------------------------------ */

  balance(w: string): bigint {
    return this.balances.get(w) ?? 0n;
  }

  setting(w: string): Settings {
    let s = this.settings.get(w);
    if (!s) {
      s = { dailyLimit: 500n * USDC, breakUntil: null, sessionReminder: false, spent: 0n };
      this.settings.set(w, s);
    }
    return s;
  }

  userSettings(w: string): UserSettings {
    const s = this.setting(w);
    return { dailyLimitUsdc: s.dailyLimit === null ? null : s.dailyLimit.toString(), breakUntil: s.breakUntil && s.breakUntil > Date.now() ? new Date(s.breakUntil).toISOString() : null, sessionReminder: s.sessionReminder, spentToday: s.spent.toString() };
  }

  log(w: string, row: Omit<ActivityRow, 'ts'>) {
    const list = this.activity.get(w) ?? [];
    list.unshift({ ts: new Date().toISOString(), ...row });
    this.activity.set(w, list.slice(0, 100));
  }

  walletPositions(w: string): Map<string, Pos> {
    let p = this.positions.get(w);
    if (!p) {
      p = new Map();
      this.positions.set(w, p);
      // deterministic starting book so every new wallet has something to look at
      const open = this.markets.filter((m) => m.status === 'open');
      const settledAbove = this.markets.find((m) => m.status === 'settled' && m.outcome === 'above');
      const settledBelow = this.markets.find((m) => m.status === 'settled' && m.outcome === 'below');
      const h = hashStr(w);
      const a = open[h % open.length];
      const b = open[(h >> 3) % open.length];
      if (a) p.set(`${a.id}|above`, { shares: 120n * USDC, cost: BigInt(Math.round(Number(a.pool.rb) / Number(a.pool.ra + a.pool.rb) * 120 * 0.9 * 1e6)) });
      if (b && b !== a) p.set(`${b.id}|below`, { shares: 80n * USDC, cost: 41n * USDC });
      if (settledAbove) p.set(`${settledAbove.id}|above`, { shares: 60n * USDC, cost: 24n * USDC });
      if (settledBelow) p.set(`${settledBelow.id}|above`, { shares: 40n * USDC, cost: 15n * USDC });
    }
    return p;
  }

  positionRows(w: string, tab: 'open' | 'redeem' | 'resolved'): PositionRow[] {
    const rows: PositionRow[] = [];
    for (const [key, pos] of this.walletPositions(w)) {
      if (pos.shares <= 0n) continue;
      const [id, side] = key.split('|') as [string, Side];
      const m = this.markets.find((x) => x.id === id);
      if (!m) continue;
      const price = this.price(m);
      const mark = side === 'above' ? price : 1 - price;
      const value = BigInt(Math.round(Number(pos.shares) * mark));
      const live = m.status === 'open' || m.status === 'trading_closed';
      const row: PositionRow = {
        marketId: m.id,
        question: m.question,
        side,
        shares: pos.shares.toString(),
        avgPrice: pos.cost === 0n ? 0 : Number(pos.cost) / Number(pos.shares),
        costBasis: pos.cost.toString(),
        markPrice: mark,
        value: value.toString(),
        pnl: (value - pos.cost).toString(),
        status: m.status,
        outcome: m.outcome,
        redeemable: m.status === 'settled' && m.outcome === side ? pos.shares.toString() : m.status === 'voided' ? (pos.shares / 2n).toString() : '0',
        radar: radarFor(m, this.wallets, price),
        endsAt: new Date(m.settleTs).toISOString(),
      };
      // Same semantics as the real API: open (incl. trading_closed), redeem (resolved with something to redeem), resolved (every resolved row).
      if (tab === 'open' && live) rows.push(row);
      else if (tab === 'redeem' && !live && BigInt(row.redeemable) > 0n) rows.push(row);
      else if (tab === 'resolved' && !live) rows.push(row);
    }
    if (tab === 'resolved') rows.push(...(this.redeemedRows.get(w) ?? []));
    return rows;
  }

  /* ------------------------------ quotes ------------------------------ */

  quote(m: MockMarket, side: Side, dir: TradeDir, amount: bigint, slippageBps: number, wallet: string | null): Quote {
    const fee = this.fee(m).totalBps;
    const before = this.price(m);
    const pBefore = side === 'above' ? before : 1 - before;
    const warnings: string[] = [];
    if (dir === 'buy') {
      if (amount > m.pool.ra + m.pool.rb) throw new ApiFail(422, 'insufficient_liquidity', 'Not enough liquidity for this size');
      const r = amm.buy(m.pool, side, amount, fee);
      const after = amm.priceAbove(r.pool);
      const pAfter = side === 'above' ? after : 1 - after;
      const avg = r.shares === 0n ? pBefore : Number(amount) / Number(r.shares);
      const minOut = (r.shares * BigInt(10000 - slippageBps)) / 10000n;
      if ((pAfter - pBefore) / Math.max(0.01, pBefore) > slippageBps / 10000) warnings.push('exceeds_slippage');
      if (m.oracleStale) warnings.push('oracle_stale');
      if (wallet) {
        if (amount * 4n > this.balance(wallet) && this.balance(wallet) > 0n) warnings.push('large_vs_balance');
        const s = this.setting(wallet);
        if (s.breakUntil && s.breakUntil > Date.now()) warnings.push('break_active');
        if (s.dailyLimit !== null && s.spent + amount > s.dailyLimit) warnings.push('daily_limit');
      }
      return { marketId: m.id, side, dir, amountIn: amount.toString(), amountOut: r.shares.toString(), minOut: minOut.toString(), slippageBps, avgPrice: avg, priceBefore: pBefore, priceAfter: pAfter, priceImpactBps: Math.round(Math.abs(pAfter - pBefore) * 10000), feeBps: fee, feeUsdc: r.fee.toString(), settleValue: r.shares.toString(), warnings };
    }
    const own = side === 'above' ? m.pool.ra : m.pool.rb;
    void own;
    const r = amm.sell(m.pool, side, amount, fee);
    const after = amm.priceAbove(r.pool);
    const pAfter = side === 'above' ? after : 1 - after;
    const avg = amount === 0n ? pBefore : Number(r.usdcOut) / Number(amount);
    const minOut = (r.usdcOut * BigInt(10000 - slippageBps)) / 10000n;
    if ((pBefore - pAfter) / Math.max(0.01, pBefore) > slippageBps / 10000) warnings.push('exceeds_slippage');
    return { marketId: m.id, side, dir, amountIn: amount.toString(), amountOut: r.usdcOut.toString(), minOut: minOut.toString(), slippageBps, avgPrice: avg, priceBefore: pBefore, priceAfter: pAfter, priceImpactBps: Math.round(Math.abs(pAfter - pBefore) * 10000), feeBps: fee, feeUsdc: r.fee.toString(), settleValue: null, warnings };
  }

  /* ------------------------------ effects (applied when a transaction confirms) ------------------------------ */

  recordFlow(m: MockMarket, usdc: bigint) {
    const prev = this.flow.get(m.id);
    const decayed = prev ? prev.v * Math.exp(-(Date.now() - prev.ts) / (20 * 60_000)) : 0;
    this.flow.set(m.id, { v: Math.min(1, decayed + Number(usdc) / 1e6 / 4000), ts: Date.now() });
  }

  applyBuy(wallet: string, m: MockMarket, side: Side, usdc: bigint): TradeRow {
    const fee = this.fee(m).totalBps;
    const r = amm.buy(m.pool, side, usdc, fee);
    m.pool = r.pool;
    m.completeSets += usdc - r.fee;
    m.volume += usdc;
    m.feeFeePool += r.fee;
    m.traders += 1;
    this.balances.set(wallet, this.balance(wallet) - usdc);
    const pos = this.walletPositions(wallet);
    const k = `${m.id}|${side}`;
    const cur = pos.get(k) ?? { shares: 0n, cost: 0n };
    pos.set(k, { shares: cur.shares + r.shares, cost: cur.cost + usdc });
    this.setting(wallet).spent += usdc;
    this.recordFlow(m, usdc);
    this.log(wallet, { type: 'buy', marketId: m.id, summary: `Bought ${side.toUpperCase()} · ${m.question}` });
    return this.pushTrade(m, wallet, side, 'buy', usdc, r.shares, r.fee);
  }

  applySell(wallet: string, m: MockMarket, side: Side, shares: bigint): TradeRow {
    const fee = this.fee(m).totalBps;
    const r = amm.sell(m.pool, side, shares, fee);
    m.pool = r.pool;
    m.completeSets -= r.gross;
    m.volume += r.gross;
    this.balances.set(wallet, this.balance(wallet) + r.usdcOut);
    const pos = this.walletPositions(wallet);
    const k = `${m.id}|${side}`;
    const cur = pos.get(k) ?? { shares: 0n, cost: 0n };
    const take = shares > cur.shares ? cur.shares : shares;
    const costOut = cur.shares === 0n ? 0n : (cur.cost * take) / cur.shares;
    pos.set(k, { shares: cur.shares - take, cost: cur.cost - costOut });
    this.recordFlow(m, r.gross);
    this.log(wallet, { type: 'sell', marketId: m.id, summary: `Sold ${side.toUpperCase()} · ${m.question}` });
    return this.pushTrade(m, wallet, side, 'sell', r.gross, shares, r.fee);
  }

  /** Test control: settle with an outcome, or void without one. No-op on a market that already resolved. */
  settleMarket(m: MockMarket, outcome: Side | null) {
    if (m.status === 'settled' || m.status === 'voided') return;
    m.status = outcome ? 'settled' : 'voided';
    m.outcome = outcome;
  }

  applyMerge(wallet: string, m: MockMarket, amount: bigint) {
    const pos = this.walletPositions(wallet);
    for (const side of ['above', 'below'] as Side[]) {
      const k = `${m.id}|${side}`;
      const cur = pos.get(k) ?? { shares: 0n, cost: 0n };
      const take = amount > cur.shares ? cur.shares : amount;
      const costOut = cur.shares === 0n ? 0n : (cur.cost * take) / cur.shares;
      pos.set(k, { shares: cur.shares - take, cost: cur.cost - costOut });
    }
    this.balances.set(wallet, this.balance(wallet) + amount);
    this.log(wallet, { type: 'merge', marketId: m.id, summary: `Merged ${Number(amount) / 1e6} complete sets · ${m.question}` });
  }

  applyRedeem(wallet: string, m: MockMarket, side: Side, amount: bigint) {
    const pos = this.walletPositions(wallet);
    const k = `${m.id}|${side}`;
    const cur = pos.get(k) ?? { shares: 0n, cost: 0n };
    const take = amount > cur.shares ? cur.shares : amount;
    const costOut = cur.shares === 0n ? 0n : (cur.cost * take) / cur.shares;
    pos.set(k, { shares: cur.shares - take, cost: cur.cost - costOut });
    // A voided market redeems every share at $0.50; a settled one pays $1 per winning share.
    const payout = m.status === 'voided' ? take / 2n : take;
    this.balances.set(wallet, this.balance(wallet) + payout);
    const list = this.redeemedRows.get(wallet) ?? [];
    list.unshift({
      marketId: m.id,
      question: m.question,
      side,
      shares: take.toString(),
      avgPrice: take === 0n ? 0 : Number(costOut) / Number(take),
      costBasis: costOut.toString(),
      markPrice: 1,
      value: payout.toString(),
      pnl: (payout - costOut).toString(),
      status: m.status === 'voided' ? 'voided' : 'settled',
      outcome: m.outcome,
      redeemable: '0',
      radar: radarFor(m, this.wallets, this.price(m)),
      endsAt: new Date(m.settleTs).toISOString(),
    });
    this.redeemedRows.set(wallet, list);
    this.log(wallet, { type: 'redeem', marketId: m.id, summary: `Redeemed ${Number(take) / 1e6} USDC · ${m.question}` });
  }

  applyCreate(wallet: string, p: { assetSymbol: string; kind: 'close' | 'touch'; targetPrice: number; settleTs: string; baseFeeBps: number; dynamicFee: boolean; liquidityUsdc: string; p0Bps?: number; id: string }): MockMarket {
    const settle = Date.parse(p.settleTs);
    const liq = BigInt(p.liquidityUsdc);
    const a = assetBySymbol(p.assetSymbol);
    const dir: 'above' | 'below' = p.kind === 'touch' && a && p.targetPrice < this.assetPrice(a.symbol) ? 'below' : 'above';
    const fv = this.fairValue(p.assetSymbol, p.targetPrice, settle, p.kind, dir === 'below' ? 'down' : 'up').pAbove;
    const p0 = p.p0Bps ? p.p0Bps / 10000 : fv;
    const m: MockMarket = {
      id: p.id,
      asset: p.assetSymbol,
      category: ['SOL', 'BTC', 'ETH'].includes(p.assetSymbol) ? 'Majors' : 'Solana ecosystem',
      kind: p.kind,
      dir,
      target: p.targetPrice,
      createdAt: Date.now(),
      settleTs: settle,
      tradingEndsTs: settle - (p.kind === 'close' ? 30 * 60_000 : 0),
      status: 'open',
      outcome: null,
      pool: amm.seedPool(liq, p0),
      completeSets: liq,
      feeFeePool: 0n,
      baseFeeBps: p.baseFeeBps,
      dynamicFee: p.dynamicFee,
      volume: 0n,
      traders: 0,
      creator: wallet,
      series: Array.from({ length: 96 }, () => p0),
      members: [],
      flaggedAt: [],
      question: '',
    };
    m.question = makeQuestion(m);
    this.markets.unshift(m);
    this.trades.set(m.id, []);
    this.balances.set(wallet, this.balance(wallet) - liq);
    this.log(wallet, { type: 'create', marketId: m.id, summary: `Created market · ${m.question}` });
    return m;
  }

  pushTrade(m: MockMarket, wallet: string, side: Side, dir: TradeDir, usdc: bigint, shares: bigint, fee: bigint): TradeRow {
    const row: TradeRow = {
      id: `${m.id.slice(0, 6)}-${Date.now()}-${Math.floor(this.rng() * 1e6)}`,
      ts: new Date().toISOString(),
      wallet,
      side,
      dir,
      usdc: usdc.toString(),
      shares: shares.toString(),
      feeUsdc: fee.toString(),
      priceAfter: this.price(m),
      txSig: fakeAddress(this.rng, 88),
      flagged: false,
    };
    const list = this.trades.get(m.id) ?? [];
    list.unshift(row);
    this.trades.set(m.id, list.slice(0, 300));
    return row;
  }

  /* ------------------------------ radar ------------------------------ */

  clusterName(id: number) {
    return CLUSTERS.find((c) => c.id === id)?.name ?? `Cluster ${id}`;
  }

  walletByAddr(addr: string): MockWallet | undefined {
    return this.wallets.find((w) => w.addr === addr);
  }

  walletDetailFor(addr: string): WalletDetail {
    const w = this.walletByAddr(addr);
    if (!w) throw new ApiFail(404, 'not_found', 'This wallet has no radar score yet');
    const open = this.markets
      .filter((m) => m.status === 'open')
      .flatMap((m) => m.members.filter((x) => x.wallet === w.idx).map((x) => ({ marketId: m.id, question: m.question, side: x.side, shares: x.usdc.toString(), entryPrice: x.entryPrice })));
    return walletDetail(w, this.clusterName(w.cluster), open);
  }

  /** Radar score of a signing wallet: deterministic, modest, and built from the same five features. */
  meScore(wallet: string): { score: number; smart: boolean; reasons: string[] } | null {
    if (hashStr(wallet) % 7 === 0) return null;
    const h = hashStr(wallet);
    const score = 24 + (h % 38);
    return { score, smart: false, reasons: ['Entry timing: you traded 2 of your last 9 markets before a move larger than 5%', `Hit rate: ${40 + (h % 20)}% on resolved markets (30d)`, 'Centrality: few links to flagged wallets yet'] };
  }

  modelVersion = MODEL_VERSION;
  dataSource = DATA_SOURCE;
}

/** Abramowitz-Stegun erf approximation, good to ~1e-7. */
function erf(x: number): number {
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}

export const state = new MockState();
