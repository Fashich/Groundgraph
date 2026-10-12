import { getState, setState, type Sql } from '@groundgraph/db';
import { PROGRAM_ID, RK, sleep, writeHeartbeat, type Logger, type Redis } from '@groundgraph/svc-core';
import type { PublicKey } from '@solana/web3.js';
import { decodeTx, type DecodedTx } from './decode';
import type { IndexerMetrics } from './metrics';
import type { Publisher } from './publish';
import { mapLimit, type ChainSource, type SigInfo } from './source';
import {
  applyMarketAccount,
  applyTx,
  countUnfinalized,
  dropTransactions,
  flaggedWallets,
  holders,
  insertMarketFromChain,
  knownMarkets,
  listReconcileTargets,
  listUnfinalized,
  markFinalized,
  snapshotTicks,
  type ApplyResult,
} from './store';

export const CURSOR_KEY = 'indexer:cursor';
export const BACKFILL_KEY = 'indexer:backfill';
/** Signatures this far below the cursor slot are never re-read when the cursor signature itself has disappeared. */
const CURSOR_SLOT_MARGIN = 64;
/** A transaction the node still cannot return after this many seconds is skipped (logged and counted). */
const TX_GIVE_UP_SECS = 600;

export interface Cursor {
  signature: string;
  slot: number;
}

export interface BackfillState {
  /** continue below this signature (null/absent = start from the newest) */
  before: string | null;
  done: boolean;
  processed: number;
  updatedAt: string;
}

export interface IndexerOptions {
  batchSize: number;
  txConcurrency: number;
  backfillOnStart: boolean;
  defaultLimit: bigint;
  dropGraceSlots: number;
}

export interface IndexerDeps {
  sql: Sql;
  source: ChainSource;
  redis: Redis | null;
  publisher: Publisher;
  log: Logger;
  metrics: IndexerMetrics;
  opts: IndexerOptions;
  programId?: PublicKey;
  now?: () => Date;
}

export interface PollStats {
  scanned: number;
  processed: number;
  skipped: number;
  /** the batch stopped early; the cursor stays before the first unprocessed signature */
  stalled: boolean;
  headSlot: number;
}

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** Resolves early when woken (Helius webhook nudge, websocket log event). */
export class Wakeup {
  private resolve: (() => void) | null = null;
  private woken = false;
  wake(): void {
    this.woken = true;
    this.resolve?.();
  }
  async wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.woken) {
      this.woken = false;
      return;
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(done, ms);
      const onAbort = () => done();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.resolve = done;
      function done() {
        clearTimeout(t);
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }
    });
    this.resolve = null;
    this.woken = false;
  }
}

export class Indexer {
  readonly state = {
    indexedSlot: 0,
    headSlot: 0,
    lastPollAt: 0,
    lastError: null as string | null,
    backfillDone: false,
  };
  readonly wakeup = new Wakeup();
  private mutex = new Mutex();
  private missingCounts = new Map<string, number>();
  private programId: PublicKey;
  private now: () => Date;

  constructor(private d: IndexerDeps) {
    this.programId = d.programId ?? PROGRAM_ID;
    this.now = d.now ?? (() => new Date());
  }

  /* ------------------------------ one transaction ------------------------------ */

