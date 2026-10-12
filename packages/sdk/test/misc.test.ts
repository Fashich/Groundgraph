import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  DEVNET_DEPLOYMENT,
  IDL,
  PRICE_UPDATE_V2_DISCRIMINATOR,
  PRICE_UPDATE_V2_SIZE,
  PROGRAM_ID,
  PYTH_FEEDS,
  decodePriceUpdateV2,
  encodePriceUpdateV2,
  feedIdFromHex,
  programErrorName,
  pythPushFeedAddress,
  decodeDefined,
  encodeDefined,
  BorshReader,
  BorshWriter,
} from '../src/index';

describe('IDL copy', () => {
  it('is identical to the program build output', () => {
    const here = readFileSync(resolve(__dirname, '../src/idl/groundgraph.json'), 'utf8');
    const prog = readFileSync(resolve(__dirname, '../../../programs/groundgraph/idl/groundgraph.json'), 'utf8');
    expect(here).toBe(prog);
  });
  it('lists the program errors', () => {
    expect(programErrorName(6000)).toBe('Paused');
    expect(IDL.errors.length).toBeGreaterThanOrEqual(40);
    expect(programErrorName(1)).toBeUndefined();
  });
});

describe('deployment record', () => {
  it('PROGRAM_ID defaults to the devnet deployment unless overridden', () => {
    if (process.env.PROGRAM_ID) expect(PROGRAM_ID.toBase58()).toBe(process.env.PROGRAM_ID);
    else expect(PROGRAM_ID.toBase58()).toBe(DEVNET_DEPLOYMENT.programId);
    expect(DEVNET_DEPLOYMENT.programId).toBe(IDL.address);
  });
});

describe('Pyth push feed addresses', () => {
  // Verified against the devnet RPC: these accounts exist, are owned by the receiver program and embed the feed id.
  const verified: Record<string, string> = {
    SOL: '7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE',
    BTC: '4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo',
    ETH: '42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC',
    JUP: '7dbob1psH1iZBS7qPsm3Kwbf5DzSXK8Jyg31CTgTnxH5',
    WIF: '6B23K3tkb51vLZA14jcEQVCA1pfHptzEHFA93V5dYwbT',
    BONK: 'DBE3N8uNjhKPRHfANdwGvCZghWXyLPdqdSbEW2XFwBiX',
  };
  it.each(Object.entries(verified))('%s shard 0', (sym, addr) => {
    expect(pythPushFeedAddress(PYTH_FEEDS[sym]!.feedIdHex, 0).toBase58()).toBe(addr);
  });
});

describe('PriceUpdateV2', () => {
  const sample = {
    writeAuthority: Keypair.generate().publicKey,
    verification: { level: 'full' as const },
    feedId: feedIdFromHex(PYTH_FEEDS.SOL!.feedIdHex),
    price: 25_100_000_000n,
    conf: 12_000n,
    exponent: -8,
    publishTime: 1_800_086_412n,
    prevPublishTime: 1_800_086_411n,
    emaPrice: 25_000_000_000n,
    emaConf: 15_000n,
    postedSlot: 123_456n,
  };
  it('round-trips and is allocated at 134 bytes', () => {
    const bytes = encodePriceUpdateV2(sample);
    expect(bytes.length).toBe(PRICE_UPDATE_V2_SIZE);
    expect(Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from(PRICE_UPDATE_V2_DISCRIMINATOR))).toBe(true);
    expect(decodePriceUpdateV2(bytes)).toEqual(sample);
  });
  it('encodes Partial verification with a signature count', () => {
    const p = { ...sample, verification: { level: 'partial' as const, numSignatures: 3 } };
    const bytes = encodePriceUpdateV2(p);
    expect(bytes[8 + 32]).toBe(0);
    expect(bytes[8 + 32 + 1]).toBe(3);
    expect(decodePriceUpdateV2(bytes)).toEqual(p);
  });
  it('rejects foreign accounts', () => {
    expect(() => decodePriceUpdateV2(new Uint8Array(134))).toThrow();
  });
  it('field offsets match the full encoding documented by Pyth', () => {
    const b = encodePriceUpdateV2(sample);
    const off = 8 + 32 + 1; // price_message starts here for the Full variant
    expect(Buffer.from(b.subarray(off, off + 32)).toString('hex')).toBe(PYTH_FEEDS.SOL!.feedIdHex);
    expect(b.readBigInt64LE(off + 32)).toBe(sample.price);
    expect(b.readBigUInt64LE(off + 40)).toBe(sample.conf);
    expect(b.readInt32LE(off + 48)).toBe(-8);
    expect(b.readBigInt64LE(off + 52)).toBe(sample.publishTime);
    expect(b.readBigUInt64LE(off + 84)).toBe(sample.postedSlot);
  });
});

describe('borsh codec', () => {
  it('rejects values out of range', () => {
    expect(() => encodeDefined('Redeemed', { market: Keypair.generate().publicKey, wallet: Keypair.generate().publicKey, side: 'above', shares: 1n << 64n, usdc: 0n })).toThrow(RangeError);
    expect(() => encodeDefined('Trade', { side: 'maybe' })).toThrow();
  });
  it('reads and writes primitives symmetrically', () => {
    const w = new BorshWriter().u8(255).i8(-5).u16(65535).i16(-3).u32(4_000_000_000).i32(-2_000_000_000).u64((1n << 64n) - 1n).i64(-(1n << 63n)).u128((1n << 128n) - 1n).i128(-(1n << 127n)).bool(true).string('héllo');
    const r = new BorshReader(w.done());
    expect([r.u8(), r.i8(), r.u16(), r.i16(), r.u32(), r.i32(), r.u64(), r.i64(), r.u128(), r.i128(), r.bool(), r.string()]).toEqual([
      255, -5, 65535, -3, 4_000_000_000, -2_000_000_000, (1n << 64n) - 1n, -(1n << 63n), (1n << 128n) - 1n, -(1n << 127n), true, 'héllo',
    ]);
    expect(() => r.u8()).toThrow(RangeError);
  });
  it('decodes unit enums as lowercase names and rejects bad tags', () => {
    expect(decodeDefined('Side', Uint8Array.from([1]))).toBe('below');
    expect(() => decodeDefined('Side', Uint8Array.from([2]))).toThrow(RangeError);
    expect(decodeDefined('VerificationLevel', Uint8Array.from([0, 2]))).toEqual({ variant: 'partial', numSignatures: 2 });
    expect(decodeDefined('VerificationLevel', Uint8Array.from([1]))).toBe('full');
  });
  it('PublicKey fields round-trip', () => {
    const k = Keypair.generate().publicKey;
    const bytes = encodeDefined('Merged', { market: k, wallet: k, amount: 5n });
    const back = decodeDefined<{ market: PublicKey; amount: bigint }>('Merged', bytes);
    expect(back.market.equals(k)).toBe(true);
    expect(back.amount).toBe(5n);
  });
});
