import { boolEnv, commonEnv, intEnv, optStr, parseEnv, optUrl } from '@groundgraph/svc-core';
import { z } from 'zod';

export const keeperEnvShape = {
  ...commonEnv,
  /** Path to a JSON keypair file, or the 64 byte JSON array inline. Pays fees for settle/void transactions only; holds no funds of users. */
  KEEPER_KEYPAIR: optStr(),
  /**
   * Price source used to settle markets.
   *   auto       Hermes (posted through the Pyth receiver) when PYTH_API_KEY is set, otherwise the on-chain push feeds
   *   hermes     Hermes only; the keeper refuses to start without PYTH_API_KEY
   *   push-feed  on-chain push feed accounts only, even if a key is configured. Limited to KEEPER_PUSH_FEED_ASSETS
   */
  KEEPER_SETTLEMENT_ORACLE: z.enum(['auto', 'hermes', 'push-feed']).default('auto'),
  /** Assets whose push feed accounts are fresh enough on devnet to settle with (comma separated symbols). */
  KEEPER_PUSH_FEED_ASSETS: z.string().default('SOL,ETH'),
  KEEPER_ORACLE_INTERVAL_MS: intEnv(2000, 500, 60_000),
  KEEPER_FAIRVALUE_INTERVAL_SECS: intEnv(60, 5, 3600),
  KEEPER_SETTLE_INTERVAL_SECS: intEnv(10, 2, 300),
  KEEPER_VOL_REFRESH_MINUTES: intEnv(30, 1, 1440),
  KEEPER_HOUSEKEEPING_INTERVAL_MINUTES: intEnv(60, 1, 1440),
  /** A reading older than this (seconds) is flagged stale. Same name as the API variable so both agree. */
  ORACLE_STALE_SECS: intEnv(60, 5, 3600),
  /** A spot reading older than this (seconds) is not used for fair values. Same name as the API variable. */
  FAIR_VALUE_MAX_SPOT_AGE_SECS: intEnv(900, 5, 86_400),
  /** Priority fee for keeper transactions (micro-lamports per compute unit); doubles on every retry up to the maximum. */
  KEEPER_PRIORITY_FEE_MICROLAMPORTS: intEnv(5_000, 0, 50_000_000),
  KEEPER_MAX_PRIORITY_FEE_MICROLAMPORTS: intEnv(200_000, 0, 50_000_000),
  /** Seconds to wait for a transaction to confirm before treating the attempt as failed. */
  KEEPER_CONFIRM_TIMEOUT_SECS: intEnv(45, 5, 300),
  /** Failed attempts on one market before an alert is raised. */
  KEEPER_ALERT_AFTER_ATTEMPTS: intEnv(3, 1, 100),
  /** Alert when the keeper wallet holds less than this many SOL. */
  KEEPER_MIN_SOL: z.preprocess((v) => (v === undefined || v === '' ? 0.2 : Number(v)), z.number().min(0).max(1000)),
  /** Rows older than this are pruned by housekeeping. */
  KEEPER_ORACLE_RETENTION_DAYS: intEnv(7, 1, 365),
  KEEPER_FAIRVALUE_RETENTION_DAYS: intEnv(14, 1, 365),
  KEEPER_METRICS_HOST: z.string().default('0.0.0.0'),
  KEEPER_METRICS_PORT: intEnv(9101, 1, 65535),
  METRICS_TOKEN: optStr(),
  /** Incoming webhook (Discord, Slack or any endpoint accepting JSON). Unset = alerts are only logged. */
  ALERT_WEBHOOK_URL: optUrl(),
  ALERT_WEBHOOK_FORMAT: z.enum(['auto', 'discord', 'slack', 'json']).default('auto'),
  ALERT_TELEGRAM_BOT_TOKEN: optStr(),
  ALERT_TELEGRAM_CHAT_ID: optStr(),
  /** The same alert key is sent at most once per this many seconds. */
  ALERT_DEDUPE_SECS: intEnv(900, 0, 86_400),
  /** Set to false to run a read-only keeper (oracle, fair values) that never sends transactions. */
  KEEPER_SEND_TRANSACTIONS: boolEnv(true),
};

export type KeeperConfig = ReturnType<typeof loadConfig>;

export function loadConfig(source: Record<string, string | undefined> = process.env) {
  const env = parseEnv(keeperEnvShape, source);
  const hasKey = Boolean(env.PYTH_API_KEY);
  if (env.KEEPER_SETTLEMENT_ORACLE === 'hermes' && !hasKey) {
    throw new Error('KEEPER_SETTLEMENT_ORACLE=hermes needs PYTH_API_KEY (Hermes rejects keyless requests)');
  }
  const mode: 'hermes' | 'push-feed' = env.KEEPER_SETTLEMENT_ORACLE === 'push-feed' ? 'push-feed' : hasKey ? 'hermes' : 'push-feed';
  const pushAssets = new Set(
    env.KEEPER_PUSH_FEED_ASSETS.split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );
  return {
    ...env,
    settlementMode: mode,
    pushAssets,
    minLamports: BigInt(Math.round(env.KEEPER_MIN_SOL * 1_000_000_000)),
  };
}
