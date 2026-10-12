import { createDb, type DbHandle, type Sql } from '@groundgraph/db';
import { encodeMarket, encodeEventLogs, type GgEvent } from '@groundgraph/sdk';
import {
  assetBySymbol,
  CH,
  createLogger,
  createRedis,
  createRegistry,
  decodeMarket,
  normalizeMarket,
  pda,
  RK,
  seedReserves,
  type ChainMarket,
  type Redis,
} from '@groundgraph/svc-core';
import { Keypair, PublicKey } from '@solana/web3.js';
import { Indexer, type IndexerOptions } from '../src/indexer';
import { createIndexerMetrics } from '../src/metrics';
import { Publisher } from '../src/publish';
import type { ChainSource, MarketsRead, SigInfo, SigStatus, TxData } from '../src/source';

export const TEST_DB_URL = 'postgres://groundgraph:groundgraph@127.0.0.1:5432/svc_indexer';
export const TEST_REDIS_URL = 'redis://127.0.0.1:6379/2';

let sigCounter = 0;
export const newSig = () => `sig${(++sigCounter).toString().padStart(6, '0')}`;
export const pk = () => Keypair.generate().publicKey;

interface LedgerTx extends TxData {
  order: number;
}

/** In-memory cluster: a list of transactions plus market accounts. Implements the same interface as the RPC source. */
export class FakeLedger implements ChainSource {
  txs: LedgerTx[] = [];
  markets = new Map<string, ChainMarket>();
  headSlot = 1_000;
  finalizedSlot = 0;
  /** signatures the cluster has forgotten (dropped fork) */
  dropped = new Set<string>();
  /** signatures whose getTransaction returns null */
  unavailable = new Set<string>();
  /** signatures that are confirmed but not (yet) finalized */
  notFinalized = new Set<string>();
  calls = { getTransaction: 0, getSignatures: 0, getMarkets: 0 };
  private order = 0;
  private nowSec = 1_800_000_000;

  /** Append a transaction that emitted `events`; returns its signature. */
  add(events: GgEvent[], o: { slot?: number; failed?: boolean; blockTime?: number | null; signature?: string; programId?: PublicKey } = {}): string {
    const slot = o.slot ?? ++this.headSlot;
    this.headSlot = Math.max(this.headSlot, slot);
    const signature = o.signature ?? newSig();
    const blockTime = o.blockTime === undefined ? this.nowSec + this.order : o.blockTime;
    this.txs.push({
      signature,
      slot,
      blockTime,
      failed: o.failed ?? false,
      logs: events.length > 0 ? encodeEventLogs(events, o.programId) : ['Program 11111111111111111111111111111111 invoke [1]', 'Program 11111111111111111111111111111111 success'],
      order: this.order++,
    });
    return signature;
  }

  private visible(): LedgerTx[] {
    return this.txs.filter((t) => !this.dropped.has(t.signature)).sort((a, b) => b.slot - a.slot || b.order - a.order);
  }

  async getSlot(commitment: 'confirmed' | 'finalized'): Promise<number> {
    return commitment === 'finalized' ? this.finalizedSlot : this.headSlot;
  }

  async getSignatures(o: { before?: string; until?: string; limit: number }): Promise<SigInfo[]> {
    this.calls.getSignatures++;
    let list = this.visible();
    if (o.before) {
      const i = list.findIndex((t) => t.signature === o.before);
      if (i >= 0) list = list.slice(i + 1);
    }
    if (o.until) {
      const i = list.findIndex((t) => t.signature === o.until);
      if (i >= 0) list = list.slice(0, i);
    }
    return list.slice(0, o.limit).map((t) => ({ signature: t.signature, slot: t.slot, failed: t.failed, blockTime: t.blockTime }));
  }

  async getTransaction(signature: string): Promise<TxData | null> {
    this.calls.getTransaction++;
    if (this.unavailable.has(signature) || this.dropped.has(signature)) return null;
    const t = this.txs.find((x) => x.signature === signature);
    if (!t) return null;
    const { order: _o, ...rest } = t;
    return rest;
  }

  async getSignatureStatuses(signatures: string[]): Promise<(SigStatus | null)[]> {
    return signatures.map((s) => {
      const t = this.txs.find((x) => x.signature === s);
      if (!t || this.dropped.has(s)) return null;
      return { slot: t.slot, failed: t.failed, finalized: !this.notFinalized.has(s) && t.slot <= this.finalizedSlot };
    });
  }

