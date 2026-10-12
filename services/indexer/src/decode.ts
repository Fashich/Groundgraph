import { normalizeEvent, parseEventsFromLogs, PROGRAM_ID, type NormEvent } from '@groundgraph/svc-core';
import type { PublicKey } from '@solana/web3.js';
import type { TxData } from './source';

/** A successful transaction reduced to the program events it emitted. */
export interface DecodedTx {
  signature: string;
  slot: number;
  /** block time, unix seconds (the indexer's clock when the node did not report one) */
  ts: number;
  /** events in emission order; `ix` is the ordinal across ALL program events of the tx and is stable across re-reads */
  events: { ix: number; ev: NormEvent }[];
}

/**
 * Decode the program log lines of a transaction with the SDK. Returns null for failed transactions: their logs may
 * contain events, but the state changes were rolled back.
 */
export function decodeTx(tx: TxData, programId: PublicKey = PROGRAM_ID, fallbackTs = Math.floor(Date.now() / 1000)): DecodedTx | null {
  if (tx.failed) return null;
  const raw = parseEventsFromLogs(tx.logs, programId);
  const events: DecodedTx['events'] = [];
  raw.forEach((r, ix) => {
    const ev = normalizeEvent(r as { name: string; data: unknown });
    if (ev) events.push({ ix, ev });
  });
  return { signature: tx.signature, slot: tx.slot, ts: tx.blockTime ?? fallbackTs, events };
}
