import type { Side } from './api-types';

export interface RadarInputs {
  pMarket: number;
  flagged: { positionUsd: number; side: Side; hitRate: number; sybil: boolean }[];
}

export interface RadarResult {
  state: 'ready' | 'building';
  p: number | null;
  ci: number | null;
  edge: number | null;
  n: number;
}

/**
 * Smart money radar probability.
 *   w_i = sqrt(position_usd_i) * (0.4 + hit_rate_i) * (sybil_i ? 0.5 : 1)
 *   s_y = sum w_i[side=ABOVE] / sum w_i;   hr = sum w_i hit_rate_i / sum w_i
 *   sig = (2 s_y - 1) (2 hr - 1)
 *   logit(p_radar) = logit(p_market) + 1.4 * n / (n + 6) * sig
 *   ci_pts = max(2, round(164 sqrt(p (1 - p) / (4n + 10))));  edge_cents = round(100 (p_radar - p_market))
 * Fewer than 3 flagged wallets gives the "building" state: nothing is shown as a number.
 */
export function radarProbability(inputs: RadarInputs): RadarResult {
  const n = inputs.flagged.length;
  const building: RadarResult = { state: 'building', p: null, ci: null, edge: null, n };
  if (n < 3) return building;
  let wSum = 0;
  let wAbove = 0;
  let hrSum = 0;
  for (const f of inputs.flagged) {
    const pos = Math.max(0, Number.isFinite(f.positionUsd) ? f.positionUsd : 0);
    const hit = Math.min(Math.max(f.hitRate, 0), 1);
    const w = Math.sqrt(pos) * (0.4 + hit) * (f.sybil ? 0.5 : 1);
    wSum += w;
    if (f.side === 'above') wAbove += w;
    hrSum += w * hit;
  }
  if (wSum <= 0) return building;
  const sy = wAbove / wSum;
  const hr = hrSum / wSum;
  const sig = (2 * sy - 1) * (2 * hr - 1);
  const pm = Math.min(Math.max(inputs.pMarket, 1e-6), 1 - 1e-6);
  const logit = Math.log(pm / (1 - pm)) + 1.4 * (n / (n + 6)) * sig;
  const p = 1 / (1 + Math.exp(-logit));
  const ci = Math.max(2, Math.round(164 * Math.sqrt((p * (1 - p)) / (4 * n + 10))));
  return { state: 'ready', p, ci, edge: Math.round(100 * (p - inputs.pMarket)), n };
}
