import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import samples from './account-samples.json';
import {
  EVENT_NAMES,
  IDL,
  PROGRAM_ID,
  decodeConfig,
  decodeEvent,
  decodeFeed,
  decodeMarket,
  effectiveStatus,
  encodeConfig,
  encodeEvent,
  encodeEventLogs,
  encodeFeed,
  encodeMarket,
  parseEventsFromLogs,
  type GgEvent,
} from '../src/index';

const hex = (s: string): Buffer => Buffer.from(s, 'hex');

/** Normalise a decoded value for comparison with the Rust-generated JSON (u64 as strings, bytes as hex). */
function norm(v: unknown): unknown {
  if (v instanceof PublicKey) return v.toBase58();
  if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean' || typeof v === 'string') return v;
  throw new Error(`unexpected value ${String(v)}`);
}
function normalize(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k === 'feedId' ? 'feedIdHex' : k] = norm(v);
  return out;
}
function normalizeExpected(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = typeof v === 'number' ? String(v) : v;
  return out;
}

describe('account decoders against Rust-serialized bytes', () => {
  it('Market (open and settled)', () => {
    for (const s of [samples.marketOpen, samples.marketSettled]) {
      const bytes = hex(s.hex);
      expect(bytes.length).toBe(364);
      const m = decodeMarket(bytes);
      expect(normalize(m as unknown as Record<string, unknown>)).toEqual(normalizeExpected(s.decoded));
      expect(Buffer.from(encodeMarket(m)).toString('hex')).toBe(s.hex);
    }
  });
  it('Config', () => {
    const c = decodeConfig(hex(samples.config.hex));
    expect(normalize(c as unknown as Record<string, unknown>)).toEqual(normalizeExpected(samples.config.decoded));
    expect(Buffer.from(encodeConfig(c)).toString('hex')).toBe(samples.config.hex);
  });
  it('FeedAllowlist', () => {
    const f = decodeFeed(hex(samples.feed.hex));
    expect(normalize(f as unknown as Record<string, unknown>)).toEqual(normalizeExpected(samples.feed.decoded));
    expect(Buffer.from(encodeFeed(f)).toString('hex')).toBe(samples.feed.hex);
  });
  it('rejects a wrong discriminator and short data', () => {
    const bytes = hex(samples.marketOpen.hex);
    expect(() => decodeConfig(bytes)).toThrow(/discriminator/);
    expect(() => decodeMarket(bytes.subarray(0, 40))).toThrow();
    expect(() => decodeMarket(Buffer.alloc(0))).toThrow();
  });
  it('tolerates trailing bytes', () => {
    const padded = Buffer.concat([hex(samples.marketOpen.hex), Buffer.alloc(16)]);
    expect(decodeMarket(padded).nonce).toBe(BigInt(samples.marketOpen.decoded.nonce));
  });
  it('discriminators match the IDL', () => {
    for (const a of IDL.accounts) expect(Buffer.from(a.discriminator).toString('hex')).toBe((samples.discriminators as Record<string, string>)[a.name]);
    for (const e of IDL.events) expect(Buffer.from(e.discriminator).toString('hex')).toBe((samples.discriminators as Record<string, string>)[e.name]);
  });
  it('typed fields have the expected runtime types', () => {
    const m = decodeMarket(hex(samples.marketSettled.hex));
    expect(typeof m.nonce).toBe('bigint');
    expect(typeof m.openTs).toBe('bigint');
    expect(typeof m.baseFeeBps).toBe('number');
    expect(m.kind).toBe('close');
    expect(m.status).toBe('settled');
    expect(m.outcome).toBe('above');
    expect(m.feedId).toBeInstanceOf(Uint8Array);
    expect(m.creator).toBeInstanceOf(PublicKey);
  });
});

describe('effectiveStatus', () => {
  it('derives trading_closed from the clock', () => {
    const m = decodeMarket(hex(samples.marketOpen.hex));
    const end = Number(m.tradingEndTs);
    expect(effectiveStatus(m, end - 1)).toBe('open');
    expect(effectiveStatus(m, end)).toBe('trading_closed');
    expect(effectiveStatus({ ...m, status: 'settled' }, end + 10)).toBe('settled');
    expect(effectiveStatus({ ...m, status: 'voided' }, 0)).toBe('voided');
  });
});

describe('events', () => {
  it('decodes the Rust-serialized events', () => {
    for (const name of Object.keys(samples.events)) {
      const s = (samples.events as Record<string, { hex: string; decoded: Record<string, unknown> }>)[name]!;
      const ev = decodeEvent(hex(s.hex));
      expect(ev?.name).toBe(name);
      expect(normalize(ev!.data as unknown as Record<string, unknown>)).toEqual(normalizeExpected(s.decoded));
      expect(Buffer.from(encodeEvent(ev!)).toString('hex')).toBe(s.hex);
    }
  });
  it('knows every IDL event', () => {
    expect([...EVENT_NAMES].sort()).toEqual(IDL.events.map((e) => e.name).sort());
  });
  it('parseEventsFromLogs reads only this programs data and tracks CPI nesting', () => {
    const trade = decodeEvent(hex(samples.events.Trade.hex)) as GgEvent;
    const merged = decodeEvent(hex(samples.events.Merged.hex)) as GgEvent;
    const pid = PROGRAM_ID.toBase58();
    const other = '11111111111111111111111111111111';
    const b64 = (e: GgEvent) => Buffer.from(encodeEvent(e)).toString('base64');
    const logs = [
      `Program ${other} invoke [1]`,
      `Program data: ${b64(merged)}`, // same bytes but foreign program: ignored
      `Program ${other} success`,
      `Program ${pid} invoke [1]`,
      'Program log: Instruction: Buy',
      `Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]`,
      `Program data: ${b64(merged)}`, // emitted inside a CPI: ignored
      `Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success`,
      `Program data: ${b64(trade)}`,
      `Program data: AAAAAAAAAAAA`, // unknown discriminator: ignored
      `Program ${pid} consumed 1000 of 200000 compute units`,
      `Program ${pid} success`,
    ];
    const events = parseEventsFromLogs(logs);
    expect(events.map((e) => e.name)).toEqual(['Trade']);
    expect(events[0]!.data).toEqual(trade.data);
  });
  it('a failed invocation pops the stack', () => {
    const merged = decodeEvent(hex(samples.events.Merged.hex)) as GgEvent;
    const pid = PROGRAM_ID.toBase58();
    const logs = [
      `Program ${pid} invoke [1]`,
      `Program ${pid} failed: custom program error: 0x1770`,
      `Program ${pid} invoke [1]`,
      `Program data: ${Buffer.from(encodeEvent(merged)).toString('base64')}`,
      `Program ${pid} success`,
    ];
    expect(parseEventsFromLogs(logs).map((e) => e.name)).toEqual(['Merged']);
  });
  it('encodeEventLogs round-trips', () => {
    const evs = ['Trade', 'Settled', 'Redeemed'].map((n) => decodeEvent(hex((samples.events as any)[n].hex)) as GgEvent);
    expect(parseEventsFromLogs(encodeEventLogs(evs))).toEqual(evs);
  });
});
