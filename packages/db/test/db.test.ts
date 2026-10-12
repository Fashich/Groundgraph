import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, runMigrations, schema, TABLE_NAMES_FOR_TEST, type DbHandle } from '../src/index';

const URL = 'postgres://groundgraph:groundgraph@127.0.0.1:5432/svc_db';
let h: DbHandle;

beforeAll(() => {
  execFileSync('bash', [resolve(__dirname, '../../../scripts/dev-db.sh'), 'svc_db'], { stdio: 'pipe' });
  h = createDb(URL, { max: 2 });
});
afterAll(async () => {
  await h.close();
});

describe('migration runner', () => {
  it('applies every migration once and records it', async () => {
    const first = await runMigrations(h.sql);
    expect(first.applied).toEqual(['0001_init.sql', '0002_services.sql', '0002_services_indexer.sql']);
    const second = await runMigrations(h.sql);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(['0001_init.sql', '0002_services.sql', '0002_services_indexer.sql']);
    const rows = await h.sql`SELECT name FROM schema_migrations ORDER BY name`;
    expect(rows.map((r) => r.name)).toEqual(['0001_init.sql', '0002_services.sql', '0002_services_indexer.sql']);
  });

  it('is safe under concurrent callers', async () => {
    await h.sql`DROP TABLE schema_migrations`;
    const results = await Promise.all([runMigrations(h.sql), runMigrations(h.sql), runMigrations(h.sql)]);
    const appliedTotal = results.reduce((n, r) => n + r.applied.length, 0);
    expect(appliedTotal).toBe(3);
  });
});

describe('drizzle schema mirrors the SQL migrations', () => {
  it('has exactly the same columns as the database for every table', async () => {
    const tables = Object.values(schema).filter((v) => v && typeof v === 'object' && Symbol.for('drizzle:Name') in (v as object));
    expect(tables.length).toBe(TABLE_NAMES_FOR_TEST.length);
    for (const t of tables) {
      const cfg = getTableConfig(t as never);
      const rows = await h.sql<{ columnName: string; isNullable: string }[]>`SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${cfg.name}`;
      const dbCols = new Map(rows.map((r) => [r.columnName, r.isNullable === 'NO']));
      const drizzleCols = new Map(cfg.columns.map((c) => [c.name, c.notNull]));
      expect([...drizzleCols.keys()].sort(), `columns of ${cfg.name}`).toEqual([...dbCols.keys()].sort());
      for (const [name, notNull] of drizzleCols) {
        expect(notNull, `${cfg.name}.${name} nullability`).toBe(dbCols.get(name));
      }
    }
  });

  it('covers every table in the database', async () => {
    const rows = await h.sql<{ tableName: string }[]>`SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations'`;
    expect(rows.map((r) => r.tableName).sort()).toEqual([...TABLE_NAMES_FOR_TEST].sort());
  });
});

describe('typed helpers', () => {
  it('nonces are single use and expire', async () => {
    const { insertNonce, consumeNonce } = await import('../src/index');
    const now = new Date();
    await insertNonce(h.sql, { nonce: 'n1', wallet: 'W1', issuedAt: now, expiresAt: new Date(now.getTime() + 300_000) });
    expect(await consumeNonce(h.sql, 'n1', 'OTHER', now)).toBe(false);
    expect(await consumeNonce(h.sql, 'n1', 'W1', now)).toBe(true);
    expect(await consumeNonce(h.sql, 'n1', 'W1', now)).toBe(false);
    await insertNonce(h.sql, { nonce: 'n2', wallet: 'W1', issuedAt: now, expiresAt: new Date(now.getTime() - 1) });
    expect(await consumeNonce(h.sql, 'n2', 'W1', now)).toBe(false);
  });

  it('settings: defaults, daily roll-over and break extension only', async () => {
    const { ensureSettings, addSpent, extendBreak } = await import('../src/index');
    const d1 = new Date('2026-10-12T10:00:00Z');
    const s = await ensureSettings(h.sql, 'W2', d1, 500_000_000n);
    expect(s.dailyLimitUsdc).toBe('500000000');
    await addSpent(h.sql, 'W2', '120000000', d1, 500_000_000n);
    await addSpent(h.sql, 'W2', '30000000', d1, 500_000_000n);
    expect((await ensureSettings(h.sql, 'W2', d1, 500_000_000n)).spentToday).toBe('150000000');
    const next = new Date('2026-10-13T00:00:01Z');
    expect((await ensureSettings(h.sql, 'W2', next, 500_000_000n)).spentToday).toBe('0');
    const until = new Date('2026-10-20T00:00:00Z');
    await extendBreak(h.sql, 'W2', until);
    const shorter = await extendBreak(h.sql, 'W2', new Date('2026-10-14T00:00:00Z'));
    expect(shorter.toISOString()).toBe(until.toISOString());
  });

  it('kv state round-trips JSON', async () => {
    const { setState, getState } = await import('../src/index');
    await setState(h.sql, 'k', { a: 1, b: ['x'] });
    expect(await getState(h.sql, 'k')).toEqual({ a: 1, b: ['x'] });
    expect(await getState(h.sql, 'missing')).toBeNull();
  });
});
