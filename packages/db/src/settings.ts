import type { Sql } from './client';

export interface SettingsRow {
  wallet: string;
  dailyLimitUsdc: string | null;
  breakUntil: Date | null;
  sessionReminder: boolean;
  spentToday: string;
  day: string; // yyyy-mm-dd (UTC)
  locale: string;
}

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Load (creating on first access) the responsible-trading settings of a wallet.
 * A missing row means "defaults": a daily limit of `defaultLimit` base units. An explicit NULL limit means "no limit".
 * spent_today is rolled over lazily when the UTC day changes.
 */
export async function ensureSettings(sql: Sql, wallet: string, now: Date, defaultLimit: bigint): Promise<SettingsRow> {
  const day = utcDay(now);
  await sql`INSERT INTO user_settings (wallet, daily_limit_usdc, day) VALUES (${wallet}, ${defaultLimit.toString()}, ${day})
    ON CONFLICT (wallet) DO NOTHING`;
  const rows = await sql<SettingsRow[]>`UPDATE user_settings
    SET spent_today = CASE WHEN day::text = ${day} THEN spent_today ELSE 0 END,
        day = ${day}::date
    WHERE wallet = ${wallet}
    RETURNING wallet, daily_limit_usdc, break_until, session_reminder, spent_today, day::text AS day, locale`;
  return rows[0]!;
}

export async function updateLimitAndReminder(
  sql: Sql,
  wallet: string,
  dailyLimitUsdc: string | null,
  sessionReminder: boolean,
): Promise<void> {
  await sql`UPDATE user_settings SET daily_limit_usdc = ${dailyLimitUsdc}, session_reminder = ${sessionReminder}
    WHERE wallet = ${wallet}`;
}

/** A break can only be extended, never shortened. Returns the effective break_until. */
export async function extendBreak(sql: Sql, wallet: string, until: Date): Promise<Date> {
  const rows = await sql<{ breakUntil: Date }[]>`UPDATE user_settings
    SET break_until = GREATEST(COALESCE(break_until, ${until}), ${until})
    WHERE wallet = ${wallet} RETURNING break_until`;
  return rows[0]!.breakUntil;
}

/** Add confirmed buy volume to today's counter (rolls the day over atomically). */
export async function addSpent(sql: Sql, wallet: string, amount: string, now: Date, defaultLimit: bigint): Promise<void> {
  const day = utcDay(now);
  await sql`INSERT INTO user_settings (wallet, daily_limit_usdc, spent_today, day)
    VALUES (${wallet}, ${defaultLimit.toString()}, ${amount}, ${day})
    ON CONFLICT (wallet) DO UPDATE SET
      spent_today = CASE WHEN user_settings.day::text = ${day} THEN user_settings.spent_today + ${amount}::numeric ELSE ${amount}::numeric END,
      day = ${day}::date`;
}

export async function recordUserActivity(
  sql: Sql,
  a: { wallet: string; type: 'break' | 'limit'; summary: string; ts?: Date },
): Promise<void> {
  await sql`INSERT INTO user_activity (wallet, type, summary, ts) VALUES (${a.wallet}, ${a.type}, ${a.summary}, ${a.ts ?? new Date()})`;
}
