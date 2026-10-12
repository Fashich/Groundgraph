import { z } from 'zod';

export const LIQ_MIN = 100;
export const LIQ_MAX = 100_000;
export const MIN_HOURS = 24;
export const MAX_HOURS = 180 * 24;

export interface CreateDraft {
  asset: string;
  cond: 'above' | 'below';
  target: string;
  date: string; // yyyy-mm-dd
  liq: string;
  fee: '0.5' | '1' | '2';
  seed: 'fair' | 'even';
  dyn: boolean;
}

/** Step 1: target price. Returns an error string or ''. */
export function validateTarget(target: number, spot: number | null): string {
  if (!(target > 0)) return 'Enter a target price';
  if (spot && Math.abs((target / spot - 1) * 100) < 1) return 'Target must be at least 1% away from spot';
  return '';
}

/** Step 2: resolution date and liquidity. `now` is injected for tests. */
export function validateTiming(dateStr: string, liq: number, now = Date.now()): string {
  const dt = new Date(`${dateStr}T23:59:00Z`);
  const ok = !Number.isNaN(dt.getTime());
  const hours = ok ? (dt.getTime() - now) / 36e5 : 0;
  if (!ok) return 'Pick a resolution date';
  if (hours < MIN_HOURS) return 'Resolution must be at least 24h away';
  if (hours > MAX_HOURS) return 'Maximum duration is 180 days';
  if (liq < LIQ_MIN) return 'Minimum liquidity is 100 USDC';
  if (liq > LIQ_MAX) return 'Maximum liquidity is 100,000 USDC';
  return '';
}

export const siteSettingsSchema = z.object({
  dailyLimitUsdc: z.string().regex(/^\d+$/).nullable(),
  sessionReminder: z.boolean(),
});

export const addressSchema = z.string().trim().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/);
