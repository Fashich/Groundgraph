import { boolEnv, commonEnv, intEnv, optStr, parseEnv } from '@groundgraph/svc-core';
import { z } from 'zod';

export const indexerEnvShape = {
  ...commonEnv,
  /** Poll interval of the signature scanner. A Helius webhook nudge or a websocket log event triggers an earlier poll. */
  INDEXER_POLL_INTERVAL_MS: intEnv(2000, 250, 60_000),
  /** Signatures requested per getSignaturesForAddress page (RPC maximum is 1000). */
  INDEXER_BATCH_SIZE: intEnv(100, 10, 1000),
  /** Parallel getTransaction calls. Keep low on the public devnet RPC. */
  INDEXER_TX_CONCURRENCY: intEnv(4, 1, 32),
  /** Re-read open market accounts and fix up reserves, fee state and status. */
  INDEXER_RECONCILE_INTERVAL_SECS: intEnv(60, 5, 3600),
  /** Promote rows from confirmed to finalized, or remove rows whose transaction was dropped. */
  INDEXER_FINALIZE_INTERVAL_SECS: intEnv(20, 5, 3600),
  /** Seconds between market_ticks snapshots of open markets. */
  INDEXER_TICK_INTERVAL_SECS: intEnv(60, 10, 3600),
  /** On a fresh database, walk the full program history backwards in the background. */
  INDEXER_BACKFILL_ON_START: boolEnv(true),
  /** Open a websocket logsSubscribe to wake the poller early. Defaults to on when HELIUS_API_KEY or RPC_WS_URL is set. */
  INDEXER_WS_NUDGE: z.preprocess(
    (v) => (v === undefined || v === '' ? undefined : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase())),
    z.boolean().optional(),
  ),
  /** Rows older than this many slots below the finalized slot that are still unknown to the cluster are treated as dropped. */
  INDEXER_DROP_GRACE_SLOTS: intEnv(64, 0, 100_000),
  INDEXER_METRICS_HOST: z.string().default('0.0.0.0'),
  INDEXER_METRICS_PORT: intEnv(9102, 1, 65535),
  /** If set, GET /metrics on the indexer requires `Authorization: Bearer <token>` (same variable name as the API). */
  METRICS_TOKEN: optStr(),
  /** Default daily buy limit in whole USDC, used when the indexer creates a missing user_settings row. */
  DEFAULT_DAILY_LIMIT_USDC: intEnv(500, 0, 1_000_000),
};

export type IndexerConfig = ReturnType<typeof loadConfig>;

const PUBLIC_DEVNET_RPC = 'https://api.devnet.solana.com';

export function loadConfig(source: Record<string, string | undefined> = process.env) {
  const env = parseEnv(indexerEnvShape, source);
  const helius = env.HELIUS_API_KEY;
  const heliusHost = env.SOLANA_CLUSTER === 'mainnet-beta' ? 'mainnet.helius-rpc.com' : 'devnet.helius-rpc.com';
  // With a Helius key and the default public RPC, use the Helius endpoints (better rate limits, working logsSubscribe).
  const useHelius = Boolean(helius) && !source.RPC_URL;
  const rpcUrl = useHelius ? `https://${heliusHost}/?api-key=${helius}` : env.RPC_URL;
  const wsUrl = env.RPC_WS_URL ?? (helius ? `wss://${heliusHost}/?api-key=${helius}` : undefined);
  const wsNudge = env.INDEXER_WS_NUDGE ?? Boolean(helius || env.RPC_WS_URL);
  return {
    ...env,
    rpcUrl,
    wsUrl,
    wsNudge,
    /** Safe to log: never contains the API key. */
    rpcLabel: useHelius ? `helius-${env.SOLANA_CLUSTER}` : new URL(env.RPC_URL).host,
    usesPublicRpc: rpcUrl === PUBLIC_DEVNET_RPC,
    defaultDailyLimitBase: BigInt(env.DEFAULT_DAILY_LIMIT_USDC) * 1_000_000n,
  };
}
