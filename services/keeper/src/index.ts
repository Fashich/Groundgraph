import { createDb, runMigrations } from '@groundgraph/db';
import {
  createLogger,
  createRedis,
  createRegistry,
  HermesClient,
  listAssetFeeds,
  loadKeypair,
  OraclePriceService,
  PROGRAM_ID,
  PushFeedReader,
  RK,
  RpcChainReader,
  startMetricsServer,
  writeHeartbeat,
} from '@groundgraph/svc-core';
import { Connection, Keypair } from '@solana/web3.js';
import { Alerter } from './alerts';
import { loadConfig } from './config';
import { FairValueLoop } from './fairvalue';
import { housekeeping } from './housekeeping';
import { createKeeperMetrics } from './metrics';
import { OracleLoop } from './oracle';
import { DryRunPoster, RpcPoster, type Poster } from './poster';
import { runLoops, type Loop } from './run';
import { SettleLoop } from './settle';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger('keeper', cfg.LOG_LEVEL);
  const db = createDb(cfg.DATABASE_URL, { max: 6, applicationName: 'gg-keeper' });
  if (cfg.RUN_MIGRATIONS) await runMigrations(db.sql, { log: (m: string) => log.info(m) });
  const redis = createRedis(cfg.REDIS_URL, 'gg-keeper');
  const connection = new Connection(cfg.RPC_URL, { commitment: 'confirmed' });
  const registry = createRegistry('keeper');
  const metrics = createKeeperMetrics(registry);
  const alerter = new Alerter(
    {
      webhookUrl: cfg.ALERT_WEBHOOK_URL,
      webhookFormat: cfg.ALERT_WEBHOOK_FORMAT,
      telegramToken: cfg.ALERT_TELEGRAM_BOT_TOKEN,
      telegramChatId: cfg.ALERT_TELEGRAM_CHAT_ID,
      sentryDsn: cfg.SENTRY_DSN,
      dedupeSecs: cfg.ALERT_DEDUPE_SECS,
    },
    log,
  );

  // ---- keypair -------------------------------------------------------------------------------------------------
  let keypair: Keypair | null = null;
  if (cfg.KEEPER_KEYPAIR) keypair = loadKeypair(cfg.KEEPER_KEYPAIR);
  const canSend = keypair !== null && cfg.KEEPER_SEND_TRANSACTIONS;
  if (!keypair && cfg.KEEPER_SEND_TRANSACTIONS) {
    const msg = 'KEEPER_KEYPAIR is not set: the keeper runs READ-ONLY (oracle and fair values) and will NOT settle or void any market';
    if (cfg.NODE_ENV === 'production') throw new Error(msg);
    log.error(msg);
  }
  if (!cfg.KEEPER_SEND_TRANSACTIONS) log.warn('KEEPER_SEND_TRANSACTIONS=false: dry run, no settle or void transactions are sent');
  const poster: Poster = canSend
    ? new RpcPoster(connection, keypair!, { feeBase: cfg.KEEPER_PRIORITY_FEE_MICROLAMPORTS, feeMax: cfg.KEEPER_MAX_PRIORITY_FEE_MICROLAMPORTS, confirmTimeoutSecs: cfg.KEEPER_CONFIRM_TIMEOUT_SECS }, log)
    : new DryRunPoster((keypair ?? Keypair.generate()).publicKey, log);

  // ---- price sources: this is the documented, explicit settlement switch ----------------------------------------
  const hermes = cfg.PYTH_API_KEY ? new HermesClient({ baseUrl: cfg.PYTH_HERMES_URL, apiKey: cfg.PYTH_API_KEY }) : undefined;
  const push = new PushFeedReader(connection);
  const oracle = new OraclePriceService(push, hermes, (err) => log.warn({ err: (err as Error).message }, 'Hermes unavailable, using on-chain push feeds'));
  metrics.settlementMode.set({ mode: cfg.settlementMode }, 1);
  metrics.oracleSource.set({ source: oracle.primary }, 1);
  if (cfg.settlementMode === 'push-feed') {
    log.warn(
      { assets: [...cfg.pushAssets], setting: cfg.KEEPER_SETTLEMENT_ORACLE, hasApiKey: Boolean(cfg.PYTH_API_KEY) },
      'SETTLEMENT USES THE ON-CHAIN PUSH FEEDS (no PYTH_API_KEY): only ' +
        `${[...cfg.pushAssets].join(', ')} markets can be settled, other markets are voided after settle_ts + 1h and users are refunded at 0.5 USDC per share. ` +
        'Set PYTH_API_KEY (and leave KEEPER_SETTLEMENT_ORACLE=auto) to settle every allow-listed asset through Hermes.',
    );
  } else {
    log.info('settlement uses Hermes price updates posted through the Pyth receiver');
  }

  const chain = new RpcChainReader(connection, PROGRAM_ID, { marketTtlMs: 1000 });
  const now = () => Date.now();
  const oracleLoop = new OracleLoop({
    oracle,
    redis,
    sql: db.sql,
    log,
    metrics,
    alerter,
    staleSecs: cfg.ORACLE_STALE_SECS,
    now,
    watchedFeeds: async () => {
      const rows = await db.sql<{ feedId: string }[]>`SELECT DISTINCT feed_id FROM markets WHERE status = 'open'`;
      return new Set(rows.map((r) => r.feedId));
    },
  });
  const fair = new FairValueLoop({
    sql: db.sql,
    redis,
    log,
    metrics,
    now,
    snapshots: () => oracleLoop.latest,
    maxSpotAgeSecs: cfg.FAIR_VALUE_MAX_SPOT_AGE_SECS,
    pythApiKey: cfg.PYTH_API_KEY,
    benchmarksUrl: cfg.PYTH_BENCHMARKS_URL,
  });
  const settle = new SettleLoop({
    sql: db.sql,
    redis,
    chain,
    poster,
    push,
    hermes: cfg.settlementMode === 'hermes' ? hermes : undefined,
    mode: cfg.settlementMode,
    pushAssets: cfg.pushAssets,
    log,
    metrics,
    alerter,
    alertAfterAttempts: cfg.KEEPER_ALERT_AFTER_ATTEMPTS,
    now: () => new Date(),
  });

  const ac = new AbortController();
  let lastBeat = 0;
  const server = startMetricsServer(
    registry,
    cfg.KEEPER_METRICS_PORT,
    cfg.KEEPER_METRICS_HOST,
    () => {
      const age = oracleLoop.lastSuccessMs ? Date.now() - oracleLoop.lastSuccessMs : null;
      return {
        ok: age !== null && age < Math.max(30_000, cfg.KEEPER_ORACLE_INTERVAL_MS * 10),
        oracleSource: oracle.primary,
        settlementMode: cfg.settlementMode,
        canSend,
        oracleAgeMs: age,
        settled: settle.stats.settled,
        voided: settle.stats.voided,
        failed: settle.stats.failed,
      };
    },
    cfg.METRICS_TOKEN,
  );

  const loops: Loop[] = [
    { name: 'oracle', everyMs: () => cfg.KEEPER_ORACLE_INTERVAL_MS, run: () => oracleLoop.tick(), immediate: true },
    { name: 'fair-values', everyMs: () => cfg.KEEPER_FAIRVALUE_INTERVAL_SECS * 1000, run: () => fair.tick() },
    { name: 'volatility', everyMs: () => cfg.KEEPER_VOL_REFRESH_MINUTES * 60_000, run: () => fair.refreshAllVols(), immediate: true },
    ...(canSend
      ? [{ name: 'settle', everyMs: () => settle.nextDelayMs(cfg.KEEPER_SETTLE_INTERVAL_SECS * 1000), run: () => settle.runOnce() } satisfies Loop]
      : []),
    {
      name: 'housekeeping',
      everyMs: () => cfg.KEEPER_HOUSEKEEPING_INTERVAL_MINUTES * 60_000,
      immediate: true,
      run: () =>
        housekeeping({
          sql: db.sql,
          poster,
          log,
          metrics,
          alerter,
          now: () => new Date(),
          oracleRetentionDays: cfg.KEEPER_ORACLE_RETENTION_DAYS,
          fairValueRetentionDays: cfg.KEEPER_FAIRVALUE_RETENTION_DAYS,
          minLamports: cfg.minLamports,
          checkBalance: canSend,
        }),
    },
    {
      name: 'heartbeat',
      everyMs: () => 5000,
      immediate: true,
      run: async () => {
        lastBeat = Date.now();
        await writeHeartbeat(
          redis,
          RK.heartbeatKeeper,
          { service: 'keeper', ts: lastBeat, oracleSource: oracle.primary, settlementMode: cfg.settlementMode, canSend, lastOracleAt: oracleLoop.lastSuccessMs, settled: settle.stats.settled, voided: settle.stats.voided },
          30,
        );
      },
    },
  ];

  log.info(
    { program: PROGRAM_ID.toBase58(), cluster: cfg.SOLANA_CLUSTER, keeper: poster.payer.toBase58(), feeds: listAssetFeeds().map((f) => f.symbol), oracleSource: oracle.primary, settlementMode: cfg.settlementMode, canSend, alerts: alerter.enabled },
    'keeper starting',
  );
  if (!alerter.enabled) log.warn('no alert destination configured (ALERT_WEBHOOK_URL, ALERT_TELEGRAM_*): alerts are only written to the log');

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    log.info({ signal }, 'shutting down');
    ac.abort();
    setTimeout(() => process.exit(1), 20_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await runLoops(loops, log, metrics, ac.signal);
  server.close();
  redis.disconnect();
  await db.close();
  log.info('keeper stopped');
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('keeper failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
