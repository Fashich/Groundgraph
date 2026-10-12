/**
 * Constant-product outcome-token pool (two outcomes), bigint math, 6 decimal units.
 * Price of ABOVE = rb / (ra + rb). Buying side S with net USDC n mints n complete sets, then removes S shares so the
 * product ra * rb is unchanged. This is a mock: it follows the same rules as the on-chain program in spirit only.
 */
export type Side = 'above' | 'below';

export interface Pool {
  ra: bigint;
  rb: bigint;
}

export const ONE = 1_000_000n;

export function priceAbove(p: Pool): number {
  const t = p.ra + p.rb;
  return t === 0n ? 0.5 : Number(p.rb) / Number(t);
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

export interface BuyResult {
  shares: bigint;
  fee: bigint;
  pool: Pool;
}

export function buy(p: Pool, side: Side, usdc: bigint, feeBps: number): BuyResult {
  const fee = (usdc * BigInt(feeBps)) / 10000n;
  const net = usdc - fee;
  const k = p.ra * p.rb;
  if (side === 'above') {
    const rb1 = p.rb + net;
    const ra1 = ceilDiv(k, rb1);
    return { shares: p.ra + net - ra1, fee, pool: { ra: ra1, rb: rb1 } };
  }
  const ra1 = p.ra + net;
  const rb1 = ceilDiv(k, ra1);
  return { shares: p.rb + net - rb1, fee, pool: { ra: ra1, rb: rb1 } };
}

export interface SellResult {
  usdcOut: bigint;
  fee: bigint;
  gross: bigint;
  pool: Pool;
}

/** Sell `shares` of `side` back to the pool. The pool pays USDC by burning complete sets. */
export function sell(p: Pool, side: Side, shares: bigint, feeBps: number): SellResult {
  const own = side === 'above' ? p.ra : p.rb;
  const other = side === 'above' ? p.rb : p.ra;
  // r^2 - (own + s + other) r + s * other = 0
  const b = own + shares + other;
  const disc = b * b - 4n * shares * other;
  const r = (b - isqrt(disc)) / 2n;
  const gross = r > other ? other : r;
  const fee = (gross * BigInt(feeBps)) / 10000n;
  const ownNew = own + shares - gross;
  const otherNew = other - gross;
  const pool = side === 'above' ? { ra: ownNew, rb: otherNew } : { ra: otherNew, rb: ownNew };
  return { usdcOut: gross - fee, fee, gross, pool };
}

export function merge(p: Pool, amount: bigint): Pool {
  return { ra: p.ra - amount, rb: p.rb - amount };
}

export function seedPool(liquidity: bigint, p0: number): Pool {
  const p = Math.min(0.98, Math.max(0.02, p0));
  const num = BigInt(Math.round(p * 1e6));
  const den = 1_000_000n;
  // price = rb / (ra + rb) => rb / ra = p / (1 - p)
  if (p < 0.5) return { ra: liquidity, rb: (liquidity * num) / (den - num) };
  return { rb: liquidity, ra: (liquidity * (den - num)) / num };
}
