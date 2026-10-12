import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from './client';

export const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');
const LOCK_KEY = 7_274_001; // advisory lock so api/indexer/keeper can all call this on boot safely

export interface MigrateOptions {
  dir?: string;
  log?: (msg: string) => void;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

/**
 * Apply packages/db/migrations/*.sql in lexical order, once each, inside a transaction.
 * Idempotent: applied files are recorded in schema_migrations. The SQL files are also written to be re-runnable
 * (IF NOT EXISTS) because scripts/dev-db.sh applies them without bookkeeping.
 */
export async function runMigrations(sql: Sql, opts: MigrateOptions = {}): Promise<MigrateResult> {
  const dir = opts.dir ?? MIGRATIONS_DIR;
  const log = opts.log ?? (() => {});
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
  });
  const files = readdirSync(dir)
    .filter((f) => /^\d+.*\.sql$/.test(f))
    .sort();
  const result: MigrateResult = { applied: [], skipped: [] };
  for (const file of files) {
    const body = readFileSync(join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(body).digest('hex');
    const ran = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
      const rows = await tx<{ checksum: string }[]>`SELECT checksum FROM schema_migrations WHERE name = ${file}`;
      const existing = rows[0];
      if (existing) {
        if (existing.checksum !== checksum) log(`migration ${file} changed since it was applied (checksum differs)`);
        return false;
      }
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (name, checksum) VALUES (${file}, ${checksum})`;
      return true;
    });
    if (ran) {
      result.applied.push(file);
      log(`applied migration ${file}`);
    } else {
      result.skipped.push(file);
    }
  }
  return result;
}
