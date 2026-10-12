import { CH, createSubscriber, PROGRAM_ID, startMetricsServer } from '@groundgraph/svc-core';
import { boot } from './boot';
import { loadConfig } from './config';
import { startLogNudge, type LogNudge } from './helius';
import { acquireLeaderLock, runLoops } from './run';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const b = await boot(cfg);
  const { log, indexer, db, redis, registry } = b;
  log.info({ program: PROGRAM_ID.toBase58(), cluster: cfg.SOLANA_CLUSTER, rpc: cfg.rpcLabel, wsNudge: cfg.wsNudge, backfillOnStart: cfg.INDEXER_BACKFILL_ON_START }, 'indexer starting');
  if (cfg.usesPublicRpc) log.warn('using the public devnet RPC: expect rate limits; set RPC_URL or HELIUS_API_KEY for production load');

  const ac = new AbortController();
  const metricsServer = startMetricsServer(
    registry,
    cfg.INDEXER_METRICS_PORT,
    cfg.INDEXER_METRICS_HOST,
    () => {
      const staleMs = Date.now() - indexer.state.lastPollAt;
      const ok = indexer.state.lastPollAt > 0 && staleMs < Math.max(30_000, cfg.INDEXER_POLL_INTERVAL_MS * 10);
      return {
        ok,
        indexedSlot: indexer.state.indexedSlot,
        headSlot: indexer.state.headSlot,
        lagSlots: Math.max(0, indexer.state.headSlot - indexer.state.indexedSlot),
        lastPollAgeMs: indexer.state.lastPollAt ? staleMs : null,
        backfillDone: indexer.state.backfillDone,
        lastError: indexer.state.lastError,
      };
    },
    cfg.METRICS_TOKEN,
  );

  const sub = createSubscriber(cfg.REDIS_URL, 'gg-indexer-sub');
  sub.on('message', () => indexer.wakeup.wake());
  await sub.subscribe(CH.indexerNudge).catch((err) => log.warn({ err: (err as Error).message }, 'nudge subscription failed (polling continues)'));

  let nudge: LogNudge | null = null;
  if (cfg.wsNudge && cfg.wsUrl) {
    try {
      nudge = startLogNudge({ rpcUrl: cfg.rpcUrl, wsUrl: cfg.wsUrl, log, onLogs: () => indexer.wakeup.wake() });
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'websocket nudge could not start (polling continues)');
    }
  }

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    log.info({ signal }, 'shutting down');
    ac.abort();
    indexer.wakeup.wake();
    setTimeout(() => process.exit(1), 20_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const lock = await acquireLeaderLock(db.sql, log, ac.signal);
  if (lock) {
    log.info('leader lock acquired');
    await indexer.heartbeat().catch(() => undefined);
    await runLoops(
      indexer,
      {
        pollMs: cfg.INDEXER_POLL_INTERVAL_MS,
        reconcileMs: cfg.INDEXER_RECONCILE_INTERVAL_SECS * 1000,
        finalizeMs: cfg.INDEXER_FINALIZE_INTERVAL_SECS * 1000,
        tickMs: cfg.INDEXER_TICK_INTERVAL_SECS * 1000,
        heartbeatMs: 5000,
      },
      log,
      ac.signal,
    );
    await lock.release();
  }

  await nudge?.close();
  sub.disconnect();
  metricsServer.close();
  redis.disconnect();
  await db.close();
  log.info('indexer stopped');
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('indexer failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
