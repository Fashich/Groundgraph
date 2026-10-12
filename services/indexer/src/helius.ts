import { PROGRAM_ID, type Logger } from '@groundgraph/svc-core';
import { Connection, type PublicKey } from '@solana/web3.js';

export interface LogNudge {
  close(): Promise<void>;
}

/**
 * Optional low-latency trigger: a websocket logsSubscribe on the program wakes the poller as soon as a transaction
 * touching the program is confirmed. The poller stays the single source of truth (the websocket may drop messages),
 * so this only shortens the delay. Works with Helius and with any RPC provider that serves logsSubscribe.
 */
export function startLogNudge(opts: { rpcUrl: string; wsUrl: string; programId?: PublicKey; log: Logger; onLogs: () => void }): LogNudge {
  const conn = new Connection(opts.rpcUrl, { commitment: 'confirmed', wsEndpoint: opts.wsUrl });
  const id = conn.onLogs(opts.programId ?? PROGRAM_ID, (l) => (l.err ? undefined : opts.onLogs()), 'confirmed');
  opts.log.info({ ws: new URL(opts.wsUrl).host }, 'websocket log nudge enabled');
  return {
    async close() {
      await conn.removeOnLogsListener(id).catch(() => undefined);
    },
  };
}
