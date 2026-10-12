import { createDb, type DbHandle, type Sql } from '@groundgraph/db';
import { encodeMarket } from '@groundgraph/sdk';
import {
  assetBySymbol,
  CH,
  createLogger,
  createRedis,
  createRegistry,
  decodeMarket,
  normalizeMarket,
  type ChainConfig,
  type ChainMarket,
  type ChainReader,
  type PriceReading,
  type Redis,
} from '@groundgraph/svc-core';
import { Keypair, PublicKey, type VersionedTransaction } from '@solana/web3.js';
import { Alerter } from '../src/alerts';
import { createKeeperMetrics, type KeeperMetrics } from '../src/metrics';
import type { Poster } from '../src/poster';

export const TEST_DB_URL = 'postgres://groundgraph:groundgraph@127.0.0.1:5432/svc_keeper';
export const TEST_REDIS_URL = 'redis://127.0.0.1:6379/2';
export const SETTLE_TS = 1_800_000_000;
export const pk = () => Keypair.generate().publicKey;

export const silentLog = createLogger('keeper-test', 'silent');

export interface Harness {
  db: DbHandle;
  sql: Sql;
  redis: Redis;
  metrics: KeeperMetrics;
  published: { channel: string; message: { type: string; data: Record<string, unknown> } }[];
  stop(): Promise<void>;
}

export async function makeHarness(): Promise<Harness> {
  const db = createDb(TEST_DB_URL, { max: 4, applicationName: 'gg-keeper-test' });
  const redis = createRedis(TEST_REDIS_URL, 'gg-keeper-test');
  await db.sql`TRUNCATE markets, oracle_status, indexer_state RESTART IDENTITY CASCADE`;
  await redis.flushdb();
  const sub = createRedis(TEST_REDIS_URL, 'gg-keeper-test-sub', { maxRetriesPerRequest: null, enableAutoPipelining: false });
  const published: Harness['published'] = [];
  sub.on('pmessage', (_p, channel, message) => {
    try {
      published.push({ channel, message: JSON.parse(message) });
    } catch {
      published.push({ channel, message: { type: 'raw', data: { raw: message } } });
    }
  });
  await sub.psubscribe(`${CH.prefix}*`, 'gg:indexer:*');
  return {
    db,
    sql: db.sql,
    redis,
    metrics: createKeeperMetrics(createRegistry('keeper-test')),
    published,
    async stop() {
      sub.disconnect();
      redis.disconnect();
      await db.close();
    },
  };
}

export const memAlerter = (dedupeSecs = 900, now?: () => number) =>
  new Alerter({ dedupeSecs, ...(now ? { now } : {}), fetchImpl: (async () => new Response('ok')) as typeof fetch }, silentLog);

/** On-chain market fixture, decoded by the real SDK like the RPC reader would. */
export function chainMarket(o: { id?: string; symbol?: string; settleTs?: number; status?: 'open' | 'settled' | 'voided'; kind?: 'close' | 'touch'; targetUsd?: number } = {}): ChainMarket {
  const asset = assetBySymbol(o.symbol ?? 'SOL')!;
  const creator = pk();
  const account = {
    creator,
    nonce: 1,
    collateralMint: pk(),
    vault: pk(),
    aboveMint: pk(),
    belowMint: pk(),
    lpMint: pk(),
    kind: o.kind ?? ('close' as const),
    direction: 'none' as const,
    feedId: Uint8Array.from(Buffer.from(asset.feedIdHex, 'hex')),
    targetPrice: BigInt(Math.round((o.targetUsd ?? 250) * 1e8)),
    targetExpo: -8,
    openTs: BigInt((o.settleTs ?? SETTLE_TS) - 86_400),
    tradingEndTs: BigInt((o.settleTs ?? SETTLE_TS) - 3600),
    settleTs: BigInt(o.settleTs ?? SETTLE_TS),
    baseFeeBps: 100,
    dynamicFee: false,
    completeSets: 1_000_000_000n,
    reserveAbove: 3_000_000_000n,
    reserveBelow: 1_000_000_000n,
    feePool: 0n,
    emaImpactBps: 0,
    emaTs: 0n,
    status: o.status ?? ('open' as const),
    outcome: 'none' as const,
    settlePrice: 0n,
    settleExpo: 0,
    settlePublishTs: 0n,
    lpClaimRemaining: 0n,
    lpSupplyRemaining: 0n,
    bump: 255,
  };
  const id = o.id ?? pk().toBase58();
  return normalizeMarket(decodeMarket(encodeMarket(account as never)), id);
}

