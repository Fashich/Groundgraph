import { listDueMarkets, type MarketRow, type Sql } from '@groundgraph/db';
import { assetByFeedId, CH, RK, type ChainReader, type HermesClient, type Logger, type PriceReading, type PushFeedReader, type Redis } from '@groundgraph/svc-core';
import { PublicKey } from '@solana/web3.js';
import { randomBytes } from 'node:crypto';
import type { Alerter } from './alerts';
import type { KeeperMetrics } from './metrics';
import type { Poster } from './poster';
import { decideSettlement, retryDelaySecs, validateReading, type SettleDecision } from './settle-logic';

const VOID_GRACE_SECS = 3600;
const LOCK_TTL_SECS = 90;

export interface SettleDeps {
  sql: Sql;
  redis: Redis;
  chain: ChainReader;
  poster: Poster;
  push: Pick<PushFeedReader, 'latest'>;
  hermes?: Pick<HermesClient, 'atTime'> | undefined;
  mode: 'hermes' | 'push-feed';
  pushAssets: ReadonlySet<string>;
  log: Logger;
  metrics: KeeperMetrics;
  alerter: Alerter;
  alertAfterAttempts: number;
  now: () => Date;
  voidGraceSecs?: number;
}

interface Attempt {
  count: number;
  nextAtMs: number;
  lastError?: string;
}

export interface SettleReport {
  due: number;
  settled: string[];
  voided: string[];
  failed: string[];
  waiting: string[];
  unavailable: string[];
}

const ALREADY_RESOLVED = /MarketNotOpen|already (settled|voided)|custom program error: 0x(1770|1771)/i;
const RELEASE_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/** Settles Close markets once settle_ts has passed and voids the ones that could not be settled in time. */
export class SettleLoop {
  readonly attempts = new Map<string, Attempt>();
  private warned = new Set<string>();
  private hot = false;
  private owner = randomBytes(8).toString('hex');
  readonly stats = { settled: 0, voided: 0, failed: 0 };

  constructor(private d: SettleDeps) {}

  /** Poll faster while a market is inside its settlement window or being retried: the push feed only holds the latest update. */
  nextDelayMs(idleMs: number, hotMs = 2000): number {
    return this.hot ? Math.min(idleMs, hotMs) : idleMs;
  }

  private async lock(id: string): Promise<boolean> {
    const ok = await this.d.redis.set(RK.settleLock(id), this.owner, 'EX', LOCK_TTL_SECS, 'NX');
    return ok === 'OK';
  }

  private async unlock(id: string): Promise<void> {
    await this.d.redis.eval(RELEASE_LUA, 1, RK.settleLock(id), this.owner).catch(() => undefined);
  }

