import { prom } from '@groundgraph/svc-core';

export function createIndexerMetrics(registry: prom.Registry) {
  const counter = (name: string, help: string, labelNames: string[] = []) => new prom.Counter({ name, help, labelNames, registers: [registry] });
  const gauge = (name: string, help: string) => new prom.Gauge({ name, help, registers: [registry] });
  return {
    txs: counter('gg_indexer_txs_total', 'Transactions handled by outcome', ['result']),
    events: counter('gg_indexer_events_total', 'Program events decoded', ['name']),
    rows: counter('gg_indexer_rows_total', 'Event rows written (fresh) or replayed (duplicate)', ['kind']),
    errors: counter('gg_indexer_errors_total', 'Errors by stage', ['stage']),
    rpc: counter('gg_indexer_rpc_calls_total', 'RPC calls by method', ['method']),
    orphan: counter('gg_indexer_orphan_events_total', 'Events skipped because their market does not exist on chain'),
    dropped: counter('gg_indexer_dropped_txs_total', 'Transactions removed because they never finalized'),
    publishes: counter('gg_indexer_publishes_total', 'Redis publishes by channel kind', ['kind']),
    indexedSlot: gauge('gg_indexer_indexed_slot', 'Highest slot fully processed (confirmed)'),
    headSlot: gauge('gg_indexer_head_slot', 'Latest confirmed slot seen at the start of the last poll'),
    lagSlots: gauge('gg_indexer_lag_slots', 'head slot minus indexed slot'),
    unfinalized: gauge('gg_indexer_unfinalized_rows', 'Event rows still waiting for finalization'),
    backfillPending: gauge('gg_indexer_backfill_pending', '1 while the historical backfill has not finished'),
    lastPoll: gauge('gg_indexer_last_poll_timestamp_seconds', 'Unix time of the last successful poll'),
    pollSeconds: new prom.Histogram({
      name: 'gg_indexer_poll_duration_seconds',
      help: 'Duration of one poll cycle',
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: [registry],
    }),
  };
}

export type IndexerMetrics = ReturnType<typeof createIndexerMetrics>;
