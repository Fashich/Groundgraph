import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Sql = postgres.Sql<{ bigint: number }>;
export type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface DbHandle {
  /** postgres.js client: tagged-template queries. numeric stays a string, int8 becomes a number. Columns are camelCased. */
  sql: Sql;
  /** Drizzle instance. Backed by its OWN small pool because drizzle rewires the date serializers of the client it wraps. */
  readonly db: Db;
  close(): Promise<void>;
}

export interface CreateDbOptions {
  max?: number;
  idleTimeoutSec?: number;
  applicationName?: string;
}

function makeClient(url: string, opts: CreateDbOptions): Sql {
  return postgres(url, {
    max: opts.max ?? 10,
    idle_timeout: opts.idleTimeoutSec ?? 30,
    connect_timeout: 10,
    onnotice: () => {},
    connection: { application_name: opts.applicationName ?? 'groundgraph' },
    // snake_case columns come back camelCase in raw queries (JSON column contents are left untouched)
    transform: { column: { from: postgres.toCamel } },
    types: {
      bigint: {
        to: 20,
        from: [20],
        parse: (x: string) => Number(x),
        serialize: (x: number | bigint | string) => String(x),
      },
    },
  }) as unknown as Sql;
}

/**
 * Create a Postgres client. int8 values (slots, serial ids, unix seconds) are parsed to JS numbers (safe below 2^53),
 * numeric stays a string so money and share amounts never lose precision.
 */
export function createDb(url: string, opts: CreateDbOptions = {}): DbHandle {
  const sql = makeClient(url, opts);
  let drizzleClient: Sql | undefined;
  let db: Db | undefined;
  return {
    sql,
    get db() {
      if (!db) {
        drizzleClient = makeClient(url, { ...opts, max: Math.min(opts.max ?? 10, 3) });
        db = drizzle(drizzleClient as never, { schema });
      }
      return db;
    },
    close: async () => {
      await sql.end({ timeout: 5 });
      if (drizzleClient) await drizzleClient.end({ timeout: 5 });
    },
  };
}
