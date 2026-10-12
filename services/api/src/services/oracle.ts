import { assetByFeedId, listAssetFeeds, RK, type AssetFeed, type OracleSnapshot } from '@groundgraph/svc-core';
import type { OracleInfo } from '@groundgraph/sdk/api-types';
import type { AppContext } from '../context';

export async function readOracle(ctx: AppContext, feedIdHex: string): Promise<OracleSnapshot | null> {
  try {
    const raw = await ctx.redis.get(RK.oracle(feedIdHex));
    return raw ? (JSON.parse(raw) as OracleSnapshot) : null;
  } catch (err) {
    ctx.log.warn({ err }, 'oracle read failed');
    return null;
  }
}

/** Feed freshness as seen NOW: unknown/missing, old publish time, or a keeper that stopped refreshing all count as stale. */
export function isOracleStale(ctx: AppContext, snap: OracleSnapshot | null, nowMs: number): boolean {
  if (!snap) return true;
  const age = nowMs / 1000 - snap.publishTs;
  if (age > ctx.cfg.ORACLE_STALE_SECS) return true;
  if (nowMs - snap.fetchedAt > 30_000) return true;
  return snap.stale && age > ctx.cfg.ORACLE_STALE_SECS;
}

export function oracleInfo(ctx: AppContext, feedIdHex: string, snap: OracleSnapshot | null, nowMs: number): OracleInfo {
  const asset: AssetFeed | undefined = assetByFeedId(feedIdHex);
  const symbol = asset?.pair ?? snap?.symbol ?? 'UNKNOWN';
  if (!snap) return { feedId: feedIdHex, symbol, price: null, conf: null, publishTs: null, ageSec: null, stale: true };
  return {
    feedId: feedIdHex,
    symbol,
    price: snap.price,
    conf: snap.conf,
    publishTs: new Date(snap.publishTs * 1000).toISOString(),
    ageSec: Math.max(0, Math.round(nowMs / 1000 - snap.publishTs)),
    stale: isOracleStale(ctx, snap, nowMs),
  };
}

export async function allOracles(ctx: AppContext): Promise<{ asset: AssetFeed; snap: OracleSnapshot | null }[]> {
  const feeds = listAssetFeeds();
  const raws = feeds.length ? await ctx.redis.mget(...feeds.map((f) => RK.oracle(f.feedIdHex))).catch(() => feeds.map(() => null)) : [];
  return feeds.map((asset, i) => {
    const raw = raws[i];
    let snap: OracleSnapshot | null = null;
    if (raw) {
      try {
        snap = JSON.parse(raw) as OracleSnapshot;
      } catch {
        snap = null;
      }
    }
    return { asset, snap };
  });
}
