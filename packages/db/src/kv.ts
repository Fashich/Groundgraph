import type { Sql } from './client';

/** indexer_state key/value helpers (checkpoints, heartbeats). */
export async function getState<T = unknown>(sql: Sql, key: string): Promise<T | null> {
  const rows = await sql<{ value: T }[]>`SELECT value FROM indexer_state WHERE key = ${key}`;
  return rows[0]?.value ?? null;
}

export async function setState(sql: Sql, key: string, value: unknown): Promise<void> {
  await sql`INSERT INTO indexer_state (key, value, updated_at) VALUES (${key}, ${sql.json(value as never)}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}
