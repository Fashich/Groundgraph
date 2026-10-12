import type { PriceReading } from '@groundgraph/svc-core';
import { describe, expect, it } from 'vitest';
import { confidenceOk, decideSettlement, escalateFee, retryDelaySecs, validateReading, type DecideInput } from '../src/settle-logic';

const FEED = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
const SETTLE = 1_800_000_000;

const reading = (o: Partial<PriceReading> = {}): PriceReading => ({
  feedIdHex: FEED,
  price: 250.5,
  conf: 0.1,
  expo: -8,
  rawPrice: 25_050_000_000n,
  rawConf: 10_000_000n,
  publishTs: SETTLE + 3,
  source: 'push-feed',
  account: 'PushAccount11111111111111111111111111111111',
  verification: 'full',
  ...o,
});

const base = (o: Partial<DecideInput> = {}): DecideInput => ({
  nowSec: SETTLE + 5,
  settleTs: SETTLE,
  maxStalenessSecs: 60,
  maxConfBps: 50,
  voidGraceSecs: 3600,
  status: 'open',
  kind: 'close',
  mode: 'push-feed',
  push: reading(),
  assetSupported: true,
  feedIdHex: FEED,
  ...o,
});

describe('confidenceOk (mirrors programs/groundgraph math::confidence_ok)', () => {
  it('accepts exactly max_conf_bps and rejects above it', () => {
    expect(confidenceOk(50n, 10_000n, 50)).toBe(true);
    expect(confidenceOk(51n, 10_000n, 50)).toBe(false);
  });
  it('rejects a non-positive price', () => {
    expect(confidenceOk(0n, 0n, 50)).toBe(false);
    expect(confidenceOk(0n, -5n, 50)).toBe(false);
  });
});

describe('validateReading', () => {
  const p = { nowSec: SETTLE + 5, settleTs: SETTLE, maxStalenessSecs: 60, maxConfBps: 50, voidGraceSecs: 3600 };
  it('accepts an update inside [settle_ts, settle_ts + max_staleness]', () => {
    expect(validateReading(reading({ publishTs: SETTLE }), FEED, p)).toEqual({ ok: true });
    expect(validateReading(reading({ publishTs: SETTLE + 60 }), FEED, p)).toEqual({ ok: true });
  });
  it('rejects updates outside the window', () => {
    expect(validateReading(reading({ publishTs: SETTLE - 1 }), FEED, p)).toEqual({ ok: false, reason: 'before_settle_ts' });
    expect(validateReading(reading({ publishTs: SETTLE + 61 }), FEED, p)).toEqual({ ok: false, reason: 'after_window' });
  });
  it('rejects partially verified, wrong feed, zero price and wide confidence', () => {
    expect(validateReading(reading({ verification: 'partial' }), FEED, p)).toMatchObject({ reason: 'not_verified' });
    expect(validateReading(reading({ feedIdHex: 'aa'.repeat(32) }), FEED, p)).toMatchObject({ reason: 'wrong_feed' });
    expect(validateReading(reading({ rawPrice: 0n }), FEED, p)).toMatchObject({ reason: 'non_positive_price' });
    expect(validateReading(reading({ rawConf: 1_000_000_000n }), FEED, p)).toMatchObject({ reason: 'confidence_too_wide' });
  });
});

describe('decideSettlement', () => {
  it('waits until settle_ts', () => {
    expect(decideSettlement(base({ nowSec: SETTLE - 30 }))).toEqual({ action: 'wait', reason: 'before_settle_ts', inSecs: 30 });
  });

  it('skips resolved markets and touch markets', () => {
    expect(decideSettlement(base({ status: 'settled' }))).toEqual({ action: 'skip', reason: 'not_open' });
    expect(decideSettlement(base({ status: 'voided' }))).toEqual({ action: 'skip', reason: 'not_open' });
    expect(decideSettlement(base({ kind: 'touch' }))).toEqual({ action: 'skip', reason: 'unsupported_kind' });
  });

  it('push feed: settles with the feed account when its update is inside the window', () => {
    expect(decideSettlement(base())).toEqual({ action: 'settle-push', account: 'PushAccount11111111111111111111111111111111' });
  });

  it('push feed: waits while the feed has not published after settle_ts and the window is open', () => {
    const d = decideSettlement(base({ push: reading({ publishTs: SETTLE - 4 }), nowSec: SETTLE + 10 }));
    expect(d).toEqual({ action: 'wait-feed', reason: 'feed_not_updated', windowLeftSecs: 50 });
  });

  it('push feed: a stale feed after the window closes can only be voided', () => {
    const d = decideSettlement(base({ push: reading({ publishTs: SETTLE - 400 }), nowSec: SETTLE + 90 }));
    expect(d).toEqual({ action: 'unavailable', reason: 'feed_stale', voidInSecs: 3600 - 90 });
  });

  it('push feed: an update newer than the window cannot be used', () => {
    const d = decideSettlement(base({ push: reading({ publishTs: SETTLE + 200 }), nowSec: SETTLE + 205 }));
    expect(d).toMatchObject({ action: 'unavailable', reason: 'window_missed' });
  });

  it('push feed: assets without a fresh push feed are not settled (documented SOL and ETH only)', () => {
    expect(decideSettlement(base({ assetSupported: false }))).toMatchObject({ action: 'unavailable', reason: 'asset_not_supported_by_push_feed' });
  });

  it('push feed: missing account waits in the window, then gives up', () => {
    expect(decideSettlement(base({ push: null }))).toMatchObject({ action: 'wait-feed', reason: 'feed_missing' });
    expect(decideSettlement(base({ push: null, nowSec: SETTLE + 70 }))).toMatchObject({ action: 'unavailable', reason: 'feed_stale' });
  });

  it('push feed: wide confidence waits for a better update inside the window', () => {
    const d = decideSettlement(base({ push: reading({ rawConf: 900_000_000n }) }));
    expect(d).toMatchObject({ action: 'wait-feed', reason: 'confidence_too_wide' });
  });

  it('hermes mode settles through Hermes regardless of the push feed', () => {
    expect(decideSettlement(base({ mode: 'hermes', push: null, assetSupported: false }))).toEqual({ action: 'settle-hermes' });
  });

  it('hermes mode keeps trying for the whole grace hour', () => {
    expect(decideSettlement(base({ mode: 'hermes', nowSec: SETTLE + 3599 }))).toEqual({ action: 'settle-hermes' });
  });

  it('voids at settle_ts + 1h in either mode', () => {
    expect(decideSettlement(base({ nowSec: SETTLE + 3600 }))).toEqual({ action: 'void' });
    expect(decideSettlement(base({ mode: 'hermes', nowSec: SETTLE + 7200 }))).toEqual({ action: 'void' });
    expect(decideSettlement(base({ nowSec: SETTLE + 3599, push: null }))).toMatchObject({ action: 'unavailable' });
  });
});

describe('retry helpers', () => {
  it('doubles the priority fee per attempt up to the cap', () => {
    expect([0, 1, 2, 3, 10].map((a) => escalateFee(5_000, a, 200_000))).toEqual([5_000, 10_000, 20_000, 40_000, 200_000]);
    expect(escalateFee(0, 3, 200_000)).toBe(0);
  });
  it('backs off 5s, 10s, 20s, 40s then 60s', () => {
    expect([1, 2, 3, 4, 5, 9].map(retryDelaySecs)).toEqual([5, 10, 20, 40, 60, 60]);
  });
});
