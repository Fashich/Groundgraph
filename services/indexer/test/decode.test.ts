import { encodeEventLogs } from '@groundgraph/sdk';
import { PROGRAM_ID } from '@groundgraph/svc-core';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { decodeTx } from '../src/decode';
import { ev, marketFixture, pk } from './helpers';

const m = marketFixture();
const tx = (logs: string[], failed = false) => ({ signature: 'sigA', slot: 42, blockTime: 1_800_000_000, failed, logs });

describe('decodeTx', () => {
  it('decodes program events in order with a stable ordinal', () => {
    const w = pk().toBase58();
    const logs = encodeEventLogs([ev.created(m), ev.trade(m, { wallet: w, side: 'above', buy: true, usdc: 5_000_000n, shares: 9_000_000n })]);
    const d = decodeTx(tx(logs))!;
    expect(d.slot).toBe(42);
    expect(d.ts).toBe(1_800_000_000);
    expect(d.events.map((e) => [e.ix, e.ev.name])).toEqual([[0, 'MarketCreated'], [1, 'Trade']]);
    const t = d.events[1]!.ev;
    expect(t).toMatchObject({ name: 'Trade', wallet: w, side: 'above', isBuy: true, usdc: 5_000_000n, shares: 9_000_000n });
  });

  it('keeps the ordinal across events the services do not track', () => {
    const logs = encodeEventLogs([
      { name: 'FeedUpdated', data: { feedId: new Uint8Array(32), expo: -8, enabled: true } },
      ev.voided(m),
    ]);
    const d = decodeTx(tx(logs))!;
    expect(d.events).toHaveLength(1);
    expect(d.events[0]).toMatchObject({ ix: 1 });
  });

  it('ignores data logged by other programs, including CPIs', () => {
    const other = Keypair.generate().publicKey;
    const foreign = encodeEventLogs([ev.voided(m)], other);
    const own = encodeEventLogs([ev.settled(m)]);
    const d = decodeTx(tx([...foreign, ...own]))!;
    expect(d.events.map((e) => e.ev.name)).toEqual(['Settled']);
  });

  it('returns null for a failed transaction even when it logged events', () => {
    expect(decodeTx(tx(encodeEventLogs([ev.voided(m)]), true))).toBeNull();
  });

  it('uses the fallback time when the node reports no block time', () => {
    const d = decodeTx({ ...tx(encodeEventLogs([ev.voided(m)])), blockTime: null }, PROGRAM_ID, 1234)!;
    expect(d.ts).toBe(1234);
  });

  it('skips garbage program data', () => {
    const pid = PROGRAM_ID.toBase58();
    const d = decodeTx(tx([`Program ${pid} invoke [1]`, 'Program data: AAAA', 'Program data: !!!notbase64', `Program ${pid} success`]))!;
    expect(d.events).toHaveLength(0);
  });
});