  /** Fetch with a few retries; the node may not have a just-confirmed transaction yet. */
  private async fetchTx(sig: SigInfo): Promise<DecodedTx | null | 'skip'> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const tx = await this.d.source.getTransaction(sig.signature);
      if (tx) return decodeTx(tx, this.programId, Math.floor(this.now().getTime() / 1000));
      await sleep(300 * (attempt + 1));
    }
    const age = sig.blockTime ? Math.floor(this.now().getTime() / 1000) - sig.blockTime : 0;
    if (age > TX_GIVE_UP_SECS) {
      this.d.log.error({ signature: sig.signature, ageSecs: age }, 'transaction unavailable from the RPC node, skipping it');
      this.d.metrics.txs.inc({ result: 'unavailable' });
      return 'skip';
    }
    return null;
  }

  /** Make sure every market referenced by the events exists in the database (bootstraps from the account if needed). */
  private async ensureMarkets(tx: DecodedTx): Promise<DecodedTx> {
    const created = new Set(tx.events.filter((e) => e.ev.name === 'MarketCreated').map((e) => (e.ev as { market: string }).market));
    const referenced = [...new Set(tx.events.map((e) => (e.ev as { market: string }).market))].filter((m) => !created.has(m));
    if (referenced.length === 0) return tx;
    const known = await knownMarkets(this.d.sql, referenced);
    const missing = referenced.filter((m) => !known.has(m));
    if (missing.length === 0) return tx;
    const read = await this.d.source.getMarkets(missing);
    const absent = new Set<string>();
    for (const id of missing) {
      const m = read.markets.get(id) ?? null;
      if (!m) {
        absent.add(id);
        continue;
      }
      const question = await this.d.publisher.question(id);
      await insertMarketFromChain(this.d.sql, m, question);
      this.d.log.info({ market: id }, 'market bootstrapped from its account (creation event not seen)');
    }
    if (absent.size === 0) return tx;
    this.d.metrics.orphan.inc(absent.size);
    this.d.log.warn({ markets: [...absent], signature: tx.signature }, 'skipping events of markets that do not exist');
    return { ...tx, events: tx.events.filter((e) => !absent.has((e.ev as { market: string }).market)) };
  }

  /** Decode, apply and publish one transaction. Idempotent. */
  async applyDecoded(decoded: DecodedTx): Promise<ApplyResult | null> {
    if (decoded.events.length === 0) return null;
    return this.mutex.run(async () => {
      const tx = await this.ensureMarkets(decoded);
      if (tx.events.length === 0) return null;
      const questions = new Map<string, string>();
      for (const { ev } of tx.events) {
        if (ev.name === 'MarketCreated') {
          const q = await this.d.publisher.question(ev.market);
          if (q) questions.set(ev.market, q);
        }
      }
      const res = await applyTx(this.d.sql, tx, { now: this.now(), defaultLimit: this.d.opts.defaultLimit, questions });
      for (const n of res.names) this.d.metrics.events.inc({ name: n });
      this.d.metrics.rows.inc({ kind: 'fresh' }, res.inserted);
      this.d.metrics.rows.inc({ kind: 'duplicate' }, res.duplicates);
      await this.dispatch(res);
      return res;
    });
  }

  private async dispatch(res: ApplyResult): Promise<void> {
    const pub = this.d.publisher;
    const tradeWallets = res.out.flatMap((o) => (o.channel === 'market' && o.data['trade'] ? [(o.data['trade'] as { wallet: string }).wallet] : []));
    let flagged = new Set<string>();
    if (tradeWallets.length > 0) flagged = await flaggedWallets(this.d.sql, tradeWallets).catch(() => new Set<string>());
    for (const o of res.out) {
      if (o.channel === 'market') {
        const trade = o.data['trade'] as { wallet: string; flagged: boolean } | undefined;
        if (trade && flagged.has(trade.wallet)) trade.flagged = true;
        await pub.market(o.marketId, o.data);
      } else if (o.channel === 'me') {
        await pub.me(o.wallet, o.data);
      } else {
        for (const w of await holders(this.d.sql, o.marketId).catch(() => [])) await pub.me(w, o.data);
      }
    }
    for (const r of res.reservations) await pub.consumeReservation(r.wallet, r.usdc);
    for (const id of res.consumedQuestions) await pub.consumeQuestion(id);
  }

  /* ------------------------------ signature batches ------------------------------ */

  /**
   * Process signatures (any order) oldest first. Stops at the first transaction that is not available yet so that the
   * caller can keep its cursor in front of it. Returns the signatures processed contiguously from the oldest.
   */
  async processSignatures(sigsNewestFirst: SigInfo[], onChunk?: (done: SigInfo) => Promise<void>): Promise<{ done: SigInfo[]; stalled: boolean; touched: Set<string> }> {
    const ordered = [...sigsNewestFirst].reverse();
    const done: SigInfo[] = [];
    const touched = new Set<string>();
    const chunkSize = Math.max(4, this.d.opts.txConcurrency * 2);
    for (let i = 0; i < ordered.length; i += chunkSize) {
      const chunk = ordered.slice(i, i + chunkSize);
      const fetched = await mapLimit(chunk, this.d.opts.txConcurrency, async (s) => {
        if (s.failed) return 'failed' as const;
        return this.fetchTx(s);
      });
      for (let j = 0; j < chunk.length; j++) {
        const s = chunk[j]!;
        const f = fetched[j]!;
        if (f === null) return { done, stalled: true, touched };
        if (f === 'failed') {
          this.d.metrics.txs.inc({ result: 'failed_onchain' });
        } else if (f === 'skip') {
          /* already logged */
        } else {
          const res = await this.applyDecoded(f);
          this.d.metrics.txs.inc({ result: res ? (res.inserted > 0 ? 'applied' : 'replayed') : 'no_events' });
          if (res) for (const m of res.markets) touched.add(m);
        }
        done.push(s);
        if (onChunk) await onChunk(s);
      }
    }
    return { done, stalled: false, touched };
  }

  /** Re-read market accounts and mirror them (reserves, fee state, status). */
  async refreshMarkets(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.mutex.run(async () => {
      const read = await this.d.source.getMarkets(ids);
      for (const id of ids) {
        const m = read.markets.get(id);
        if (m) await applyMarketAccount(this.d.sql, m, read.slot);
      }
    });
  }

  /* ------------------------------ live polling ------------------------------ */

  async loadCursor(): Promise<Cursor | null> {
    return getState<Cursor>(this.d.sql, CURSOR_KEY);
  }

  private async saveCursor(s: SigInfo): Promise<void> {
    await setState(this.d.sql, CURSOR_KEY, { signature: s.signature, slot: s.slot });
  }

  async loadBackfill(): Promise<BackfillState | null> {
    return getState<BackfillState>(this.d.sql, BACKFILL_KEY);
  }

  private async saveBackfill(b: Omit<BackfillState, 'updatedAt'>): Promise<void> {
    await setState(this.d.sql, BACKFILL_KEY, { ...b, updatedAt: this.now().toISOString() });
    this.state.backfillDone = b.done;
    this.d.metrics.backfillPending.set(b.done ? 0 : 1);
  }

  /** One poll cycle: everything newer than the cursor, oldest first. */
  async pollOnce(): Promise<PollStats> {
    const end = this.d.metrics.pollSeconds.startTimer();
    try {
      const head = await this.d.source.getSlot('confirmed');
      const cursor = await this.loadCursor();
      const bf = await this.loadBackfill();
      if (bf) {
        this.state.backfillDone = bf.done;
        this.d.metrics.backfillPending.set(bf.done ? 0 : 1);
      }
      const stats: PollStats = { scanned: 0, processed: 0, skipped: 0, stalled: false, headSlot: head };

      const collected: SigInfo[] = [];
      let before: string | undefined;
      const pageSize = this.d.opts.batchSize;
      for (;;) {
        const page = await this.d.source.getSignatures({ ...(before ? { before } : {}), ...(cursor ? { until: cursor.signature } : {}), limit: pageSize });
        let reachedOld = false;
        for (const s of page) {
          if (cursor && s.slot < cursor.slot - CURSOR_SLOT_MARGIN) {
            reachedOld = true;
            break;
          }
          if (cursor && s.signature === cursor.signature) {
            reachedOld = true;
            break;
          }
          collected.push(s);
        }
        // a fresh database only takes the newest page here; the rest is the backfill's job
        if (!cursor || reachedOld || page.length < pageSize) break;
        before = page[page.length - 1]!.signature;
      }
      stats.scanned = collected.length;

      if (collected.length > 0) {
        const { done, stalled, touched } = await this.processSignatures(collected, async (s) => {
          await this.saveCursor(s);
        });
        stats.processed = done.length;
        stats.stalled = stalled;
        if (touched.size > 0) await this.refreshMarkets([...touched]).catch((err) => this.fail('refresh', err));
        if (!cursor && done.length > 0) {
          const oldest = collected[collected.length - 1]!;
          const caughtUp = collected.length < pageSize || !this.d.opts.backfillOnStart;
          await this.saveBackfill({ before: caughtUp ? null : oldest.signature, done: caughtUp, processed: collected.length });
        }
        const newest = done[done.length - 1];
        this.state.indexedSlot = stalled ? Math.max(this.state.indexedSlot, newest?.slot ?? 0) : Math.max(head, newest?.slot ?? 0);
      } else {
        this.state.indexedSlot = Math.max(this.state.indexedSlot, head);
        if (!cursor) await this.saveBackfill({ before: null, done: true, processed: 0 });
      }
      this.state.headSlot = head;
      this.state.lastPollAt = Date.now();
      this.state.lastError = null;
      this.d.metrics.headSlot.set(head);
      this.d.metrics.indexedSlot.set(this.state.indexedSlot);
      this.d.metrics.lagSlots.set(Math.max(0, head - this.state.indexedSlot));
      this.d.metrics.lastPoll.set(Date.now() / 1000);
      return stats;
    } finally {
      end();
    }
  }

  /* ------------------------------ backfill ------------------------------ */

  /** Walk one page of history backwards. Returns false when the whole history has been covered. */
  async backfillStep(): Promise<{ more: boolean; scanned: number; oldest: SigInfo | null }> {
    let st = await this.loadBackfill();
    if (!st) st = { before: null, done: false, processed: 0, updatedAt: '' };
    if (st.done) return { more: false, scanned: 0, oldest: null };
    const page = await this.d.source.getSignatures({ ...(st.before ? { before: st.before } : {}), limit: this.d.opts.batchSize });
    if (page.length === 0) {
      await this.saveBackfill({ before: st.before, done: true, processed: st.processed });
      return { more: false, scanned: 0, oldest: null };
    }
    const { stalled, touched } = await this.processSignatures(page);
    if (stalled) return { more: true, scanned: 0, oldest: null }; // retry the same page later
    if (touched.size > 0) await this.refreshMarkets([...touched]).catch((err) => this.fail('refresh', err));
    const oldest = page[page.length - 1]!;
    const done = page.length < this.d.opts.batchSize;
    await this.saveBackfill({ before: oldest.signature, done, processed: st.processed + page.length });
    return { more: !done, scanned: page.length, oldest };
  }

  async resetBackfill(): Promise<void> {
    await this.saveBackfill({ before: null, done: false, processed: 0 });
  }

  /* ------------------------------ maintenance ------------------------------ */

  /** Re-read open (and recently resolved) markets from chain and fix any drift between events and accounts. */
  async reconcile(): Promise<number> {
    const ids = await listReconcileTargets(this.d.sql, this.now());
    if (ids.length === 0) return 0;
    await this.refreshMarkets(ids);
    return ids.length;
  }

  /**
   * Promote confirmed rows to finalized. A transaction the cluster no longer knows about (dropped fork) is only removed
   * after it was missing in two consecutive passes and its slot is safely below the finalized slot.
   */
  async finalizePass(): Promise<{ finalized: number; dropped: number }> {
    const finalizedSlot = await this.d.source.getSlot('finalized');
    const pending = await listUnfinalized(this.d.sql, finalizedSlot, 200);
    if (pending.length === 0) {
      this.d.metrics.unfinalized.set(await countUnfinalized(this.d.sql));
      return { finalized: 0, dropped: 0 };
    }
    const statuses = await this.d.source.getSignatureStatuses(pending.map((p) => p.signature));
    const ok: string[] = [];
    const drop: string[] = [];
    pending.forEach((p, i) => {
      const s = statuses[i] ?? null;
      if (s && !s.failed) {
        this.missingCounts.delete(p.signature);
        if (s.finalized) ok.push(p.signature);
      } else if (s?.failed || p.slot <= finalizedSlot - this.d.opts.dropGraceSlots) {
        const n = (this.missingCounts.get(p.signature) ?? 0) + 1;
        this.missingCounts.set(p.signature, n);
        if (s?.failed || n >= 2) drop.push(p.signature);
      }
    });
    let dropped = 0;
    await this.mutex.run(async () => {
      await markFinalized(this.d.sql, ok);
      if (drop.length > 0) {
        const r = await dropTransactions(this.d.sql, drop);
        dropped = drop.length;
        for (const s of drop) this.missingCounts.delete(s);
        this.d.metrics.dropped.inc(drop.length);
        this.d.log.warn({ signatures: drop.length, rows: r.rows, marketsDeleted: r.marketsDeleted, positionsRebuilt: r.positionsRebuilt }, 'removed rows of transactions that never finalized');
      }
    });
    if (drop.length > 0) await this.reconcile().catch((err) => this.fail('reconcile', err));
    this.d.metrics.unfinalized.set(await countUnfinalized(this.d.sql));
    return { finalized: ok.length, dropped };
  }

  async snapshotTicks(): Promise<number> {
    return snapshotTicks(this.d.sql, this.now());
  }

  async heartbeat(): Promise<void> {
    if (!this.d.redis) return;
    const behind = Math.max(0, this.state.headSlot - this.state.indexedSlot);
    await writeHeartbeat(
      this.d.redis,
      RK.heartbeatIndexer,
      {
        service: 'indexer',
        ts: Date.now(),
        indexedSlot: this.state.indexedSlot,
        headSlot: this.state.headSlot,
        lagSlots: behind,
        lastPollAt: this.state.lastPollAt,
        backfillDone: this.state.backfillDone,
        lastError: this.state.lastError,
      },
      30,
    );
  }

  fail(stage: string, err: unknown): void {
    this.state.lastError = `${stage}: ${(err as Error).message}`;
    this.d.metrics.errors.inc({ stage });
    this.d.log.error({ stage, err: (err as Error).message }, 'indexer step failed');
  }
}
