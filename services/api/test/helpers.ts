import { createDb, type DbHandle, type Sql } from '@groundgraph/db';
import {
  createLogger,
  createRedis,
  createRegistry,
  decodeMarket,
  normalizeMarket,
  pda,
  RK,
  seedReserves,
  type ChainConfig,
  type ChainFeed,
  type ChainMarket,
  type ChainReader,
  type Redis,
  type SimulationResult,
  listAssetFeeds,
  assetBySymbol,
} from '@groundgraph/svc-core';
import { encodeMarket } from '@groundgraph/sdk';
import { Keypair, PublicKey, type VersionedTransaction } from '@solana/web3.js';
import type { FastifyInstance } from 'fastify';
import nacl from 'tweetnacl';
import { buildApp } from '../src/app';
import { buildSiwsMessage } from '../src/auth/siws';
import { loadConfig } from '../src/config';
import type { AppContext, FaucetMinter } from '../src/context';
import type { WsHub } from '../src/ws/hub';

export const TEST_DB_URL = 'postgres://groundgraph:groundgraph@127.0.0.1:5432/svc_api';
export const TEST_REDIS_URL = 'redis://127.0.0.1:6379/2';
export const USDC_MINT = Keypair.generate().publicKey.toBase58();

/** In-memory chain: the services read markets, config, feeds and balances through this instead of an RPC node. */
export class FakeChain implements ChainReader {
  markets = new Map<string, ChainMarket>();
  config: ChainConfig | null = {
    admin: Keypair.generate().publicKey.toBase58(),
    usdcMint: USDC_MINT,
    maxFeeBps: 300,
    minLiquidity: 100_000_000n,
    minDurationSecs: 3600,
    maxDurationSecs: 90 * 86400,
    maxStalenessSecs: 60,
    maxConfBps: 50,
    tradingCloseSecs: 3600,
    paused: false,
  };
  feeds = new Map<string, ChainFeed>();
  balances = new Map<string, bigint | null>();
  defaultBalance: bigint | null = 100_000_000_000n;
  simResult: SimulationResult = { err: null, logs: [] };
  simulated: VersionedTransaction[] = [];
  slot = 1_000_000;
  failReads = false;

  constructor() {
    for (const a of listAssetFeeds()) this.feeds.set(a.feedIdHex, { feedIdHex: a.feedIdHex, symbol: a.pair, expo: a.symbol === 'BONK' ? -10 : -8, enabled: true });
  }
  async getMarket(id: string) {
    if (this.failReads) throw new Error('rpc down');
    return this.markets.get(id) ?? null;
  }
  async getConfig() {
    return this.config;
  }
  async getFeed(feedIdHex: string) {
    return this.feeds.get(feedIdHex) ?? null;
  }
  async getLatestBlockhash() {
    return { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 123_456 };
  }
  async getTokenBalance(owner: string, mint: string) {
    return this.balances.has(`${owner}:${mint}`) ? this.balances.get(`${owner}:${mint}`)! : this.defaultBalance;
  }
  async simulate(tx: VersionedTransaction) {
    this.simulated.push(tx);
    return this.simResult;
  }
  async getPriorityFee() {
    return 5_000;
  }
  async getSlot() {
    return this.slot;
  }
}

export interface Harness {
  ctx: AppContext;
  app: FastifyInstance;
  hub: WsHub;
  chain: FakeChain;
  redis: Redis;
  db: DbHandle;
  sql: Sql;
  faucetCalls: { wallet: string; amount: bigint }[];
  nowMs: () => number;
  setNow: (ms: number) => void;
  advance: (ms: number) => void;
  close: () => Promise<void>;
}

export interface HarnessOpts {
  env?: Record<string, string>;
  faucet?: boolean;
  hubTimers?: { summaryMs?: number; radarPollMs?: number; heartbeatMs?: number };
}

