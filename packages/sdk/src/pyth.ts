/**
 * Pyth `PriceUpdateV2` account helpers. `settle_close` accepts any PriceUpdateV2 account owned by the Pyth receiver
 * program that is fully verified, so a keeper can pass either a freshly posted update or a sponsored push-feed
 * account. These helpers decode such an account and build one for tests.
 */
import { PublicKey } from '@solana/web3.js';
import { BorshReader, BorshWriter, bytesEqual } from './codec';

/** Anchor discriminator of `PriceUpdateV2` (sha256("account:PriceUpdateV2")[..8]). */
export const PRICE_UPDATE_V2_DISCRIMINATOR = Uint8Array.from([34, 241, 35, 99, 157, 126, 244, 205]);
/** Allocated size of a PriceUpdateV2 account (room for the larger `Partial` encoding). */
export const PRICE_UPDATE_V2_SIZE = 134;

export interface PriceUpdateV2 {
  writeAuthority: PublicKey;
  /** `full` or the number of guardian signatures when partially verified. */
  verification: { level: 'full' } | { level: 'partial'; numSignatures: number };
  feedId: Uint8Array;
  price: bigint;
  conf: bigint;
  exponent: number;
  publishTime: bigint;
  prevPublishTime: bigint;
  emaPrice: bigint;
  emaConf: bigint;
  postedSlot: bigint;
}

export function decodePriceUpdateV2(data: Uint8Array): PriceUpdateV2 {
  if (data.length < 8 || !bytesEqual(data.subarray(0, 8), PRICE_UPDATE_V2_DISCRIMINATOR)) {
    throw new Error('not a PriceUpdateV2 account');
  }
  const r = new BorshReader(data.subarray(8));
  const writeAuthority = r.pubkey();
  const tag = r.u8();
  const verification = tag === 1 ? ({ level: 'full' } as const) : ({ level: 'partial', numSignatures: r.u8() } as const);
  if (tag > 1) throw new RangeError('invalid verification level');
  return {
    writeAuthority,
    verification,
    feedId: r.take(32),
    price: r.i64(),
    conf: r.u64(),
    exponent: r.i32(),
    publishTime: r.i64(),
    prevPublishTime: r.i64(),
    emaPrice: r.i64(),
    emaConf: r.u64(),
    postedSlot: r.u64(),
  };
}

/** Serialize a PriceUpdateV2 account body, zero-padded to the allocated size. */
export function encodePriceUpdateV2(p: PriceUpdateV2): Buffer {
  const w = new BorshWriter();
  w.raw(PRICE_UPDATE_V2_DISCRIMINATOR).pubkey(p.writeAuthority);
  if (p.verification.level === 'full') w.u8(1);
  else w.u8(0).u8(p.verification.numSignatures);
  w.raw(p.feedId).i64(p.price).u64(p.conf).i32(p.exponent).i64(p.publishTime).i64(p.prevPublishTime).i64(p.emaPrice).u64(p.emaConf).u64(p.postedSlot);
  const body = w.done();
  const out = Buffer.alloc(Math.max(PRICE_UPDATE_V2_SIZE, body.length));
  out.set(body);
  return out;
}
