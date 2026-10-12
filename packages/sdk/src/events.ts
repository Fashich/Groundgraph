import type { PublicKey } from '@solana/web3.js';
import { concatBytes, decodeDefined, encodeDefined } from './codec';
import { PROGRAM_ID } from './constants';
import { IDL, eventDiscriminator } from './idl';
import type { Side } from './api-types';
import type { MarketKindName, OutcomeName } from './accounts';

export interface MarketCreatedData {
  market: PublicKey; creator: PublicKey; feedId: Uint8Array; targetPrice: bigint; targetExpo: number; kind: MarketKindName;
  settleTs: bigint; tradingEndTs: bigint; baseFeeBps: number; dynamicFee: boolean; liquidity: bigint; p0Bps: number;
  aboveMint: PublicKey; belowMint: PublicKey; lpMint: PublicKey; vault: PublicKey;
}
/** `usdc` is the gross USDC paid on a buy and the net USDC received on a sell; `shares` is the share amount in both. */
export interface TradeData {
  market: PublicKey; wallet: PublicKey; side: Side; isBuy: boolean; usdc: bigint; shares: bigint; feeUsdc: bigint; feeBps: number;
  priceAfterBps: number; reserveAbove: bigint; reserveBelow: bigint; ts: bigint;
}
export interface SettledData { market: PublicKey; outcome: OutcomeName; price: bigint; expo: number; publishTs: bigint; lpClaim: bigint }
export interface VoidedData { market: PublicKey; lpClaim: bigint }
export interface RedeemedData { market: PublicKey; wallet: PublicKey; side: Side; shares: bigint; usdc: bigint }
export interface MergedData { market: PublicKey; wallet: PublicKey; amount: bigint }
export interface LiquidityChangedData { market: PublicKey; wallet: PublicKey; lpAmount: bigint; usdc: bigint; isAdd: boolean }
export interface ConfigUpdatedData {
  admin: PublicKey; treasury: PublicKey; usdcMint: PublicKey; protocolFeeShareBps: number; maxFeeBps: number; minLiquidity: bigint;
  minDurationSecs: bigint; maxDurationSecs: bigint; maxStalenessSecs: number; maxConfBps: number; tradingCloseSecs: number; paused: boolean;
}
export interface FeedUpdatedData { feedId: Uint8Array; expo: number; enabled: boolean }

export type GgEvent =
  | { name: 'MarketCreated'; data: MarketCreatedData }
  | { name: 'Trade'; data: TradeData }
  | { name: 'Settled'; data: SettledData }
  | { name: 'Voided'; data: VoidedData }
  | { name: 'Redeemed'; data: RedeemedData }
  | { name: 'Merged'; data: MergedData }
  | { name: 'LiquidityChanged'; data: LiquidityChangedData }
  | { name: 'ConfigUpdated'; data: ConfigUpdatedData }
  | { name: 'FeedUpdated'; data: FeedUpdatedData };

export type GgEventName = GgEvent['name'];
export const EVENT_NAMES: readonly GgEventName[] = IDL.events.map((e) => e.name) as GgEventName[];

const DISC_HEX = new Map<string, GgEventName>(
  EVENT_NAMES.map((n) => [Buffer.from(eventDiscriminator(n)).toString('hex'), n]),
);


/** Decode one event from its raw bytes (8 byte discriminator + borsh body). Returns null for foreign data. */
export function decodeEvent(raw: Uint8Array): GgEvent | null {
  if (raw.length < 8) return null;
  const name = DISC_HEX.get(Buffer.from(raw.subarray(0, 8)).toString('hex'));
  if (!name) return null;
  try {
    return { name, data: decodeDefined(name, raw.subarray(8)) } as GgEvent;
  } catch {
    return null;
  }
}

/**
 * Decode `Program data: <base64>` log lines emitted by this program only. The invocation stack is tracked from the
 * `invoke`/`success`/`failed` lines, so data logged by other programs (including CPIs made by this one) is skipped.
 */
export function parseEventsFromLogs(logs: string[], programId: PublicKey = PROGRAM_ID): GgEvent[] {
  const out: GgEvent[] = [];
  const stack: string[] = [];
  const pid = programId.toBase58();
  for (const line of logs) {
    const inv = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (inv) { stack.push(inv[1]!); continue; }
    if (/^Program \w+ (success|failed.*)$/.test(line)) { stack.pop(); continue; }
    const m = /^Program data: (\S+)/.exec(line);
    if (!m || stack[stack.length - 1] !== pid) continue;
    const ev = decodeEvent(Uint8Array.from(Buffer.from(m[1]!, 'base64')));
    if (ev) out.push(ev);
  }
  return out;
}

/** Serialize an event as the program does (`Program data:` payload). */
export function encodeEvent(e: GgEvent): Uint8Array {
  return concatBytes(eventDiscriminator(e.name), encodeDefined(e.name, e.data));
}

/** Test helper: the log lines of one successful invocation that emitted `events`. */
export function encodeEventLogs(events: GgEvent[], programId: PublicKey = PROGRAM_ID): string[] {
  const pid = programId.toBase58();
  return [
    `Program ${pid} invoke [1]`,
    ...events.map((e) => `Program data: ${Buffer.from(encodeEvent(e)).toString('base64')}`),
    `Program ${pid} success`,
  ];
}
