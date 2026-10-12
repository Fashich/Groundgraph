import type { Sql } from '@groundgraph/db';
import { CH, listAssetFeeds, RK, type AssetFeed, type Logger, type OraclePriceService, type OracleSnapshot, type PriceReading, type Redis } from '@groundgraph/svc-core';
import type { Alerter } from './alerts';
import type { KeeperMetrics } from './metrics';

export interface OracleLoopDeps {
  oracle: OraclePriceService;
  redis: Redis;
  sql: Sql;
  log: Logger;
  metrics: KeeperMetrics;
  alerter: Alerter;
  staleSecs: number;
  now: () => number;
  feeds?: AssetFeed[];
  /** minimum seconds between oracle_status rows per feed (a stale flip is always recorded) */
  statusEverySecs?: number;
  /** feeds that currently have an open market: only those raise stale alerts */
  watchedFeeds?: () => Promise<Set<string>>;
}

export function snapshotOf(feed: AssetFeed, r: PriceReading, nowMs: number, staleSecs: number): OracleSnapshot {
  const snap: OracleSnapshot = {
    feedId: feed.feedIdHex,
    symbol: feed.pair,
    price: r.price,
    conf: r.conf,
    expo: r.expo,
    publishTs: r.publishTs,
    fetchedAt: nowMs,
    source: r.source,
    stale: nowMs / 1000 - r.publishTs > staleSecs,
  };
  if (r.account) snap.account = r.account;
  return snap;
}

const STALE_ALERT_AFTER_SECS = 120;

/** Reads every allow-listed feed, caches the readings in Redis, streams changes and keeps a downsampled history in Postgres. */
export class OracleLoop {
  readonly latest = new Map<string, OracleSnapshot>();
  readonly readings = new Map<string, PriceReading>();
  private lastRow = new Map<string, { ms: number; stale: boolean }>();
  private staleSince = new Map<string, number>();
  private feeds: AssetFeed[];
  lastSuccessMs = 0;

  constructor(private d: OracleLoopDeps) {
    this.feeds = d.feeds ?? listAssetFeeds();
  }

  async tick(): Promise<number> {
    const nowMs = this.d.now();
    const got = await this.d.oracle.latest(this.feeds.map((f) => f.feedIdHex));
    this.lastSuccessMs = nowMs;
    const watched = this.d.watchedFeeds ? await this.d.watchedFeeds().catch(() => new Set<string>()) : null;
    for (const feed of this.feeds) {
      const r = got.get(feed.feedIdHex);
      if (!r) {
        this.d.metrics.oracleStale.set({ symbol: feed.symbol }, 1);
        continue;
      }
      this.readings.set(feed.feedIdHex, r);
      const snap = snapshotOf(feed, r, nowMs, this.d.staleSecs);
      const prev = this.latest.get(feed.feedIdHex);
      this.latest.set(feed.feedIdHex, snap);
      this.d.metrics.oracleAge.set({ symbol: feed.symbol }, Math.max(0, nowMs / 1000 - r.publishTs));
      this.d.metrics.oracleStale.set({ symbol: feed.symbol }, snap.stale ? 1 : 0);
      await this.d.redis.set(RK.oracle(feed.feedIdHex), JSON.stringify(snap), 'EX', 120);
      if (!prev || prev.publishTs !== snap.publishTs || prev.stale !== snap.stale) {
        await this.d.redis.publish(CH.oracle(feed.feedIdHex), JSON.stringify({ type: 'delta', data: snap })).catch(() => undefined);
      }
      await this.record(feed, snap, nowMs);
      await this.staleAlert(feed, snap, nowMs, watched);
    }
    return got.size;
  }

  private async record(feed: AssetFeed, snap: OracleSnapshot, nowMs: number): Promise<void> {
    const last = this.lastRow.get(feed.feedIdHex);
    const every = (this.d.statusEverySecs ?? 15) * 1000;
    if (last && nowMs - last.ms < every && last.stale === snap.stale) return;
    this.lastRow.set(feed.feedIdHex, { ms: nowMs, stale: snap.stale });
    const ts = new Date(Math.floor(nowMs / 1000) * 1000);
    await this.d.sql`INSERT INTO oracle_status (feed_id, ts, price, conf, publish_ts, stale)
      VALUES (${feed.feedIdHex}, ${ts}, ${String(snap.price)}, ${String(snap.conf)}, ${new Date(snap.publishTs * 1000)}, ${snap.stale})
      ON CONFLICT (feed_id, ts) DO NOTHING`;
  }

  private async staleAlert(feed: AssetFeed, snap: OracleSnapshot, nowMs: number, watched: Set<string> | null): Promise<void> {
    const key = `oracle-stale:${feed.feedIdHex}`;
    if (!snap.stale) {
      this.staleSince.delete(feed.feedIdHex);
      await this.d.alerter.resolve(key, `${feed.pair} oracle`, 'fresh readings again');
      return;
    }
    const since = this.staleSince.get(feed.feedIdHex) ?? nowMs;
    this.staleSince.set(feed.feedIdHex, since);
    if (watched && !watched.has(feed.feedIdHex)) return; // nobody is trading this feed
    if (nowMs - since >= STALE_ALERT_AFTER_SECS * 1000) {
      this.d.metrics.alerts.inc({ severity: 'warn' });
      await this.d.alerter.alert({
        key,
        severity: 'warn',
        title: `${feed.pair} oracle is stale`,
        message: `No fresh ${feed.pair} price for ${Math.round((nowMs - since) / 1000)}s while markets on it are open. Buys on these markets are blocked until it recovers.`,
        fields: { source: snap.source, ageSecs: Math.round(nowMs / 1000 - snap.publishTs) },
      });
    }
  }
}