/** Insert the DB row the indexer would have written for a chain market fixture. */
export async function seedDbMarket(sql: Sql, m: ChainMarket, symbol = 'SOL', status: 'open' | 'settled' | 'voided' = 'open'): Promise<void> {
  const asset = assetBySymbol(symbol)!;
  await sql`INSERT INTO markets (id, creator, kind, asset_symbol, feed_id, target_price, target_expo, target_raw, open_ts, trading_end_ts, settle_ts,
      base_fee_bps, dynamic_fee, question, category, status, above_mint, below_mint, lp_mint, vault, reserve_above, reserve_below, complete_sets, fee_pool)
    VALUES (${m.id}, ${m.creator}, ${m.kind}, ${symbol}, ${asset.feedIdHex}, ${String(Number(m.targetPrice) / 1e8)}, ${m.targetExpo}, ${m.targetPrice.toString()},
      ${new Date(m.openTs * 1000)}, ${new Date(m.tradingEndTs * 1000)}, ${new Date(m.settleTs * 1000)}, 100, false, ${`${symbol} above or below?`}, 'Majors', ${status},
      ${m.aboveMint}, ${m.belowMint}, ${m.lpMint}, ${m.vault}, 3000000000, 1000000000, 1000000000, 0)`;
}

export class FakeChain implements ChainReader {
  markets = new Map<string, ChainMarket>();
  config: ChainConfig | null = {
    admin: pk().toBase58(),
    usdcMint: pk().toBase58(),
    maxFeeBps: 300,
    minLiquidity: 100_000_000n,
    minDurationSecs: 3600,
    maxDurationSecs: 90 * 86400,
    maxStalenessSecs: 60,
    maxConfBps: 50,
    tradingCloseSecs: 3600,
    paused: false,
  };
  async getMarket(id: string) {
    return this.markets.get(id) ?? null;
  }
  async getConfig() {
    return this.config;
  }
  async getFeed(): Promise<null> {
    return null;
  }
  async getLatestBlockhash() {
    return { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 };
  }
  async getTokenBalance(): Promise<bigint | null> {
    return null;
  }
  async simulate(_tx: VersionedTransaction) {
    return { err: null, logs: [] };
  }
  async getPriorityFee() {
    return 1000;
  }
  async getSlot() {
    return 1;
  }
}

export interface PosterCall {
  kind: 'settle-push' | 'settle-hermes' | 'void';
  market: string;
  attempt: number;
  priceUpdate?: string;
  updates?: string[];
}

export class FakePoster implements Poster {
  payer = pk();
  calls: PosterCall[] = [];
  /** errors thrown by the next calls, in order */
  failures: (Error | null)[] = [];
  balance = 5_000_000_000n;
  private next(): void {
    const f = this.failures.shift();
    if (f) throw f;
  }
  async settlePush(m: ChainMarket, priceUpdate: PublicKey, attempt: number) {
    this.calls.push({ kind: 'settle-push', market: m.id, attempt, priceUpdate: priceUpdate.toBase58() });
    this.next();
    return `sig-push-${this.calls.length}`;
  }
  async settleHermes(m: ChainMarket, updates: string[], attempt: number) {
    this.calls.push({ kind: 'settle-hermes', market: m.id, attempt, updates });
    this.next();
    return `sig-hermes-${this.calls.length}`;
  }
  async voidMarket(m: ChainMarket, attempt: number) {
    this.calls.push({ kind: 'void', market: m.id, attempt });
    this.next();
    return `sig-void-${this.calls.length}`;
  }
  async balanceLamports() {
    return this.balance;
  }
}

export function pushReading(symbol: string, o: Partial<PriceReading> = {}): PriceReading {
  const a = assetBySymbol(symbol)!;
  return {
    feedIdHex: a.feedIdHex,
    price: 251.25,
    conf: 0.05,
    expo: -8,
    rawPrice: 25_125_000_000n,
    rawConf: 5_000_000n,
    publishTs: SETTLE_TS + 2,
    source: 'push-feed',
    account: pk().toBase58(),
    verification: 'full',
    ...o,
  };
}

export const waitFor = async (fn: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
};
