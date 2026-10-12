import {
  decodeMarket,
  normalizeMarket,
  sleep,
  type ChainMarket,
} from '@groundgraph/svc-core';
import { type Connection, PublicKey } from '@solana/web3.js';

/** One entry of getSignaturesForAddress. */
export interface SigInfo {
  signature: string;
  slot: number;
  failed: boolean;
  blockTime: number | null;
}

export interface TxData {
  signature: string;
  slot: number;
  blockTime: number | null;
  failed: boolean;
  logs: string[];
}

export interface SigStatus {
  slot: number;
  failed: boolean;
  /** true once the cluster reports the transaction as finalized */
  finalized: boolean;
}

export interface MarketsRead {
  /** slot at which the accounts were read (RPC context slot) */
  slot: number;
  markets: Map<string, ChainMarket | null>;
}

/** Everything the indexer needs from the chain. Implemented over RPC here and by an in-memory ledger in tests. */
export interface ChainSource {
  /** current slot at the given commitment */
  getSlot(commitment: 'confirmed' | 'finalized'): Promise<number>;
  /** newest first, exclusive of `before` and `until`, at most `limit` entries (like getSignaturesForAddress) */
  getSignatures(o: { before?: string; until?: string; limit: number }): Promise<SigInfo[]>;
  /** null when the node does not (yet) have the transaction */
  getTransaction(signature: string): Promise<TxData | null>;
  /** null entries mean the cluster does not know the signature */
  getSignatureStatuses(signatures: string[]): Promise<(SigStatus | null)[]>;
  getMarkets(ids: string[]): Promise<MarketsRead>;
}

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function retry<T>(fn: () => Promise<T>, tries = 4, baseMs = 400): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const msg = (err as Error).message ?? '';
      // permanent request errors are not worth retrying
      if (/invalid param|not supported|too large|Invalid public key/i.test(msg)) throw err;
      await sleep(baseMs * 2 ** i);
    }
  }
  throw last;
}

export class RpcChainSource implements ChainSource {
  private programId: PublicKey;
  constructor(
    private connection: Connection,
    programId: PublicKey | string,
    private onRpc: (method: string) => void = () => {},
  ) {
    this.programId = typeof programId === 'string' ? new PublicKey(programId) : programId;
  }

  getSlot(commitment: 'confirmed' | 'finalized'): Promise<number> {
    this.onRpc('getSlot');
    return retry(() => this.connection.getSlot(commitment));
  }

  async getSignatures(o: { before?: string; until?: string; limit: number }): Promise<SigInfo[]> {
    this.onRpc('getSignaturesForAddress');
    const opts: { limit: number; before?: string; until?: string } = { limit: o.limit };
    if (o.before) opts.before = o.before;
    if (o.until) opts.until = o.until;
    const res = await retry(() => this.connection.getSignaturesForAddress(this.programId, opts, 'confirmed'));
    return res.map((s) => ({ signature: s.signature, slot: s.slot, failed: s.err !== null, blockTime: s.blockTime ?? null }));
  }

  async getTransaction(signature: string): Promise<TxData | null> {
    this.onRpc('getTransaction');
    const tx = await retry(() => this.connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }));
    if (!tx) return null;
    return {
      signature,
      slot: tx.slot,
      blockTime: tx.blockTime ?? null,
      failed: tx.meta?.err != null,
      logs: tx.meta?.logMessages ?? [],
    };
  }

  async getSignatureStatuses(signatures: string[]): Promise<(SigStatus | null)[]> {
    const out: (SigStatus | null)[] = [];
    for (let i = 0; i < signatures.length; i += 200) {
      this.onRpc('getSignatureStatuses');
      const chunk = signatures.slice(i, i + 200);
      const res = await retry(() => this.connection.getSignatureStatuses(chunk, { searchTransactionHistory: true }));
      for (const v of res.value) {
        out.push(v ? { slot: v.slot, failed: v.err !== null, finalized: v.confirmationStatus === 'finalized' } : null);
      }
    }
    return out;
  }

  async getMarkets(ids: string[]): Promise<MarketsRead> {
    const markets = new Map<string, ChainMarket | null>();
    let slot = 0;
    for (let i = 0; i < ids.length; i += 100) {
      this.onRpc('getMultipleAccounts');
      const chunk = ids.slice(i, i + 100);
      const res = await retry(() => this.connection.getMultipleAccountsInfoAndContext(chunk.map((id) => new PublicKey(id)), { commitment: 'confirmed' }));
      slot = Math.max(slot, res.context.slot);
      res.value.forEach((info, j) => {
        const id = chunk[j]!;
        if (!info || !info.owner.equals(this.programId)) return void markets.set(id, null);
        try {
          markets.set(id, normalizeMarket(decodeMarket(info.data), id));
        } catch {
          markets.set(id, null); // not a Market account
        }
      });
    }
    return { slot, markets };
  }
}
