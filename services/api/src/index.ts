import { createDb, purgeExpiredAuth, runMigrations } from '@groundgraph/db';
import { assertRealSdk, createLogger, createRedis, createRegistry, PROGRAM_ID, RpcChainReader } from '@groundgraph/svc-core';
import { Connection } from '@solana/web3.js';
import { buildApp } from './app';
import { loadConfig } from './config';
import type { AppContext } from './context';
import { createFaucetMinter } from './services/faucet';
import { DefaultVolProvider } from './services/vol';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger('api', cfg.LOG_LEVEL);
  if (cfg.NODE_ENV === 'production') assertRealSdk(cfg.NODE_ENV);

  const db = createDb(cfg.DATABASE_URL, { max: 10, applicationName: 'gg-api' });
  if (cfg.RUN_MIGRATIONS) {
    const applied = await runMigrations(db.sql, { log: (m: string) => log.info(m) });
    log.info({ applied }, 'migrations checked');
  }
  const redis = createRedis(cfg.REDIS_URL, 'gg-api');
  const connection = new Connection(cfg.RPC_URL, { commitment: 'confirmed', ...(cfg.RPC_WS_URL ? { wsEndpoint: cfg.RPC_WS_URL } : {}) });
  const chain = new RpcChainReader(connection, PROGRAM_ID, { defaultPriorityFee: cfg.DEFAULT_PRIORITY_FEE_MICROLAMPORTS, maxPriorityFee: cfg.MAX_PRIORITY_FEE_MICROLAMPORTS });
  const registry = createRegistry('api');
  const ctx: AppContext = {
    cfg,
    log,
    db,
    redis,
    chain,
    registry,
    faucet: await createFaucetMinter(cfg, connection, log),
    vol: new DefaultVolProvider(redis, cfg, log),
    now: () => new Date(),
  };

  const { app } = await buildApp(ctx);
  await app.listen({ host: cfg.API_HOST, port: cfg.API_PORT });
  log.info({ port: cfg.API_PORT, cluster: cfg.SOLANA_CLUSTER, program: PROGRAM_ID.toBase58(), demoMode: cfg.DEMO_MODE, faucet: ctx.faucet !== null }, 'api listening');

  const purge = setInterval(() => {
    purgeExpiredAuth(db.sql, new Date()).catch((err) => log.warn({ err: (err as Error).message }, 'auth purge failed'));
  }, 3600_000);
  purge.unref();

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    try {
      await app.close();
      redis.disconnect();
      await db.close();
    } catch (err) {
      log.error({ err: (err as Error).message }, 'error during shutdown');
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