const TABLES = [
  'markets', 'market_ticks', 'trades', 'positions', 'lp_positions', 'redemptions', 'merges', 'wallets', 'wallet_edges', 'wallet_features',
  'wallet_scores', 'graph_layout', 'market_radar', 'fair_values', 'oracle_status', 'track_record_runs', 'track_record_rows', 'auth_nonces',
  'sessions', 'tos_acceptances', 'user_settings', 'watchlist', 'tracked_wallets', 'flag_disputes', 'indexer_state', 'scored_positions', 'user_activity',
];

export async function makeHarness(opts: HarnessOpts = {}): Promise<Harness> {
  const cfg = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB_URL,
    REDIS_URL: TEST_REDIS_URL,
    SESSION_SECRET: 'test-secret-0123456789abcdef',
    WEB_ORIGIN: 'http://localhost:3000',
    PUBLIC_API_URL: 'http://localhost:8787',
    SIMULATE_TX: 'false',
    RATE_LIMIT_PER_MINUTE: '100000',
    USDC_MINT,
    TOS_VERSION: '2026-10-01',
    LOG_LEVEL: 'silent',
    RUN_MIGRATIONS: 'false',
    ...opts.env,
  });
  const db = createDb(TEST_DB_URL, { max: 4 });
  await db.sql.unsafe(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  const redis = createRedis(TEST_REDIS_URL, 'gg-test');
  await redis.flushdb();
  const chain = new FakeChain();
  let nowMs = Date.now();
  const faucetCalls: { wallet: string; amount: bigint }[] = [];
  const faucet: FaucetMinter | null = opts.faucet
    ? {
        async mint(wallet, amount) {
          faucetCalls.push({ wallet, amount });
          return `faucetsig${faucetCalls.length}`;
        },
      }
    : null;
  const ctx: AppContext = {
    cfg,
    log: createLogger('api-test', 'silent'),
    db,
    redis,
    chain,
    registry: createRegistry('api-test'),
    faucet,
    vol: { get: async (symbol, feedId) => ({ feedId, vol: 0.6, source: 'test', nCloses: 30, asOf: Date.now() }) },
    now: () => new Date(nowMs),
  };
  const { app, hub } = await buildApp(ctx, { hubTimers: opts.hubTimers });
  await app.ready();
  return {
    ctx,
    app,
    hub,
    chain,
    redis,
    db,
    sql: db.sql,
    faucetCalls,
    nowMs: () => nowMs,
    setNow: (ms) => (nowMs = ms),
    advance: (ms) => (nowMs += ms),
    close: async () => {
      await app.close();
      redis.disconnect();
      await db.close();
    },
  };
}

/* ------------------------------ auth helpers ------------------------------ */

export function cookieOf(res: { cookies: { name: string; value: string }[] }): string {
  const c = res.cookies.find((x) => x.name === 'gg_session');
  return c ? `${c.name}=${c.value}` : '';
}

export async function signMessage(h: Harness, kp: Keypair, mutate?: (m: string) => string) {
  const wallet = kp.publicKey.toBase58();
  const nres = await h.app.inject({ method: 'POST', url: '/auth/nonce', payload: { wallet } });
  const n = nres.json();
  let message = buildSiwsMessage({
    domain: n.domain, address: wallet, statement: n.statement, uri: n.uri, version: '1', chainId: n.chainId,
    nonce: n.nonce, issuedAt: n.issuedAt, expirationTime: n.expirationTime, resources: [],
  });
  if (mutate) message = mutate(message);
  const signature = Buffer.from(nacl.sign.detached(Buffer.from(message), kp.secretKey)).toString('base64');
  return { wallet, nonce: n, message, signedMessage: Buffer.from(message).toString('base64'), signature };
}

export async function signIn(h: Harness, kp: Keypair = Keypair.generate()) {
  const s = await signMessage(h, kp);
  const res = await h.app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: s.wallet, signedMessage: s.signedMessage, signature: s.signature, tosAccepted: true, walletName: 'Test' } });
  if (res.statusCode !== 200) throw new Error(`sign in failed: ${res.statusCode} ${res.body}`);
  return { kp, wallet: s.wallet, cookie: cookieOf(res), res };
}

