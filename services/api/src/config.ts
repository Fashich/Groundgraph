import { boolEnv, commonEnv, intEnv, optStr, parseEnv } from '@groundgraph/svc-core';
import { z } from 'zod';

const DEFAULT_SECRET = 'change-me-to-a-long-random-string';

export const apiEnvShape = {
  ...commonEnv,
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: intEnv(8787, 1, 65535),
  /** Browser origin of the web app. CORS (with credentials) and the CSRF origin check are pinned to it. */
  WEB_ORIGIN: z.url().default('http://localhost:3000'),
  /** Public base URL of this API as seen by wallets and link unfurlers (Blink hrefs, OG image URLs). */
  PUBLIC_API_URL: z.url().default('http://localhost:8787'),
  SESSION_SECRET: z.string().min(16).default(DEFAULT_SECRET),
  SESSION_TTL_HOURS: intEnv(168, 1, 24 * 90),
  COOKIE_NAME: z.string().default('gg_session'),
  /** SameSite=Strict instead of Lax */
  COOKIE_STRICT: boolEnv(false),
  /** Secure cookie flag (required for HTTPS deployments) */
  COOKIE_SECURE: boolEnv(false),
  TRUST_PROXY: boolEnv(false),
  BLOCKED_COUNTRIES: z.string().default('US'),
  DEFAULT_DAILY_LIMIT_USDC: intEnv(500, 0, 1_000_000),
  ORACLE_STALE_SECS: intEnv(60, 5, 3600),
  SIMULATE_TX: boolEnv(true),
  MAX_PRIORITY_FEE_MICROLAMPORTS: intEnv(200_000, 0, 50_000_000),
  DEFAULT_PRIORITY_FEE_MICROLAMPORTS: intEnv(5_000, 0, 50_000_000),
  FAUCET_KEYPAIR: optStr(),
  FAUCET_AMOUNT_USDC: intEnv(1000, 1, 100_000),
  FAUCET_MAX_PER_WALLET_PER_DAY: intEnv(3, 1, 1000),
  FAUCET_MAX_PER_IP_PER_DAY: intEnv(6, 1, 10_000),
  RATE_LIMIT_PER_MINUTE: intEnv(600, 10, 100_000),
  /** If set, GET /metrics requires `Authorization: Bearer <token>` */
  METRICS_TOKEN: optStr(),
  WS_MAX_CONNECTIONS_PER_IP: intEnv(30, 1, 10_000),
  WS_MAX_BUFFER_BYTES: intEnv(1_048_576, 1024, 64 * 1_048_576),
  /** max age of the oracle spot accepted for /fair-value (seconds) */
  FAIR_VALUE_MAX_SPOT_AGE_SECS: intEnv(900, 5, 86_400),
};

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(source: Record<string, string | undefined> = process.env) {
  const env = parseEnv(apiEnvShape, source);
  if (env.NODE_ENV === 'production' && env.SESSION_SECRET === DEFAULT_SECRET) {
    throw new Error('SESSION_SECRET must be changed in production');
  }
  const web = new URL(env.WEB_ORIGIN);
  return {
    ...env,
    blockedCountries: new Set(
      env.BLOCKED_COUNTRIES.split(',')
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean),
    ),
    /** SIWS domain = host (with port) of the web origin */
    siwsDomain: web.host,
    siwsUri: web.origin,
    chainId: `solana:${env.SOLANA_CLUSTER === 'mainnet-beta' ? 'mainnet' : env.SOLANA_CLUSTER}`,
    defaultDailyLimitBase: BigInt(env.DEFAULT_DAILY_LIMIT_USDC) * 1_000_000n,
    faucetAmountBase: BigInt(env.FAUCET_AMOUNT_USDC) * 1_000_000n,
    isDevnet: env.SOLANA_CLUSTER === 'devnet',
  };
}