  async getMarkets(ids: string[]): Promise<MarketsRead> {
    this.calls.getMarkets++;
    return { slot: this.headSlot, markets: new Map(ids.map((id) => [id, this.markets.get(id) ?? null])) };
  }
}

export interface MarketFixture {
  id: string;
  creator: string;
  feedIdHex: string;
  symbol: string;
  aboveMint: string;
  belowMint: string;
  lpMint: string;
  vault: string;
  liquidity: bigint;
  p0Bps: number;
  settleTs: number;
  tradingEndTs: number;
}

/** Plausible market parameters (any pubkey works as a market id for the indexer). */
export function marketFixture(o: Partial<MarketFixture> & { symbol?: string } = {}): MarketFixture {
  const symbol = o.symbol ?? 'SOL';
  const asset = assetBySymbol(symbol)!;
  return {
    id: pk().toBase58(),
    creator: pk().toBase58(),
    feedIdHex: asset.feedIdHex,
    symbol,
    aboveMint: pk().toBase58(),
    belowMint: pk().toBase58(),
    lpMint: pk().toBase58(),
    vault: pk().toBase58(),
    liquidity: 1_000_000_000n,
    p0Bps: 2100,
    settleTs: 1_800_100_000,
    tradingEndTs: 1_800_096_400,
    ...o,
  };
}

export const ev = {
  created(m: MarketFixture): GgEvent {
    return {
      name: 'MarketCreated',
      data: {
        market: new PublicKey(m.id),
        creator: new PublicKey(m.creator),
        feedId: Uint8Array.from(Buffer.from(m.feedIdHex, 'hex')),
        targetPrice: 25_000_000_000n,
        targetExpo: -8,
        kind: 'close',
        settleTs: BigInt(m.settleTs),
        tradingEndTs: BigInt(m.tradingEndTs),
        baseFeeBps: 100,
        dynamicFee: false,
        liquidity: m.liquidity,
        p0Bps: m.p0Bps,
        aboveMint: new PublicKey(m.aboveMint),
        belowMint: new PublicKey(m.belowMint),
        lpMint: new PublicKey(m.lpMint),
        vault: new PublicKey(m.vault),
      },
    } as GgEvent;
  },
  trade(m: MarketFixture, t: { wallet: string; side: 'above' | 'below'; buy: boolean; usdc: bigint; shares: bigint; fee?: bigint; priceAfterBps?: number; ra?: bigint; rb?: bigint; ts?: number }): GgEvent {
    return {
      name: 'Trade',
      data: {
        market: new PublicKey(m.id),
        wallet: new PublicKey(t.wallet),
        side: t.side,
        isBuy: t.buy,
        usdc: t.usdc,
        shares: t.shares,
        feeUsdc: t.fee ?? 0n,
        feeBps: 100,
        priceAfterBps: t.priceAfterBps ?? 2500,
        reserveAbove: t.ra ?? 3_000_000_000n,
        reserveBelow: t.rb ?? 1_000_000_000n,
        ts: BigInt(t.ts ?? 1_800_000_100),
      },
    } as GgEvent;
  },
  settled(m: MarketFixture, outcome: 'above' | 'below' = 'above'): GgEvent {
    return { name: 'Settled', data: { market: new PublicKey(m.id), outcome, price: 25_500_000_000n, expo: -8, publishTs: BigInt(m.settleTs + 5), lpClaim: 400_000_000n } } as GgEvent;
  },
  voided(m: MarketFixture): GgEvent {
    return { name: 'Voided', data: { market: new PublicKey(m.id), lpClaim: 500_000_000n } } as GgEvent;
  },
  redeemed(m: MarketFixture, wallet: string, side: 'above' | 'below', shares: bigint, usdc: bigint): GgEvent {
    return { name: 'Redeemed', data: { market: new PublicKey(m.id), wallet: new PublicKey(wallet), side, shares, usdc } } as GgEvent;
  },
  merged(m: MarketFixture, wallet: string, amount: bigint): GgEvent {
    return { name: 'Merged', data: { market: new PublicKey(m.id), wallet: new PublicKey(wallet), amount } } as GgEvent;
  },
  liquidity(m: MarketFixture, wallet: string, lpAmount: bigint, usdc: bigint, isAdd = false): GgEvent {
    return { name: 'LiquidityChanged', data: { market: new PublicKey(m.id), wallet: new PublicKey(wallet), lpAmount, usdc, isAdd } } as GgEvent;
  },
};