export async function viewIn(h: Harness, address: string) {
  const res = await h.app.inject({ method: 'POST', url: '/auth/view', payload: { address } });
  return { cookie: cookieOf(res), res };
}

/* ------------------------------ market helpers ------------------------------ */

export interface MarketOpts {
  symbol?: string;
  targetUsd?: number;
  liquidity?: bigint;
  p0Bps?: number;
  tradingEndInSecs?: number;
  settleInSecs?: number;
  openAgoSecs?: number;
  baseFeeBps?: number;
  dynamicFee?: boolean;
  status?: 'open' | 'settled' | 'voided';
  outcome?: 'above' | 'below' | 'none';
  nonce?: bigint;
  question?: string;
  inDb?: boolean;
}

let nonceCounter = BigInt(Date.now());

/** Build a market with the real SDK account codec (so builders and decoders see production-shaped data), register it on the fake chain and in Postgres. */
export async function seedMarket(h: Harness, o: MarketOpts = {}): Promise<{ id: string; chain: ChainMarket; creator: string }> {
  const asset = assetBySymbol(o.symbol ?? 'SOL')!;
  const creator = Keypair.generate().publicKey;
  const nonce = o.nonce ?? ++nonceCounter;
  const market = pda.market(creator, nonce);
  const nowSec = Math.floor(h.nowMs() / 1000);
  const liq = o.liquidity ?? 1_000_000_000n;
  const seed = seedReserves(liq, o.p0Bps ?? 2100);
  const expo = asset.symbol === 'BONK' ? -10 : -8;
  const account = {
    creator,
    nonce,
    collateralMint: new PublicKey(USDC_MINT),
    vault: pda.vault(market),
    aboveMint: pda.aboveMint(market),
    belowMint: pda.belowMint(market),
    lpMint: pda.lpMint(market),
    kind: 'close' as const,
    direction: 'none' as const,
    feedId: Uint8Array.from(Buffer.from(asset.feedIdHex, 'hex')),
    targetPrice: BigInt(Math.round((o.targetUsd ?? 250) * 10 ** -expo)),
    targetExpo: expo,
    openTs: BigInt(nowSec - (o.openAgoSecs ?? 3600)),
    tradingEndTs: BigInt(nowSec + (o.tradingEndInSecs ?? 7200)),
    settleTs: BigInt(nowSec + (o.settleInSecs ?? 10800)),
    baseFeeBps: o.baseFeeBps ?? 100,
    dynamicFee: o.dynamicFee ?? false,
    completeSets: liq,
    reserveAbove: seed.reserveAbove,
    reserveBelow: seed.reserveBelow,
    feePool: 0n,
    emaImpactBps: 0,
    emaTs: BigInt(nowSec),
    status: o.status ?? ('open' as const),
    outcome: o.outcome ?? ('none' as const),
    settlePrice: 0n,
    settleExpo: 0,
    settlePublishTs: 0n,
    lpClaimRemaining: 0n,
    lpSupplyRemaining: 0n,
    bump: 255,
  };
  const decoded = decodeMarket(encodeMarket(account as never));
  const chain = normalizeMarket(decoded, market.toBase58());
  h.chain.markets.set(chain.id, chain);
  const question = o.question ?? `${asset.symbol} above or below $${o.targetUsd ?? 250} at the close?`;
  if (o.inDb !== false) {
    await h.sql`INSERT INTO markets (id, creator, kind, asset_symbol, feed_id, target_price, target_expo, target_raw, open_ts, trading_end_ts, settle_ts,
        base_fee_bps, dynamic_fee, question, category, status, outcome, above_mint, below_mint, lp_mint, vault, reserve_above, reserve_below,
        complete_sets, fee_pool, ema_impact_bps, ema_ts)
      VALUES (${chain.id}, ${creator.toBase58()}, 'close', ${asset.symbol}, ${asset.feedIdHex}, ${o.targetUsd ?? 250}, ${expo}, ${account.targetPrice.toString()},
        ${new Date(Number(account.openTs) * 1000)}, ${new Date(Number(account.tradingEndTs) * 1000)}, ${new Date(Number(account.settleTs) * 1000)},
        ${account.baseFeeBps}, ${account.dynamicFee}, ${question}, 'crypto', ${account.status}, ${account.outcome === 'none' ? null : account.outcome},
        ${chain.aboveMint}, ${chain.belowMint}, ${chain.lpMint}, ${chain.vault}, ${seed.reserveAbove.toString()}, ${seed.reserveBelow.toString()},
        ${liq.toString()}, 0, 0, ${nowSec})`;
  }
  return { id: chain.id, chain, creator: creator.toBase58() };
}

