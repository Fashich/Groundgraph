import { addSpent, ensureSettings, extendBreak, recordUserActivity, type SettingsRow } from '@groundgraph/db';
import { RK } from '@groundgraph/svc-core';
import type { UserSettings } from '@groundgraph/sdk/api-types';
import { randomBytes } from 'node:crypto';
import type { AppContext } from '../context';
import { ApiHttpError } from '../errors';

const PENDING_TTL_MS = 120_000;

export async function loadSettings(ctx: AppContext, wallet: string): Promise<SettingsRow> {
  return ensureSettings(ctx.db.sql, wallet, ctx.now(), ctx.cfg.defaultDailyLimitBase);
}

export function toUserSettings(s: SettingsRow, now: Date): UserSettings {
  return {
    dailyLimitUsdc: s.dailyLimitUsdc === null ? null : BigInt(s.dailyLimitUsdc.split('.')[0]!).toString(),
    breakUntil: s.breakUntil && s.breakUntil.getTime() > now.getTime() ? s.breakUntil.toISOString() : null,
    sessionReminder: s.sessionReminder,
    spentToday: BigInt(s.spentToday.split('.')[0]!).toString(),
  };
}

/** Sum of buy reservations that were built but not yet seen by the indexer (expire after 2 minutes). */
export async function pendingSpend(ctx: AppContext, wallet: string): Promise<bigint> {
  const key = RK.pendingSpend(wallet);
  try {
    await ctx.redis.zremrangebyscore(key, '-inf', Date.now());
    const members = await ctx.redis.zrange(key, 0, -1);
    return members.reduce((sum, m) => sum + BigInt(m.split(':')[0]!), 0n);
  } catch (err) {
    ctx.log.warn({ err }, 'pending spend read failed');
    return 0n;
  }
}

export async function reserveSpend(ctx: AppContext, wallet: string, amount: bigint): Promise<void> {
  const key = RK.pendingSpend(wallet);
  try {
    await ctx.redis.zadd(key, Date.now() + PENDING_TTL_MS, `${amount}:${randomBytes(4).toString('hex')}`);
    await ctx.redis.expire(key, 300);
  } catch (err) {
    ctx.log.warn({ err }, 'pending spend reserve failed');
  }
}

export interface BuyGate {
  ok: boolean;
  code?: 'break_active' | 'daily_limit_exceeded';
  message?: string;
  details?: Record<string, unknown>;
  settings: SettingsRow;
}

/**
 * Responsible-trading gate for buys and market creation. Sells, merges and redeems NEVER call this.
 * Break: blocks outright. Daily limit: confirmed spend today + unconfirmed reservations + this amount must fit.
 */
export async function checkBuyGate(ctx: AppContext, wallet: string, amount: bigint): Promise<BuyGate> {
  const settings = await loadSettings(ctx, wallet);
  const now = ctx.now();
  if (settings.breakUntil && settings.breakUntil.getTime() > now.getTime()) {
    return {
      ok: false,
      code: 'break_active',
      message: `You are on a trading break until ${settings.breakUntil.toISOString()}. Selling, merging and redeeming stay available.`,
      details: { breakUntil: settings.breakUntil.toISOString() },
      settings,
    };
  }
  if (settings.dailyLimitUsdc !== null) {
    const limit = BigInt(settings.dailyLimitUsdc.split('.')[0]!);
    const spent = BigInt(settings.spentToday.split('.')[0]!) + (await pendingSpend(ctx, wallet));
    if (spent + amount > limit) {
      const remaining = limit > spent ? limit - spent : 0n;
      return {
        ok: false,
        code: 'daily_limit_exceeded',
        message: 'This would go over your daily limit. You can still sell, merge or redeem.',
        details: { limit: limit.toString(), spent: spent.toString(), remaining: remaining.toString() },
        settings,
      };
    }
  }
  return { ok: true, settings };
}

export function assertBuyGate(g: BuyGate): void {
  if (!g.ok) throw new ApiHttpError(g.code!, g.message!, g.details);
}

export async function setLimitAndReminder(ctx: AppContext, wallet: string, dailyLimit: string | null, sessionReminder: boolean) {
  const { updateLimitAndReminder } = await import('@groundgraph/db');
  const before = await loadSettings(ctx, wallet);
  await updateLimitAndReminder(ctx.db.sql, wallet, dailyLimit, sessionReminder);
  const beforeLimit = before.dailyLimitUsdc === null ? null : before.dailyLimitUsdc.split('.')[0];
  if (beforeLimit !== dailyLimit) {
    await recordUserActivity(ctx.db.sql, {
      wallet,
      type: 'limit',
      summary: dailyLimit === null ? 'Daily limit removed' : `Daily limit set to $${(Number(dailyLimit) / 1e6).toLocaleString('en-US')}`,
      ts: ctx.now(),
    });
  }
  return loadSettings(ctx, wallet);
}

export async function startBreak(ctx: AppContext, wallet: string, days: 1 | 7 | 30) {
  await loadSettings(ctx, wallet);
  const now = ctx.now();
  const proposed = new Date(now.getTime() + days * 86_400_000);
  const effective = await extendBreak(ctx.db.sql, wallet, proposed);
  await recordUserActivity(ctx.db.sql, {
    wallet,
    type: 'break',
    summary: `Trading break until ${effective.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    ts: now,
  });
  return loadSettings(ctx, wallet);
}

export { addSpent };
