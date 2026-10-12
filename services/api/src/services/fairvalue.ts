import type { MarketRow } from '@groundgraph/db';
import { assetBySymbol, fairValueClose, fairValueTouch, RK, SECONDS_PER_YEAR } from '@groundgraph/svc-core';
import type { FairValueInfo } from '@groundgraph/sdk/api-types';
import type { AppContext } from '../context';
import { readOracle } from './oracle';

export interface FairValueInput {
  assetSymbol: string;
  strike: number;
  settleTsSec: number;
  kind: 'close' | 'touch';
  direction?: 'up' | 'down' | undefined;
}

/**
 * Fair value of ABOVE (digital option, zero drift) from the live oracle spot and the 30 day realized volatility.
 * Returns null when either input is unavailable (the UI then shows its empty state). Never invents a number.
 */
export async function computeFairValue(ctx: AppContext, input: FairValueInput): Promise<FairValueInfo | null> {
  const asset = assetBySymbol(input.assetSymbol);
  if (!asset) return null;
  const snap = await readOracle(ctx, asset.feedIdHex);
  const nowMs = ctx.now().getTime();
  if (!snap || nowMs / 1000 - snap.publishTs > ctx.cfg.FAIR_VALUE_MAX_SPOT_AGE_SECS) return null;
  const vol = await ctx.vol.get(asset.symbol, asset.feedIdHex);
  if (!vol) return null;
  const years = Math.max(0, (input.settleTsSec - nowMs / 1000) / SECONDS_PER_YEAR);
  const p =
    input.kind === 'touch'
      ? fairValueTouch(snap.price, input.strike, vol.vol, years, input.direction ?? 'up')
      : fairValueClose(snap.price, input.strike, vol.vol, years);
  if (!Number.isFinite(p)) return null;
  return { spot: snap.price, vol: vol.vol, pAbove: Math.min(1, Math.max(0, p)), ts: ctx.now().toISOString() };
}

/** Fair value of a listed market: keeper cache first, then the latest persisted row, then an on-demand computation. */
export async function fairValueForMarket(ctx: AppContext, m: MarketRow): Promise<FairValueInfo | null> {
  if (m.status !== 'open') return null;
  try {
    const cached = await ctx.redis.get(RK.fairValue(m.id));
    if (cached) {
      const j = JSON.parse(cached) as FairValueInfo;
      if (ctx.now().getTime() - Date.parse(j.ts) < 5 * 60_000) return j;
    }
  } catch {
    /* fall through */
  }
  const rows = await ctx.db.sql<{ ts: Date; spot: string; volAnnual: string; pAbove: string }[]>`
    SELECT ts, spot, vol_annual, p_above FROM fair_values WHERE market_id = ${m.id} ORDER BY ts DESC LIMIT 1`;
  const row = rows[0];
  if (row && ctx.now().getTime() - row.ts.getTime() < 5 * 60_000) {
    return { spot: Number(row.spot), vol: Number(row.volAnnual), pAbove: Number(row.pAbove), ts: row.ts.toISOString() };
  }
  return computeFairValue(ctx, {
    assetSymbol: m.assetSymbol,
    strike: Number(m.targetPrice),
    settleTsSec: Math.floor(m.settleTs.getTime() / 1000),
    kind: m.kind,
    direction: m.direction ?? undefined,
  });
}
