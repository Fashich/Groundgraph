import { createDb, runMigrations, type DbHandle } from '@groundgraph/db';
import { createLogger, createRedis, createRegistry, PROGRAM_ID, type Logger, type Redis } from '@groundgraph/svc-core';
import { Connection } from '@solana/web3.js';
import type { Registry } from 'prom-client';
import type { IndexerConfig } from './config';
import { Indexer } from './indexer';
import { createIndexerMetrics, type IndexerMetrics } from './metrics';
import { Publisher } from './publish';
import { RpcChainSource } from './source';

export interface Booted {
  cfg: IndexerConfig;
  log: Logger;
  db: DbHandle;
  redis: Redis;
  registry: Registry;
  metrics: IndexerMetrics;
  indexer: Indexer;
  connection: Connection;
}

/** Shared wiring of the long-running indexer and the backfill CLI. */
export async function boot(cfg: IndexerConfig, name = 'indexer'): Promise<Booted> {
  const log = createLogger(name, cfg.LOG_LEVEL);
  const db = createDb(cfg.DATABASE_URL, { max: 8, applicationName: `gg-${name}` });
  if (cfg.RUN_MIGRATIONS) {
    const res = await runMigrations(db.sql, { log: (m: string) => log.info(m) });
    if (res.applied.length > 0) log.info({ applied: res.applied }, 'migrations applied');
  }
  const redis = createRedis(cfg.REDIS_URL, `gg-${name}`);
  const connection = new Connection(cfg.rpcUrl, { commitment: 'confirmed' });
  const registry = createRegistry(name);
  const metrics = createIndexerMetrics(registry);
  const source = new RpcChainSource(connection, PROGRAM_ID, (m) => metrics.rpc.inc({ method: m }));
  const publisher = new Publisher(redis, log, (kind) => metrics.publishes.inc({ kind }));
  const indexer = new Indexer({
    sql: db.sql,
    source,
    redis,
    publisher,
    log,
    metrics,
    programId: PROGRAM_ID,
    opts: {
      batchSize: cfg.INDEXER_BATCH_SIZE,
      txConcurrency: cfg.INDEXER_TX_CONCURRENCY,
      backfillOnStart: cfg.INDEXER_BACKFILL_ON_START,
      defaultLimit: cfg.defaultDailyLimitBase,
      dropGraceSlots: cfg.INDEXER_DROP_GRACE_SLOTS,
    },
  });
  return { cfg, log, db, redis, registry, metrics, indexer, connection };
}