export async function setOracle(h: Harness, symbol: string, o: { price?: number; ageSec?: number; fetchedAgoMs?: number } = {}): Promise<void> {
  const a = assetBySymbol(symbol)!;
  const now = h.nowMs();
  await h.redis.set(
    RK.oracle(a.feedIdHex),
    JSON.stringify({
      feedId: a.feedIdHex, symbol: a.pair, price: o.price ?? 213.93, conf: 0.08, expo: -8,
      publishTs: Math.floor(now / 1000) - (o.ageSec ?? 1), fetchedAt: now - (o.fetchedAgoMs ?? 500), source: 'push-feed', stale: (o.ageSec ?? 1) > 60,
    }),
    'EX',
    120,
  );
}

export const b64tx = (s: string) => Buffer.from(s, 'base64');
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ scorer-output helpers ------------------------------ */

export interface WalletSeed {
  address?: string;
  score?: number;
  smart?: boolean;
  top?: boolean;
  source?: string;
  asOf?: Date;
  cluster?: number | null;
  clusterName?: string | null;
  sybil?: boolean;
  hidden?: boolean;
  pos?: [number, number, number] | null;
  features?: { whale: number; timing: number; hit: number; central: number; lead: number; n: number };
  modelVersion?: string;
}

export async function seedWallet(h: Harness, o: WalletSeed = {}): Promise<string> {
  const address = o.address ?? Keypair.generate().publicKey.toBase58();
  const source = o.source ?? 'onchain';
  const asOf = o.asOf ?? new Date(h.nowMs() - 3600_000);
  const score = o.score ?? 80;
  const f = o.features ?? { whale: 0.6, timing: 0.7, hit: 0.65, central: 0.8, lead: 42, n: 12 };
  await h.sql`INSERT INTO wallets (address, cluster_id, cluster_name, sybil_cluster_id, label_hidden, data_source)
    VALUES (${address}, ${o.cluster === undefined ? 1 : o.cluster}, ${o.clusterName === undefined ? 'Early whales' : o.clusterName}, ${o.sybil ? 7 : null}, ${o.hidden ?? false}, ${source})
    ON CONFLICT (address) DO UPDATE SET cluster_id = EXCLUDED.cluster_id, cluster_name = EXCLUDED.cluster_name, sybil_cluster_id = EXCLUDED.sybil_cluster_id, label_hidden = EXCLUDED.label_hidden`;
  await h.sql`INSERT INTO wallet_scores (address, as_of, score, smart, top, contributions, reasons, model_version, data_source)
    VALUES (${address}, ${asOf}, ${score}, ${o.smart ?? true}, ${o.top ?? false},
      ${h.sql.json({ whale_overlap: 20, entry_timing: 20, hit_rate: 15, centrality: 15, lead_time: score - 70 })}, ${h.sql.json(['Enters before large moves', 'High hit rate', 'Follows large wallets'])},
      ${o.modelVersion ?? 'gs-test-1'}, ${source})`;
  await h.sql`INSERT INTO wallet_features (address, as_of, whale_overlap, entry_timing, hit_rate, centrality, lead_time_min, n_markets)
    VALUES (${address}, ${asOf}, ${f.whale}, ${f.timing}, ${f.hit}, ${f.central}, ${f.lead}, ${f.n})`;
  if (o.pos !== null) {
    const p = o.pos ?? [Math.random(), Math.random(), Math.random()];
    await h.sql`INSERT INTO graph_layout (address, x, y, z, as_of, data_source) VALUES (${address}, ${p[0]}, ${p[1]}, ${p[2]}, ${asOf}, ${source})
      ON CONFLICT (address) DO NOTHING`;
  }
  return address;
}

