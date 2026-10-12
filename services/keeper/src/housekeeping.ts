import type { Sql } from '@groundgraph/db';
import type { Logger } from '@groundgraph/svc-core';
import type { Alerter } from './alerts';
import type { KeeperMetrics } from './metrics';
import type { Poster } from './poster';

export interface HousekeepingDeps {
  sql: Sql;
  poster: Poster;
  log: Logger;
  metrics: KeeperMetrics;
  alerter: Alerter;
  now: () => Date;
  oracleRetentionDays: number;
  fairValueRetentionDays: number;
  minLamports: bigint;
  checkBalance: boolean;
}

export interface HousekeepingResult {
  oracleRows: number;
  fairValueRows: number;
  balanceLamports: bigint | null;
}

/** Prunes high-volume history and watches the keeper wallet balance. */
export async function housekeeping(d: HousekeepingDeps): Promise<HousekeepingResult> {
  const now = d.now().getTime();
  const oracleCutoff = new Date(now - d.oracleRetentionDays * 86_400_000);
  const fvCutoff = new Date(now - d.fairValueRetentionDays * 86_400_000);
  const o = await d.sql`DELETE FROM oracle_status WHERE ts < ${oracleCutoff}`;
  // fair values of resolved markets are no longer served; open markets keep their history for the chart
  const f = await d.sql`DELETE FROM fair_values fv USING markets m WHERE fv.market_id = m.id AND fv.ts < ${fvCutoff} AND m.status <> 'open'`;
  let balance: bigint | null = null;
  if (d.checkBalance) {
    try {
      balance = await d.poster.balanceLamports();
      d.metrics.balance.set(Number(balance));
      const key = 'keeper-balance-low';
      if (balance < d.minLamports) {
        d.metrics.alerts.inc({ severity: 'critical' });
        await d.alerter.alert({
          key,
          severity: 'critical',
          title: 'keeper wallet is low on SOL',
          message: `Balance ${(Number(balance) / 1e9).toFixed(4)} SOL is below the ${(Number(d.minLamports) / 1e9).toFixed(2)} SOL threshold. Settlement and void transactions will fail when it runs out.`,
          fields: { wallet: d.poster.payer.toBase58() },
        });
      } else {
        await d.alerter.resolve(key, 'keeper balance', 'balance restored');
      }
    } catch (err) {
      d.log.warn({ err: (err as Error).message }, 'balance check failed');
    }
  }
  if (o.count + f.count > 0) d.log.info({ oracleRows: o.count, fairValueRows: f.count }, 'housekeeping pruned old rows');
  return { oracleRows: o.count, fairValueRows: f.count, balanceLamports: balance };
}
