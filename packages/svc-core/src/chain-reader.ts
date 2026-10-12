import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey, type Connection, type VersionedTransaction } from '@solana/web3.js';
import { decodeConfig, decodeFeed, decodeMarket, normalizeConfig, normalizeMarket, pda, toHex, type ChainConfig, type ChainMarket, field, toBool, toNum } from './chain';

export interface ChainFeed {
  feedIdHex: string;
  symbol: string;
  expo: number;
  enabled: boolean;
}

export interface SimulationResult {
  err: unknown | null;
  logs: string[];
  unitsConsumed?: number;
}

/** The slice of the chain the API needs. Injected so tests can run without an RPC node. */
export interface ChainReader {
  getMarket(id: string): Promise<ChainMarket | null>;
  getConfig(): Promise<ChainConfig | null>;
  /** on-chain FeedAllowlist entry (null when the feed was never allow-listed) */
  getFeed(feedIdHex: string): Promise<ChainFeed | null>;
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  /** balance in base units of `owner`'s associated token account for `mint`; null when the account does not exist */
  getTokenBalance(owner: string, mint: string): Promise<bigint | null>;
  simulate(tx: VersionedTransaction): Promise<SimulationResult>;
  /** suggested priority fee in micro-lamports per compute unit */
  getPriorityFee(writable?: string[]): Promise<number>;
  getSlot(): Promise<number>;
}

interface Cached<T> {
  at: number;
  value: Promise<T>;
}

/** RPC-backed reader with tiny TTL caches so a burst of quotes costs one RPC call. */
export class RpcChainReader implements ChainReader {
  private markets = new Map<string, Cached<ChainMarket | null>>();
  private config?: Cached<ChainConfig | null>;
  private blockhash?: Cached<{ blockhash: string; lastValidBlockHeight: number }>;
  private fee?: Cached<number>;
  private slot?: Cached<number>;
  private feeds = new Map<string, { at: number; value: ChainFeed | null }>();

  constructor(
    private connection: Connection,
    private programId: PublicKey,
    private opts: { marketTtlMs?: number; defaultPriorityFee?: number; maxPriorityFee?: number } = {},
  ) {}

  private fresh<T>(c: Cached<T> | undefined, ttl: number): Promise<T> | null {
    return c && Date.now() - c.at < ttl ? c.value : null;
  }

  getMarket(id: string): Promise<ChainMarket | null> {
    const hit = this.fresh(this.markets.get(id), this.opts.marketTtlMs ?? 1000);
    if (hit) return hit;
    const value = (async () => {
      let pk: PublicKey;
      try {
        pk = new PublicKey(id);
      } catch {
        return null;
      }
      const info = await this.connection.getAccountInfo(pk, 'confirmed');
      if (!info || !info.owner.equals(this.programId)) return null;
      try {
        return normalizeMarket(decodeMarket(info.data), id);
      } catch {
        return null; // not a Market account
      }
    })();
    this.markets.set(id, { at: Date.now(), value });
    value.catch(() => this.markets.delete(id));
    if (this.markets.size > 500) this.markets.delete(this.markets.keys().next().value as string);
    return value;
  }

  getConfig(): Promise<ChainConfig | null> {
    const hit = this.fresh(this.config, 30_000);
    if (hit) return hit;
    const value = (async () => {
      const info = await this.connection.getAccountInfo(pda.config(), 'confirmed');
      if (!info) return null;
      return normalizeConfig(decodeConfig(info.data));
    })();
    this.config = { at: Date.now(), value };
    value.catch(() => (this.config = undefined));
    return value;
  }

  async getFeed(feedIdHex: string): Promise<ChainFeed | null> {
    const id = feedIdHex.replace(/^0x/, '').toLowerCase();
    const hit = this.feeds.get(id);
    if (hit && Date.now() - hit.at < 60_000) return hit.value;
    const info = await this.connection.getAccountInfo(pda.feed(Buffer.from(id, 'hex')), 'confirmed');
    let value: ChainFeed | null = null;
    if (info && info.owner.equals(this.programId)) {
      const raw = decodeFeed(info.data);
      value = { feedIdHex: toHex(field(raw, 'feedId')), symbol: String(field(raw, 'symbol') ?? ''), expo: toNum(field(raw, 'expo')), enabled: toBool(field(raw, 'enabled')) };
    }
    this.feeds.set(id, { at: Date.now(), value });
    return value;
  }

  getLatestBlockhash() {
    const hit = this.fresh(this.blockhash, 2000);
    if (hit) return hit;
    const value = this.connection.getLatestBlockhash('confirmed');
    this.blockhash = { at: Date.now(), value };
    value.catch(() => (this.blockhash = undefined));
    return value;
  }

  async getTokenBalance(owner: string, mint: string): Promise<bigint | null> {
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true);
    try {
      const bal = await this.connection.getTokenAccountBalance(ata, 'confirmed');
      return BigInt(bal.value.amount);
    } catch (err) {
      // a missing token account is a zero balance; any other failure (RPC down) must not look like an empty wallet
      if (/could not find account|account not found|invalid param/i.test((err as Error).message ?? '')) return null;
      throw err;
    }
  }

  async simulate(tx: VersionedTransaction): Promise<SimulationResult> {
    const res = await this.connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
    const out: SimulationResult = { err: res.value.err, logs: res.value.logs ?? [] };
    if (res.value.unitsConsumed !== undefined) out.unitsConsumed = res.value.unitsConsumed;
    return out;
  }

  getPriorityFee(writable: string[] = []): Promise<number> {
    const hit = this.fresh(this.fee, 10_000);
    if (hit) return hit;
    const def = this.opts.defaultPriorityFee ?? 5_000;
    const max = this.opts.maxPriorityFee ?? 200_000;
    const value = (async () => {
      try {
        const fees = await this.connection.getRecentPrioritizationFees({ lockedWritableAccounts: writable.map((w) => new PublicKey(w)) });
        const nonzero = fees.map((f) => f.prioritizationFee).filter((f) => f > 0).sort((a, b) => a - b);
        if (nonzero.length === 0) return def;
        const p75 = nonzero[Math.floor(nonzero.length * 0.75)] ?? def;
        return Math.min(max, Math.max(1_000, p75));
      } catch {
        return def;
      }
    })();
    this.fee = { at: Date.now(), value };
    return value;
  }

  getSlot(): Promise<number> {
    const hit = this.fresh(this.slot, 1500);
    if (hit) return hit;
    const value = this.connection.getSlot('confirmed');
    this.slot = { at: Date.now(), value };
    value.catch(() => (this.slot = undefined));
    return value;
  }
}