export async function seedEdge(h: Harness, a: string, b: string, source = 'onchain'): Promise<void> {
  await h.sql`INSERT INTO wallet_edges (src, dst, mint, amount_usd, ts, tx_sig, data_source) VALUES (${a}, ${b}, 'SOL', 100, ${new Date(h.nowMs())}, ${'sig' + Math.random().toString(36).slice(2)}, ${source})`;
}

export async function seedScoredPosition(h: Harness, marketId: string, wallet: string, o: { side?: 'above' | 'below'; usdc?: bigint; entry?: number; source?: string; agoMin?: number } = {}): Promise<void> {
  await h.sql`INSERT INTO scored_positions (market_id, wallet, side, usdc, entry_price, ts, data_source)
    VALUES (${marketId}, ${wallet}, ${o.side ?? 'above'}, ${(o.usdc ?? 50_000_000n).toString()}, ${o.entry ?? 0.21}, ${new Date(h.nowMs() - (o.agoMin ?? 30) * 60_000)}, ${o.source ?? 'onchain'})`;
}

export async function seedRadar(h: Harness, marketId: string, o: { p?: number; ci?: number; n?: number; edge?: number; state?: 'ready' | 'building'; source?: string; agoSec?: number } = {}): Promise<void> {
  await h.sql`INSERT INTO market_radar (market_id, ts, p_above, p_above_raw, ci_pts, n_flagged, edge_cents, state, model_version, data_source)
    VALUES (${marketId}, ${new Date(h.nowMs() - (o.agoSec ?? 60) * 1000)}, ${o.p ?? 0.25}, ${o.p ?? 0.25}, ${o.ci ?? 12}, ${o.n ?? 6}, ${o.edge ?? 4}, ${o.state ?? 'ready'}, 'gs-test-1', ${o.source ?? 'onchain'})`;
}

export async function seedTrade(h: Harness, marketId: string, wallet: string, o: { side?: 'above' | 'below'; dir?: 'buy' | 'sell'; usdc?: bigint; shares?: bigint; priceAfter?: number; agoMin?: number; sig?: string } = {}): Promise<void> {
  await h.sql`INSERT INTO trades (market_id, wallet, side, direction, usdc, shares, fee_usdc, price_after, tx_sig, ix_index, slot, ts)
    VALUES (${marketId}, ${wallet}, ${o.side ?? 'above'}, ${o.dir ?? 'buy'}, ${(o.usdc ?? 10_000_000n).toString()}, ${(o.shares ?? 45_000_000n).toString()}, 100000, ${o.priceAfter ?? 0.22},
      ${o.sig ?? 'tx' + Math.random().toString(36).slice(2)}, 0, 100, ${new Date(h.nowMs() - (o.agoMin ?? 10) * 60_000)})`;
}

export async function seedTick(h: Harness, marketId: string, agoMin: number, price: number): Promise<void> {
  await h.sql`INSERT INTO market_ticks (market_id, ts, price_above, reserve_above, reserve_below, fee_bps) VALUES (${marketId}, ${new Date(h.nowMs() - agoMin * 60_000)}, ${price}, 1000, 300, 100)
    ON CONFLICT DO NOTHING`;
}
