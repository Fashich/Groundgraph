/**
 * Pure settlement decisions. No I/O here: the executor feeds in the on-chain market, the chain config and the price
 * readings it has, and gets back what to do. The rules mirror programs/groundgraph/src/instructions/settle.rs.
 */
import type { PriceReading } from '@groundgraph/svc-core';

export interface SettleParams {
  nowSec: number;
  settleTs: number;
  /** config.max_staleness_secs: the accepted publish_time window above settle_ts */
  maxStalenessSecs: number;
  maxConfBps: number;
  /** VOID_GRACE_SECS */
  voidGraceSecs: number;
}

/** conf * 10_000 <= max_conf_bps * price, with price > 0 (same integer rule as the program). */
export function confidenceOk(conf: bigint, price: bigint, maxConfBps: number): boolean {
  if (price <= 0n) return false;
  return conf * 10_000n <= BigInt(maxConfBps) * price;
}

export type ReadingVerdict = { ok: true } | { ok: false; reason: 'not_verified' | 'before_settle_ts' | 'after_window' | 'non_positive_price' | 'confidence_too_wide' | 'wrong_feed' };

/** Would settle_close accept this price update for this market? */
export function validateReading(r: Pick<PriceReading, 'feedIdHex' | 'rawPrice' | 'rawConf' | 'publishTs' | 'verification'>, feedIdHex: string, p: SettleParams): ReadingVerdict {
  if (r.feedIdHex.toLowerCase() !== feedIdHex.toLowerCase()) return { ok: false, reason: 'wrong_feed' };
  if (r.verification === 'partial') return { ok: false, reason: 'not_verified' };
  if (r.publishTs < p.settleTs) return { ok: false, reason: 'before_settle_ts' };
  if (r.publishTs > p.settleTs + p.maxStalenessSecs) return { ok: false, reason: 'after_window' };
  if (r.rawPrice <= 0n) return { ok: false, reason: 'non_positive_price' };
  if (!confidenceOk(r.rawConf, r.rawPrice, p.maxConfBps)) return { ok: false, reason: 'confidence_too_wide' };
  return { ok: true };
}

export type SettleDecision =
  | { action: 'wait'; reason: 'before_settle_ts'; inSecs: number }
  | { action: 'skip'; reason: 'not_open' | 'unsupported_kind' }
  /** fetch the update at settle_ts from Hermes, post it and settle in one go */
  | { action: 'settle-hermes' }
  /** the push feed account already holds a valid update: settle with it */
  | { action: 'settle-push'; account: string }
  /** keyless mode and the feed has not produced a usable update (yet) */
  | { action: 'wait-feed'; reason: 'feed_missing' | 'feed_not_updated' | 'feed_not_verified' | 'confidence_too_wide' | 'non_positive_price'; windowLeftSecs: number }
  /** keyless mode and the settlement window cannot be met: only a void remains */
  | { action: 'unavailable'; reason: 'asset_not_supported_by_push_feed' | 'window_missed' | 'feed_stale'; voidInSecs: number }
  | { action: 'void' };

export interface DecideInput extends SettleParams {
  status: 'open' | 'settled' | 'voided';
  kind: 'close' | 'touch';
  mode: 'hermes' | 'push-feed';
  /** latest on-chain push feed reading (push-feed mode) */
  push: PriceReading | null;
  /** push feeds are trusted only for these assets */
  assetSupported: boolean;
  feedIdHex: string;
}

/**
 * Decide the next step for one market. Called repeatedly (every few seconds) until the market is resolved; every
 * answer is safe to act on more than once because the program rejects a second settle or void.
 */
export function decideSettlement(i: DecideInput): SettleDecision {
  if (i.status !== 'open') return { action: 'skip', reason: 'not_open' };
  if (i.kind !== 'close') return { action: 'skip', reason: 'unsupported_kind' };
  if (i.nowSec < i.settleTs) return { action: 'wait', reason: 'before_settle_ts', inSecs: i.settleTs - i.nowSec };
  const voidAt = i.settleTs + i.voidGraceSecs;
  if (i.nowSec >= voidAt) return { action: 'void' };
  const voidInSecs = voidAt - i.nowSec;
  if (i.mode === 'hermes') return { action: 'settle-hermes' };

  // Keyless mode: the push feed account only ever holds the LATEST update, and the program only accepts a publish_time in
  // [settle_ts, settle_ts + max_staleness]. So this works only while that window is open (or the update inside it is still latest).
  if (!i.assetSupported) return { action: 'unavailable', reason: 'asset_not_supported_by_push_feed', voidInSecs };
  const windowEnd = i.settleTs + i.maxStalenessSecs;
  const windowLeft = windowEnd - i.nowSec;
  const r = i.push;
  if (!r) return windowLeft > 0 ? { action: 'wait-feed', reason: 'feed_missing', windowLeftSecs: windowLeft } : { action: 'unavailable', reason: 'feed_stale', voidInSecs };
  const verdict = validateReading(r, i.feedIdHex, i);
  if (verdict.ok) return { action: 'settle-push', account: r.account ?? '' };
  switch (verdict.reason) {
    case 'before_settle_ts':
      return windowLeft > 0 ? { action: 'wait-feed', reason: 'feed_not_updated', windowLeftSecs: windowLeft } : { action: 'unavailable', reason: 'feed_stale', voidInSecs };
    case 'after_window':
      return { action: 'unavailable', reason: 'window_missed', voidInSecs };
    case 'not_verified':
      return { action: 'wait-feed', reason: 'feed_not_verified', windowLeftSecs: Math.max(0, windowLeft) };
    case 'confidence_too_wide':
      return windowLeft > 0 ? { action: 'wait-feed', reason: 'confidence_too_wide', windowLeftSecs: windowLeft } : { action: 'unavailable', reason: 'window_missed', voidInSecs };
    case 'non_positive_price':
      return { action: 'wait-feed', reason: 'non_positive_price', windowLeftSecs: Math.max(0, windowLeft) };
    case 'wrong_feed':
      return { action: 'wait-feed', reason: 'feed_missing', windowLeftSecs: Math.max(0, windowLeft) };
  }
}

/** Priority fee for attempt `n` (0 based): base, doubled on every retry, capped. */
export function escalateFee(base: number, attempt: number, max: number): number {
  if (base <= 0) return 0;
  return Math.min(max, base * 2 ** Math.min(attempt, 20));
}

/** Seconds to wait before the next attempt on a market: 5s, 10s, 20s ... capped at 60s. */
export function retryDelaySecs(attempt: number): number {
  return Math.min(60, 5 * 2 ** Math.max(0, Math.min(attempt - 1, 10)));
}