/** The on-chain account for a fixture, as the RPC source would return it. */
export function chainMarket(m: MarketFixture, o: { ra?: bigint; rb?: bigint; sets?: bigint; status?: 'open' | 'settled' | 'voided'; outcome?: 'none' | 'above' | 'below'; feePool?: bigint; lpClaim?: bigint } = {}): ChainMarket {
  const seed = seedReserves(m.liquidity, m.p0Bps);
  const account = {
    creator: new PublicKey(m.creator),
    nonce: 1,
    collateralMint: pk(),
    vault: new PublicKey(m.vault),
    aboveMint: new PublicKey(m.aboveMint),
    belowMint: new PublicKey(m.belowMint),
    lpMint: new PublicKey(m.lpMint),
    kind: 'close' as const,
    direction: 'none' as const,
    feedId: Uint8Array.from(Buffer.from(m.feedIdHex, 'hex')),
    targetPrice: 25_000_000_000n,
    targetExpo: -8,
    openTs: 1_800_000_000n,
    tradingEndTs: BigInt(m.tradingEndTs),
    settleTs: BigInt(m.settleTs),
    baseFeeBps: 100,
    dynamicFee: false,
    completeSets: o.sets ?? m.liquidity,
    reserveAbove: o.ra ?? seed.reserveAbove,
    reserveBelow: o.rb ?? seed.reserveBelow,
    feePool: o.feePool ?? 0n,
    emaImpactBps: 7,
    emaTs: 1_800_000_050n,
    status: o.status ?? ('open' as const),
    outcome: o.outcome ?? ('none' as const),
    settlePrice: o.status === 'settled' ? 25_500_000_000n : 0n,
    settleExpo: o.status === 'settled' ? -8 : 0,
    settlePublishTs: o.status === 'settled' ? BigInt(m.settleTs + 5) : 0n,
    lpClaimRemaining: o.lpClaim ?? 0n,
    lpSupplyRemaining: m.liquidity,
    bump: 255,
  };
  return normalizeMarket(decodeMarket(encodeMarket(account as never)), m.id);
}

export interface Harness {
  ledger: FakeLedger;
  db: DbHandle;
  sql: Sql;
  redis: Redis;
  indexer: Indexer;
  published: { channel: string; message: { type: string; data: Record<string, unknown> } }[];
  stop(): Promise<void>;
  /** a fresh Indexer on the same database (simulates a process restart) */
  restart(o?: Partial<IndexerOptions>): Indexer;
  nowMs: number;
}

const OPTS: IndexerOptions = { batchSize: 100, txConcurrency: 2, backfillOnStart: true, defaultLimit: 500_000_000n, dropGraceSlots: 0 };

export async function makeHarness(o: { opts?: Partial<IndexerOptions>; keepData?: boolean; ledger?: FakeLedger; now?: Date } = {}): Promise<Harness> {
  const db = createDb(TEST_DB_URL, { max: 4, applicationName: 'gg-indexer-test' });
  const redis = createRedis(TEST_REDIS_URL, 'gg-indexer-test');
  if (!o.keepData) {
    await db.sql`TRUNCATE markets, indexer_state, user_settings, wallet_scores, wallets, user_activity RESTART IDENTITY CASCADE`;
    await redis.flushdb();
  }
  const sub = createRedis(TEST_REDIS_URL, 'gg-indexer-test-sub', { maxRetriesPerRequest: null, enableAutoPipelining: false });
  const published: Harness['published'] = [];
  sub.on('pmessage', (_p, channel, message) => published.push({ channel, message: JSON.parse(message) }));
  await sub.psubscribe(`${CH.prefix}*`);
  const ledger = o.ledger ?? new FakeLedger();
  const log = createLogger('indexer-test', 'silent');
  const registry = createRegistry('indexer-test');
  const metrics = createIndexerMetrics(registry);
  const nowMs = (o.now ?? new Date('2027-01-15T08:00:00Z')).getTime();
  const make = (extra: Partial<IndexerOptions> = {}) =>
    new Indexer({
      sql: db.sql,
      source: ledger,
      redis,
      publisher: new Publisher(redis, log),
      log,
      metrics,
      opts: { ...OPTS, ...o.opts, ...extra },
      now: () => new Date(nowMs),
    });
  const h: Harness = {
    ledger,
    db,
    sql: db.sql,
    redis,
    indexer: make(),
    published,
    nowMs,
    restart: (extra) => make(extra),
    async stop() {
      sub.disconnect();
      redis.disconnect();
      await db.close();
    },
  };
  return h;
}

export const waitFor = async (fn: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
};

export { pda, RK };
