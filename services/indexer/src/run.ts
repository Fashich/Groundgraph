import { sleep, type Logger } from '@groundgraph/svc-core';
import type { Sql } from '@groundgraph/db';
import type { Indexer } from './indexer';

export interface LoopOptions {
  pollMs: number;
  reconcileMs: number;
  finalizeMs: number;
  tickMs: number;
  heartbeatMs: number;
}

const LEADER_LOCK = 7_274_101;

/** Only one live indexer per database: others stand by until the leader's connection closes. Returns null when aborted. */
export async function acquireLeaderLock(sql: Sql, log: Logger, signal: AbortSignal, key = LEADER_LOCK): Promise<{ release(): Promise<void> } | null> {
  const reserved = await sql.reserve();
  let warned = false;
  while (!signal.aborted) {
    const rows = await reserved<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(${key}) AS ok`;
    if (rows[0]?.ok) {
      return {
        async release() {
          await reserved`SELECT pg_advisory_unlock(${key})`.catch(() => undefined);
          reserved.release();
        },
      };
    }
    if (!warned) log.warn('another indexer instance holds the leader lock; standing by');
    warned = true;
    await sleep(5000, signal);
  }
  reserved.release();
  return null;
}

async function every(name: string, ms: number, signal: AbortSignal, ix: Indexer, fn: () => Promise<unknown>): Promise<void> {
  while (!signal.aborted) {
    await sleep(ms, signal);
    if (signal.aborted) return;
    try {
      await fn();
    } catch (err) {
      ix.fail(name, err);
    }
  }
}

/** Runs the indexer loops until the signal aborts. Resolves once every loop has finished its current iteration. */
export async function runLoops(ix: Indexer, o: LoopOptions, log: Logger, signal: AbortSignal): Promise<void> {
  const poll = async () => {
    let backoff = 0;
    while (!signal.aborted) {
      let idle = false;
      try {
        const st = await ix.pollOnce();
        backoff = 0;
        idle = !st.stalled && st.scanned === 0;
        if (idle && !ix.state.backfillDone) {
          const bf = await ix.backfillStep();
          if (bf.more) idle = false; // keep walking history without waiting, live polls run between pages
          if (bf.scanned > 0) log.info({ scanned: bf.scanned, more: bf.more }, 'backfill page done');
        }
        if (st.scanned > 0) log.debug({ scanned: st.scanned, processed: st.processed, stalled: st.stalled }, 'poll');
        if (!idle && !st.stalled) continue;
      } catch (err) {
        ix.fail('poll', err);
        backoff = Math.min(Math.max(backoff * 2, 1000), 30_000);
      }
      await ix.wakeup.wait(backoff || o.pollMs, signal);
    }
  };
  await Promise.all([
    poll(),
    every('reconcile', o.reconcileMs, signal, ix, () => ix.reconcile()),
    every('finalize', o.finalizeMs, signal, ix, () => ix.finalizePass()),
    every('ticks', o.tickMs, signal, ix, () => ix.snapshotTicks()),
    every('heartbeat', o.heartbeatMs, signal, ix, () => ix.heartbeat()),
  ]);
}
