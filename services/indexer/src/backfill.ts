/**
 * Resumable historical backfill: walks the program's signatures from the newest towards the oldest, one page at a
 * time, and persists its position (indexer_state key `indexer:backfill`) after every page. Safe to interrupt and to
 * re-run; every write is idempotent. It can run next to the live indexer.
 *
 *   pnpm --filter @groundgraph/indexer backfill [--reset] [--since <ISO date|unix secs>] [--limit <signatures>] [--before <signature>] [--batch <n>]
 */
import { PROGRAM_ID } from '@groundgraph/svc-core';
import { boot } from './boot';
import { loadConfig } from './config';
import { acquireLeaderLock } from './run';

interface Args {
  reset: boolean;
  since?: number;
  limit?: number;
  before?: string;
  batch?: number;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { reset: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${k} needs a value`);
      return v;
    };
    switch (k) {
      case '--reset':
        a.reset = true;
        break;
      case '--since': {
        const v = next();
        const n = /^\d+$/.test(v) ? Number(v) : Math.floor(Date.parse(v) / 1000);
        if (!Number.isFinite(n)) throw new Error(`--since: cannot parse "${v}"`);
        a.since = n;
        break;
      }
      case '--limit':
        a.limit = Number(next());
        if (!Number.isInteger(a.limit) || a.limit < 1) throw new Error('--limit must be a positive integer');
        break;
      case '--before':
        a.before = next();
        break;
      case '--batch':
        a.batch = Number(next());
        if (!Number.isInteger(a.batch) || a.batch < 10 || a.batch > 1000) throw new Error('--batch must be between 10 and 1000');
        break;
      case '-h':
      case '--help':
        a.help = true;
        break;
      default:
        throw new Error(`unknown argument ${k}`);
    }
  }
  return a;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: backfill [--reset] [--since <ISO date|unix secs>] [--limit <signatures>] [--before <signature>] [--batch <n>]');
    return;
  }
  const cfg = loadConfig(args.batch ? { ...process.env, INDEXER_BATCH_SIZE: String(args.batch) } : process.env);
  const b = await boot(cfg, 'indexer-backfill');
  const { log, indexer, db, redis } = b;
  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  process.on('SIGTERM', () => ac.abort());
  // separate lock key: two backfill runs never overlap, the live indexer is unaffected
  const lock = await acquireLeaderLock(db.sql, log, ac.signal, 7_274_102);
  if (!lock) return;
  try {
    log.info({ program: PROGRAM_ID.toBase58(), rpc: cfg.rpcLabel }, 'backfill starting');
    if (args.reset || args.before) {
      const { setState } = await import('@groundgraph/db');
      await setState(db.sql, 'indexer:backfill', { before: args.before ?? null, done: false, processed: 0, updatedAt: new Date().toISOString() });
      log.info({ from: args.before ?? 'newest' }, 'backfill position reset');
    }
    let total = 0;
    while (!ac.signal.aborted) {
      const step = await indexer.backfillStep();
      total += step.scanned;
      if (step.scanned > 0) log.info({ scanned: step.scanned, total, oldestSlot: step.oldest?.slot, oldestTime: step.oldest?.blockTime ? new Date(step.oldest.blockTime * 1000).toISOString() : null }, 'page done');
      if (!step.more) {
        log.info({ total }, 'backfill complete');
        break;
      }
      if (args.limit && total >= args.limit) {
        log.info({ total }, 'limit reached, run again to continue');
        break;
      }
      if (args.since && step.oldest?.blockTime && step.oldest.blockTime < args.since) {
        log.info({ total }, 'reached --since, run again to continue deeper');
        break;
      }
    }
    await indexer.reconcile();
  } finally {
    await lock.release();
    redis.disconnect();
    await db.close();
  }
}

if (process.argv[1] && /backfill\.(ts|js)$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error('backfill failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
