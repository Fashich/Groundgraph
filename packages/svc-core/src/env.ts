import { z } from 'zod';

/** "true" / "1" / "yes" / "on" (case-insensitive) are true; unset or anything else is false. */
export const boolEnv = (def = false) =>
  z.preprocess((v) => {
    if (v === undefined || v === '') return def;
    if (typeof v === 'boolean') return v;
    return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
  }, z.boolean());

const emptyToUndef = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
export const optStr = () => z.preprocess(emptyToUndef, z.string().optional());
export const optUrl = () => z.preprocess(emptyToUndef, z.url().optional());
export const intEnv = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.preprocess(
    (v) => (v === undefined || v === '' ? def : Number(v)),
    z.number().int().min(min).max(max),
  );

/** Variables every service understands. Names match the root .env.example. */
export const commonEnv = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SOLANA_CLUSTER: z.enum(['devnet', 'mainnet-beta', 'localnet', 'testnet']).default('devnet'),
  RPC_URL: z.url().default('https://api.devnet.solana.com'),
  RPC_WS_URL: optStr(),
  PROGRAM_ID: optStr(),
  USDC_MINT: optStr(),
  PYTH_HERMES_URL: z.url().default('https://hermes.pyth.network'),
  /** Hermes/Benchmarks require a Bearer key since the Pyth Core upgrade. Optional: without it the on-chain push feeds are used. */
  PYTH_API_KEY: optStr(),
  PYTH_BENCHMARKS_URL: z.url().default('https://benchmarks.pyth.network'),
  DATABASE_URL: z.string().min(1).default('postgres://groundgraph:groundgraph@localhost:5432/groundgraph'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  TOS_VERSION: z.string().min(1).default('2026-10-01'),
  DEMO_MODE: boolEnv(false),
  SENTRY_DSN: optStr(),
  HELIUS_API_KEY: optStr(),
  HELIUS_WEBHOOK_SECRET: optStr(),
  RUN_MIGRATIONS: boolEnv(true),
};

export function parseEnv<S extends z.ZodRawShape>(shape: S, source: Record<string, string | undefined> = process.env) {
  const schema = z.object(shape);
  const res = schema.safeParse(source);
  if (!res.success) {
    const lines = res.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return res.data as z.infer<typeof schema>;
}
