import { Redis, type RedisOptions } from 'ioredis';

export type { Redis };

export function createRedis(url: string, name = 'groundgraph', extra: RedisOptions = {}): Redis {
  return new Redis(url, {
    connectionName: name,
    maxRetriesPerRequest: 3,
    enableAutoPipelining: true,
    retryStrategy: (times) => Math.min(times * 200, 3000),
    ...extra,
  });
}

/** Subscriber connections must not use request retries or auto pipelining. */
export function createSubscriber(url: string, name = 'groundgraph-sub'): Redis {
  return new Redis(url, {
    connectionName: name,
    maxRetriesPerRequest: null,
    retryStrategy: (times) => Math.min(times * 200, 3000),
  });
}

/** Redis keys written by the services. Documented in each service README. */
export const RK = {
  /** latest oracle reading per feed (JSON OracleSnapshot), written by the keeper, TTL 120s */
  oracle: (feedIdHex: string) => `oracle:${feedIdHex}`,
  /** 30 day realized volatility cache per feed (JSON VolSnapshot), written by the keeper */
  vol: (feedIdHex: string) => `vol:${feedIdHex}`,
  /** latest fair value per market (JSON), written by the keeper */
  fairValue: (marketId: string) => `fv:${marketId}`,
  heartbeatKeeper: 'hb:keeper',
  heartbeatIndexer: 'hb:indexer',
  /** pending (unconfirmed) buy reservations for responsible-trading limits: ZSET score=expiry ms, member="<usdc>:<nonce>" */
  pendingSpend: (wallet: string) => `rt:pending:${wallet}`,
  /** question text requested by the creator before the market exists (indexer reads it on MarketCreated) */
  pendingQuestion: (marketId: string) => `q:pending:${marketId}`,
  faucetWallet: (wallet: string, day: string) => `faucet:w:${wallet}:${day}`,
  faucetIp: (ip: string, day: string) => `faucet:ip:${ip}:${day}`,
  settleLock: (marketId: string) => `lock:settle:${marketId}`,
} as const;

/** Pub/sub channels. Payload is JSON `{ type: 'delta' | 'snapshot', data }`. API instances fan these out to WebSocket clients. */
export const CH = {
  prefix: 'gg:ch:',
  market: (id: string) => `gg:ch:market:${id}`,
  marketsSummary: 'gg:ch:markets:summary',
  radar: (id: string) => `gg:ch:radar:${id}`,
  oracle: (feedIdHex: string) => `gg:ch:oracle:${feedIdHex}`,
  me: (wallet: string) => `gg:ch:me:${wallet}`,
  /** tells the indexer to poll immediately (Helius webhook, API after a send) */
  indexerNudge: 'gg:indexer:nudge',
} as const;

export interface HeartbeatPayload {
  service: 'keeper' | 'indexer';
  ts: number; // unix ms
  [k: string]: unknown;
}

export async function writeHeartbeat(redis: Redis, key: string, payload: HeartbeatPayload, ttlSec = 60): Promise<void> {
  await redis.set(key, JSON.stringify(payload), 'EX', ttlSec);
}

export async function readHeartbeat(redis: Redis, key: string): Promise<HeartbeatPayload | null> {
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HeartbeatPayload;
  } catch {
    return null;
  }
}
