import type { BuildCreateReq } from '@groundgraph/sdk/api-types';
import { toBase, fmtD, isoDate, tgtFmt, clamp, num } from './format';
import type { CreateDraft } from './validation';
import { roundOpen } from './math';

export const DAY = 86_400_000;

export function defaultDraft(asset = 'SOL', now = Date.now()): CreateDraft {
  return { asset, cond: 'above', target: '', date: isoDate(now + 30 * DAY), liq: '500', fee: '1', seed: 'fair', dyn: true };
}

/** Settlement instant: 23:59 UTC on the chosen date. */
export function settleIso(date: string): string {
  return `${date}T23:59:00.000Z`;
}

export function questionText(asset: string, target: number, date: string): string {
  const d = new Date(settleIso(date));
  const label = Number.isNaN(d.getTime()) ? '' : fmtD(d.getTime());
  return `${asset} above or below ${tgtFmt(target)} at the ${label} close?`;
}

export function ruleText(asset: string, target: number, date: string): string {
  const d = new Date(settleIso(date));
  const label = Number.isNaN(d.getTime()) ? '' : fmtD(d.getTime());
  return `Resolves ABOVE if the Pyth ${asset}/USD price at the ${label} 23:59 UTC close is strictly above ${tgtFmt(target)}. Otherwise it resolves BELOW. Each share settles at $1 or $0. If no valid price arrives within an hour of the close, the market is voided and every share redeems at $0.50.`;
}

export const feeBps = (fee: CreateDraft['fee']): 50 | 100 | 200 => (fee === '0.5' ? 50 : fee === '2' ? 200 : 100);

/** Opening ABOVE price used for hints: 50/50 or the model fair value rounded to whole cents. */
export function openingPrice(seed: CreateDraft['seed'], fair: number | null): number | null {
  if (seed === 'even') return 0.5;
  return fair == null ? null : roundOpen(fair);
}

/** Request body for POST /tx/create. With seed 'fair' p0Bps is omitted so the server seeds at the model fair value. */
export function buildCreateReq(d: CreateDraft, question: string): BuildCreateReq | null {
  const liquidityUsdc = toBase(d.liq);
  const target = num(d.target);
  if (!liquidityUsdc || !(target > 0)) return null;
  const req: BuildCreateReq = {
    assetSymbol: d.asset,
    kind: 'close',
    targetPrice: target,
    settleTs: settleIso(d.date),
    baseFeeBps: feeBps(d.fee),
    dynamicFee: d.dyn,
    liquidityUsdc,
    question,
  };
  if (d.seed === 'even') req.p0Bps = 5000;
  return req;
}

export interface Ladder {
  min: number;
  max: number;
  step: number;
  val: number;
  spotX: number;
  tgtX: number;
  zoneL: number;
  zoneW: number;
}

/** Positions (in percent of the ladder) of the spot tick, the target marker and the ABOVE zone. */
export function ladder(spot: number, target: number): Ladder {
  const t = target > 0 ? target : spot;
  const lo = Math.min(spot, t) * 0.8;
  const hi = Math.max(spot, t) * 1.25;
  const px = (v: number) => clamp(((v - lo) / (hi - lo)) * 100, 0, 100);
  const tX = px(t);
  return { min: lo, max: hi, step: (hi - lo) / 400, val: t, spotX: px(spot), tgtX: tX, zoneL: tX, zoneW: 100 - tX };
}

export const durationDate = (days: number, now = Date.now()) => isoDate(now + days * DAY);