  private warnOnce(key: string, fn: () => void): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    fn();
  }

  async runOnce(): Promise<SettleReport> {
    const now = this.d.now();
    const nowSec = Math.floor(now.getTime() / 1000);
    const report: SettleReport = { due: 0, settled: [], voided: [], failed: [], waiting: [], unavailable: [] };
    const due = await listDueMarkets(this.d.sql, now);
    report.due = due.length;
    this.d.metrics.dueMarkets.set(due.length);
    this.hot = false;
    if (due.length === 0) return report;

    const cfg = await this.d.chain.getConfig();
    const maxStalenessSecs = cfg?.maxStalenessSecs ?? 60;
    const maxConfBps = cfg?.maxConfBps ?? 50;

    // one RPC call covers every push feed we may need
    let push = new Map<string, PriceReading>();
    if (this.d.mode === 'push-feed') {
      const ids = [...new Set(due.map((m) => m.feedId))];
      try {
        push = await this.d.push.latest(ids);
      } catch (err) {
        this.d.log.warn({ err: (err as Error).message }, 'push feed read failed');
      }
    }

    for (const m of due) {
      const att = this.attempts.get(m.id);
      if (att && att.nextAtMs > now.getTime()) {
        this.hot = true;
        continue;
      }
      if (!(await this.lock(m.id))) continue;
      let keepLock = false;
      try {
        keepLock = await this.handle(m, { nowSec, maxStalenessSecs, maxConfBps }, push, report);
      } catch (err) {
        this.fail(m, err as Error, report);
      } finally {
        if (!keepLock) await this.unlock(m.id);
      }
    }
    return report;
  }

  /** Returns true when the market was resolved (the lock then stays until it expires, so other keepers skip it). */
  private async handle(m: MarketRow, p: { nowSec: number; maxStalenessSecs: number; maxConfBps: number }, push: Map<string, PriceReading>, report: SettleReport): Promise<boolean> {
    const chainM = await this.d.chain.getMarket(m.id);
    if (!chainM) {
      this.warnOnce(`missing:${m.id}`, () => this.d.log.warn({ market: m.id }, 'market account not found on chain, skipping'));
      return false;
    }
    const asset = assetByFeedId(chainM.feedIdHex);
    const decision = decideSettlement({
      nowSec: p.nowSec,
      settleTs: chainM.settleTs,
      maxStalenessSecs: p.maxStalenessSecs,
      maxConfBps: p.maxConfBps,
      voidGraceSecs: this.d.voidGraceSecs ?? VOID_GRACE_SECS,
      status: chainM.status,
      kind: chainM.kind,
      mode: this.d.mode,
      push: push.get(chainM.feedIdHex) ?? null,
      assetSupported: asset ? this.d.pushAssets.has(asset.symbol) : false,
      feedIdHex: chainM.feedIdHex,
    });
    const attempt = this.attempts.get(m.id)?.count ?? 0;
    const symbol = asset?.symbol ?? m.assetSymbol;

    switch (decision.action) {
      case 'skip':
        this.attempts.delete(m.id);
        this.d.metrics.settle.inc({ result: 'skipped' });
        return decision.reason === 'not_open';
      case 'wait':
        return false;
      case 'wait-feed':
        this.hot = this.hot || decision.windowLeftSecs > 0;
        report.waiting.push(m.id);
        this.warnOnce(`wait:${m.id}:${decision.reason}`, () =>
          this.d.log.warn({ market: m.id, symbol, reason: decision.reason, windowLeftSecs: decision.windowLeftSecs }, 'push feed has no usable price yet, retrying'),
        );
        return false;
      case 'unavailable':
        report.unavailable.push(m.id);
        await this.unavailable(m, symbol, decision);
        return false;
      case 'void':
        return this.send('void', m, report, () => this.d.poster.voidMarket(chainM, attempt));
      case 'settle-push': {
        if (!decision.account) throw new Error('push feed reading has no account address');
        return this.send('settle', m, report, () => this.d.poster.settlePush(chainM, new PublicKey(decision.account), attempt));
      }
      case 'settle-hermes': {
        if (!this.d.hermes) throw new Error('Hermes settlement requested without a Hermes client (set PYTH_API_KEY)');
        const { readings, updates } = await this.d.hermes.atTime(chainM.settleTs, [chainM.feedIdHex]);
        const r = readings.get(chainM.feedIdHex);
        if (!r || updates.length === 0) throw new Error('Hermes returned no update for the settlement time');
        // Hermes updates are verified by the receiver on posting, so they are treated as fully verified here
        const verdict = validateReading({ ...r, verification: 'full' }, chainM.feedIdHex, { nowSec: p.nowSec, settleTs: chainM.settleTs, maxStalenessSecs: p.maxStalenessSecs, maxConfBps: p.maxConfBps, voidGraceSecs: VOID_GRACE_SECS });
        if (!verdict.ok) {
          // before_settle_ts can heal on the next try (Hermes catching up); the others cannot, the market will be voided
          if (verdict.reason === 'before_settle_ts') throw new Error(`Hermes update is older than settle_ts (publish ${r.publishTs}, settle ${chainM.settleTs}), retrying`);
          report.unavailable.push(m.id);
          await this.unavailable(m, symbol, { action: 'unavailable', reason: 'window_missed', voidInSecs: chainM.settleTs + VOID_GRACE_SECS - p.nowSec }, `Hermes update rejected by the program rules: ${verdict.reason}`);
          return false;
        }
        return this.send('settle', m, report, () => this.d.poster.settleHermes(chainM, updates, attempt));
      }
    }
  }

  private async unavailable(m: MarketRow, symbol: string, d: Extract<SettleDecision, { action: 'unavailable' }>, detail?: string): Promise<void> {
    this.attempts.delete(m.id);
    this.warnOnce(`unavailable:${m.id}:${d.reason}`, () => {
      this.d.log.warn(
        { market: m.id, symbol, reason: d.reason, voidInSecs: d.voidInSecs, mode: this.d.mode },
        `cannot settle with the ${this.d.mode} price source (${d.reason}); the market will be voided ${d.voidInSecs}s from now unless a price source becomes available`,
      );
    });
    this.d.metrics.alerts.inc({ severity: 'warn' });
    await this.d.alerter.alert({
      key: `settle-unavailable:${m.id}`,
      severity: 'warn',
      title: `${symbol} market cannot be settled`,
      message: detail ?? `Reason: ${d.reason}. Settlement oracle mode: ${this.d.mode}. ${this.d.mode === 'push-feed' ? 'Set PYTH_API_KEY to settle any allow-listed asset through Hermes.' : ''} Users will be refunded at 0.5 USDC per share when the market is voided.`,
      fields: { market: m.id, symbol, voidInSecs: d.voidInSecs },
    });
  }

  private async send(kind: 'settle' | 'void', m: MarketRow, report: SettleReport, run: () => Promise<string>): Promise<boolean> {
    try {
      const sig = await run();
      this.attempts.delete(m.id);
      this.d.metrics.settle.inc({ result: kind === 'settle' ? 'settled' : 'voided' });
      this.d.metrics.txSent.inc({ kind });
      this.d.log.info({ market: m.id, signature: sig, kind, mode: this.d.mode }, kind === 'settle' ? 'market settled' : 'market voided');
      if (kind === 'settle') {
        this.stats.settled++;
        report.settled.push(m.id);
      } else {
        this.stats.voided++;
        report.voided.push(m.id);
        this.d.metrics.alerts.inc({ severity: 'critical' });
        await this.d.alerter.alert({
          key: `voided:${m.id}`,
          severity: 'critical',
          title: 'market voided',
          message: `The market could not be settled within ${VOID_GRACE_SECS}s of settle_ts and was voided. Holders can exit at 0.5 USDC per share.`,
          fields: { market: m.id, asset: m.assetSymbol, signature: sig },
        });
      }
      await this.d.alerter.resolve(`settle-failed:${m.id}`, `settle ${m.id}`, 'settled');
      await this.d.alerter.resolve(`settle-unavailable:${m.id}`, `settle ${m.id}`, kind === 'settle' ? 'settled' : 'voided');
      // tell the indexer to look right away so the database reflects the result within a second
      await this.d.redis.publish(CH.indexerNudge, '1').catch(() => undefined);
      return true;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (ALREADY_RESOLVED.test(msg)) {
        this.attempts.delete(m.id);
        this.d.metrics.settle.inc({ result: 'skipped' });
        this.d.log.info({ market: m.id }, 'market was already resolved by someone else');
        await this.d.redis.publish(CH.indexerNudge, '1').catch(() => undefined);
        return true;
      }
      this.fail(m, err as Error, report);
      return false;
    }
  }

  private fail(m: MarketRow, err: Error, report: SettleReport): void {
    const prev = this.attempts.get(m.id);
    const count = (prev?.count ?? 0) + 1;
    const nextAtMs = this.d.now().getTime() + retryDelaySecs(count) * 1000;
    this.attempts.set(m.id, { count, nextAtMs, lastError: err.message });
    this.hot = true;
    this.stats.failed++;
    report.failed.push(m.id);
    this.d.metrics.settle.inc({ result: 'failed' });
    this.d.log.warn({ market: m.id, attempt: count, retryInSecs: retryDelaySecs(count), err: err.message.slice(0, 400) }, 'settlement attempt failed');
    if (count >= this.d.alertAfterAttempts) {
      this.d.metrics.alerts.inc({ severity: 'critical' });
      void this.d.alerter.alert({
        key: `settle-failed:${m.id}`,
        severity: 'critical',
        title: 'settlement is failing',
        message: `${count} attempts failed. Last error: ${err.message.slice(0, 300)}`,
        fields: { market: m.id, asset: m.assetSymbol, mode: this.d.mode },
      });
    }
  }
}
