import { computeVol, HermesClient, RK, type VolSnapshot, type Redis, type Logger } from '@groundgraph/svc-core';
import type { AppConfig } from '../config';
import type { VolProvider } from '../context';

const CACHE_TTL_SECS = 30 * 60;
const FRESH_MS = 45 * 60_000;

/**
 * 30 day realized volatility. The keeper refreshes `vol:{feed}` every ~30 minutes; if that cache is empty (keeper down,
 * first boot) the API computes it on demand from public candles, single-flight per feed, and caches it the same way.
 */
export class DefaultVolProvider implements VolProvider {
  private inflight = new Map<string, Promise<VolSnapshot | null>>();
  private failedAt = new Map<string, number>();

  constructor(
    private redis: Redis,
    private cfg: Pick<AppConfig, 'PYTH_API_KEY' | 'PYTH_BENCHMARKS_URL'>,
    private log: Logger,
    private fetchImpl?: typeof fetch,
  ) {}

  async get(assetSymbol: string, feedIdHex: string): Promise<VolSnapshot | null> {
    try {
      const raw = await this.redis.get(RK.vol(feedIdHex));
      if (raw) {
        const v = JSON.parse(raw) as VolSnapshot;
        if (Date.now() - v.asOf < FRESH_MS) return v;
      }
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'vol cache read failed');
    }
    // after a failed on-demand attempt wait a minute before hitting the public APIs again
    if (Date.now() - (this.failedAt.get(feedIdHex) ?? 0) < 60_000) return null;
    let p = this.inflight.get(feedIdHex);
    if (!p) {
      p = this.compute(assetSymbol, feedIdHex).finally(() => this.inflight.delete(feedIdHex));
      this.inflight.set(feedIdHex, p);
    }
    return p;
  }

  private async compute(assetSymbol: string, feedIdHex: string): Promise<VolSnapshot | null> {
    try {
      const benchmarks = this.cfg.PYTH_API_KEY ? new HermesClient({ baseUrl: this.cfg.PYTH_BENCHMARKS_URL, apiKey: this.cfg.PYTH_API_KEY }) : undefined;
      const snap = await computeVol(assetSymbol, feedIdHex, { ...(benchmarks ? { benchmarks } : {}), ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}) });
      await this.redis.set(RK.vol(feedIdHex), JSON.stringify(snap), 'EX', CACHE_TTL_SECS).catch(() => undefined);
      return snap;
    } catch (err) {
      this.failedAt.set(feedIdHex, Date.now());
      this.log.warn({ err: (err as Error).message, assetSymbol }, 'on-demand volatility failed');
      return null;
    }
  }
}
