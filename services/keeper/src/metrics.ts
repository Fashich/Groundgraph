import { prom } from '@groundgraph/svc-core';

export function createKeeperMetrics(registry: prom.Registry) {
  const counter = (name: string, help: string, labelNames: string[] = []) => new prom.Counter({ name, help, labelNames, registers: [registry] });
  const gauge = (name: string, help: string, labelNames: string[] = []) => new prom.Gauge({ name, help, labelNames, registers: [registry] });
  return {
    settle: counter('gg_keeper_settle_total', 'Settlement attempts by result', ['result']),
    txSent: counter('gg_keeper_tx_sent_total', 'Transactions confirmed by kind', ['kind']),
    loopErrors: counter('gg_keeper_loop_errors_total', 'Loop iterations that threw', ['loop']),
    fairValues: counter('gg_keeper_fair_values_written_total', 'fair_values rows written'),
    alerts: counter('gg_keeper_alerts_total', 'Alerts raised', ['severity']),
    dueMarkets: gauge('gg_keeper_due_markets', 'Markets past settle_ts that are not yet resolved'),
    oracleAge: gauge('gg_keeper_oracle_age_seconds', 'Age of the latest reading per feed', ['symbol']),
    oracleStale: gauge('gg_keeper_oracle_stale', '1 when the latest reading is stale', ['symbol']),
    oracleSource: gauge('gg_keeper_oracle_source', '1 for the active price source', ['source']),
    settlementMode: gauge('gg_keeper_settlement_mode', '1 for the active settlement oracle', ['mode']),
    balance: gauge('gg_keeper_balance_lamports', 'Keeper wallet balance'),
    lastTick: gauge('gg_keeper_last_tick_timestamp_seconds', 'Unix time of the last completed iteration', ['loop']),
    loopSeconds: new prom.Histogram({
      name: 'gg_keeper_loop_duration_seconds',
      help: 'Duration of one loop iteration',
      labelNames: ['loop'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 15, 60],
      registers: [registry],
    }),
  };
}

export type KeeperMetrics = ReturnType<typeof createKeeperMetrics>;
