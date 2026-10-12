import { listUnsettledMarkets, type MarketRow, type Sql } from '@groundgraph/db';
import {
  assetBySymbol,
  computeVol,
  fairValueClose,
  fairValueTouch,
  HermesClient,
  listAssetFeeds,
  RK,
  SECONDS_PER_YEAR,
  type Logger,
  type OracleSnapshot,
  type Redis,
  type VolSnapshot,
} from '@groundgraph/svc-core';
import type { KeeperMetrics } from './metrics';

export interface FairValue {
  spot: number;
  vol: number;
  pAbove: number;
  ts: string;
}

/** Pure fair value of ABOVE for one market (digital option, zero drift). null when inputs are unusable. */
export function fairValueFor(
  m: Pick<MarketRow, 'kind' | 'direction' | 'targetPrice' | 'settleTs'>,
  spot: { price: number; publishTs: number },
  vol: number,
  nowMs: number,
  maxSpotAgeSecs: number,
): FairValue | null {
  if (!Number.isFinite(spot.price) || spot.price <= 0 || !(vol > 0)) return null;
  if (nowMs / 1000 - spot.publishTs > maxSpotAgeSecs) return null;
  const strike = Number(m.targetPrice);
  if (!(strike > 0)) return null;
  const years = Math.max(0, (m.settleTs.getTime() - nowMs) / 1000 / SECONDS_PER_YEAR);
  const p = m.kind === 'touch' ? fairValueTouch(spot.price, strike, vol, years, m.direction ?? 'up') : fairValueClose(spot.price, strike, vol, years);
  if (!Number.isFinite(p)) return null;
  return { spot: spot.price, vol, pAbove: Math.min(1, Math.max(0, p)), ts: new Date(nowMs).toISOString() };
}

export interface FairValueDeps {
  sql: Sql;
  redis: Redis;
  log: Logger;
  metrics: KeeperMetrics;
  now: () => number;
  /** latest oracle snapshots by feed id (in-process, falls back to Redis) */
  snapshots: () => Map<string, OracleSnapshot>;
  maxSpotAgeSecs: number;
  pythApiKey?: string | undefined;
  benchmarksUrl: string;
  fetchImpl?: typeof fetch;
}

const VOL_TTL_SECS = 7200;
/** assets whose volatility is always kept warm, even without an open market */
const ALWAYS_WARM = ['SOL', 'BTC', 'ETH'];

export class FairValueLoop {
  private volBackoff = new Map<string, number>();
  constructor(private d: FairValueDeps) {}

  private async spotFor(feedId: string): Promise<OracleSnapshot | null> {
    const mem = this.d.snapshots().get(feedId);
    if (mem) return mem;
    try {
      const raw = await this.d.redis.get(RK.oracle(feedId));
      return raw ? (JSON.parse(raw) as OracleSnapshot) : null;
    } catch {
      return null;
    }
  }

  async readVol(feedId: string): Promise<VolSnapshot | null> {
    try {
      const raw = await this.d.redis.get(RK.vol(feedId));
      return raw ? (JSON.parse(raw) as VolSnapshot) : null;
    } catch {
      return null;
    }
  }

  /** Fair value for every open market that has not reached settle_ts. Returns the number of markets written. */
  async tick(): Promise<number> {
    const nowMs = this.d.now();
    const markets = (await listUnsettledMarkets(this.d.sql)).filter((m) => m.settleTs.getTime() > nowMs);
    let written = 0;
    for (const m of markets) {
      const asset = assetBySymbol(m.assetSymbol);
      if (!asset) continue;
      const spot = await this.spotFor(asset.feedIdHex);
      if (!spot) continue;
      let vol = await this.readVol(asset.feedIdHex);
      if (!vol) vol = await this.refreshVol(asset.symbol, asset.feedIdHex);
      if (!vol) continue;
      const fv = fairValueFor(m, spot, vol.vol, nowMs, this.d.maxSpotAgeSecs);
      if (!fv) continue;
      const ts = new Date(Math.floor(nowMs / 1000) * 1000);
      await this.d.sql`INSERT INTO fair_values (market_id, ts, spot, vol_annual, p_above) VALUES (${m.id}, ${ts}, ${String(fv.spot)}, ${String(fv.vol)}, ${String(fv.pAbove)})
        ON CONFLICT (market_id, ts) DO NOTHING`;
      await this.d.redis.set(RK.fairValue(m.id), JSON.stringify(fv), 'EX', 300);
      this.d.metrics.fairValues.inc();
      written++;
    }
    return written;
  }

  /** Recompute realized volatility for one asset and cache it. Failures back off for a minute and keep the old value. */
  async refreshVol(symbol: string, feedId: string): Promise<VolSnapshot | null> {
    const nowMs = this.d.now();
    if ((this.volBackoff.get(feedId) ?? 0) > nowMs) return null;
    try {
      const benchmarks = this.d.pythApiKey
        ? new HermesClient({ baseUrl: this.d.benchmarksUrl, apiKey: this.d.pythApiKey, ...(this.d.fetchImpl ? { fetchImpl: this.d.fetchImpl } : {}) })
        : undefined;
      const snap = await computeVol(symbol, feedId, {
        nowSec: Math.floor(nowMs / 1000),
        ...(benchmarks ? { benchmarks } : {}),
        ...(this.d.fetchImpl ? { fetchImpl: this.d.fetchImpl } : {}),
      });
      await this.d.redis.set(RK.vol(feedId), JSON.stringify(snap), 'EX', VOL_TTL_SECS);
      this.d.log.info({ symbol, vol: Number(snap.vol.toFixed(4)), source: snap.source, closes: snap.nCloses }, 'volatility refreshed');
      return snap;
    } catch (err) {
      this.volBackoff.set(feedId, nowMs + 60_000);
      this.d.log.warn({ symbol, err: (err as Error).message }, 'volatility refresh failed');
      return null;
    }
  }

  /** Refresh volatility for assets with open markets plus the majors. */
  async refreshAllVols(): Promise<number> {
    const open = await listUnsettledMarkets(this.d.sql);
    const symbols = new Set([...ALWAYS_WARM, ...open.map((m) => m.assetSymbol.toUpperCase())]);
    let ok = 0;
    for (const f of listAssetFeeds()) {
      if (!symbols.has(f.symbol)) continue;
      this.volBackoff.delete(f.feedIdHex);
      if (await this.refreshVol(f.symbol, f.feedIdHex)) ok++;
    }
    return ok;
  }
}
