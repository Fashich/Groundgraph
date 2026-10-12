/**
 * Integer AMM math, bit-identical to programs/groundgraph/src/math.rs.
 * Parity is enforced by test/vectors.json (generated from the Rust implementation).
 */
import type { Side } from './api-types';
import { MAX_RESERVE, P0_MAX_BPS, P0_MIN_BPS } from './constants';

export interface Pool {
  reserveAbove: bigint;
  reserveBelow: bigint;
}

/** Mirrors the Rust `MathError` variants; `code` is the variant name. */
export type MathErrorCode =
  | 'Overflow'
  | 'ZeroAmount'
  | 'ReserveEmpty'
  | 'ReserveTooLarge'
  | 'InvalidP0'
  | 'SellRootFailed'
  | 'ExponentOutOfRange';

export class GgMathError extends Error {
  readonly code: MathErrorCode;
  constructor(code: MathErrorCode) {
    super(code);
    this.name = 'GgMathError';
    this.code = code;
  }
}

const BPS = 10_000n;
const U64_MAX = (1n << 64n) - 1n;
const NEAR_WINDOW = 72 * 3_600;
const NEAR_MAX_BPS = 80;
const FLOW_MAX_BPS = 50;
const EMA_HALF_LIFE = 1_800n;
const EMA_ONE = 65_536n;

function u64(v: bigint): bigint {
  if (v < 0n || v > U64_MAX) throw new GgMathError('Overflow');
  return v;
}

/** `ceil(amount * feeBps / 10_000)`: fees round up in favor of the pool. */
export function feeCeil(amount: bigint, feeBps: number): bigint {
  const f = (u64(amount) * BigInt(feeBps) + (BPS - 1n)) / BPS;
  return u64(f);
}

/** Price of ABOVE in basis points: `rb * 10_000 / (ra + rb)` (floor). */
export function priceBps(p: Pool): number {
  const sum = p.reserveAbove + p.reserveBelow;
  if (sum === 0n) return 0;
  return Number((p.reserveBelow * BPS) / sum);
}

/** Price of one ABOVE share in USDC (0..1). BELOW is `1 - priceAbove`. */
export function priceAbove(p: Pool): number {
  return priceBps(p) / 10_000;
}

export function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  const bits = BigInt(n.toString(2).length);
  let x = 1n << ((bits + 1n) / 2n);
  for (;;) {
    const y = (x + n / x) / 2n;
    if (y >= x) return x;
    x = y;
  }
}

export function ceilSqrt(n: bigint): bigint {
  const r = isqrt(n);
  return r * r === n ? r : r + 1n;
}

export function impactBps(before: Pool, after: Pool): number {
  return Math.abs(priceBps(after) - priceBps(before));
}

export interface BuyQuote {
  sharesOut: bigint;
  feeUsdc: bigint;
  usdcIntoSets: bigint;
  poolAfter: Pool;
  priceBefore: number;
  priceAfter: number;
  avgPrice: number;
  priceImpactBps: number;
}

/**
 * Buy `side` with `usdcIn` base units. Fixed product over the virtual reserves, fee on the way in.
 * Buying ABOVE: `rb' = rb + x'`, `ra' = ceil(ra * rb / rb')`, `shares = ra + x' - ra'`.
 */
export function quoteBuy(pool: Pool, side: Side, usdcIn: bigint, feeBps: number): BuyQuote {
  if (usdcIn === 0n) throw new GgMathError('ZeroAmount');
  u64(usdcIn);
  const { reserveAbove: ra, reserveBelow: rb } = pool;
  if (ra === 0n || rb === 0n) throw new GgMathError('ReserveEmpty');
  const fee = feeCeil(usdcIn, feeBps);
  const x = usdcIn - fee;
  if (x < 0n) throw new GgMathError('Overflow');
  const [rBuy, rOther] = side === 'above' ? [ra, rb] : [rb, ra];
  const rOtherAfter = rOther + x;
  if (rOtherAfter >= MAX_RESERVE) throw new GgMathError('ReserveTooLarge');
  const k = rBuy * rOther;
  const rBuyAfter = (k + rOtherAfter - 1n) / rOtherAfter;
  const sharesOut = u64(rBuy + x - rBuyAfter);
  const poolAfter: Pool =
    side === 'above' ? { reserveAbove: rBuyAfter, reserveBelow: rOtherAfter } : { reserveAbove: rOtherAfter, reserveBelow: rBuyAfter };
  return {
    sharesOut,
    feeUsdc: fee,
    usdcIntoSets: x,
    poolAfter,
    priceBefore: priceAbove(pool),
    priceAfter: priceAbove(poolAfter),
    avgPrice: sharesOut > 0n ? Number(usdcIn) / Number(sharesOut) : 0,
    priceImpactBps: impactBps(pool, poolAfter),
  };
}

export interface SellQuote {
  usdcGross: bigint;
  usdcOut: bigint;
  feeUsdc: bigint;
  poolAfter: Pool;
  priceBefore: number;
  priceAfter: number;
  avgPrice: number;
  priceImpactBps: number;
}

/**
 * Sell `sharesIn` of `side`. The pool receives `s` and burns `y` complete sets keeping `k = ra * rb`:
 * `y^2 - (r_sold + s + r_other) y + s * r_other >= 0`, smaller root, `y = floor((b - ceilSqrt(b^2 - 4c)) / 2)`.
 */
export function quoteSell(pool: Pool, side: Side, sharesIn: bigint, feeBps: number): SellQuote {
  if (sharesIn === 0n) throw new GgMathError('ZeroAmount');
  u64(sharesIn);
  const { reserveAbove: ra, reserveBelow: rb } = pool;
  if (ra === 0n || rb === 0n) throw new GgMathError('ReserveEmpty');
  if (sharesIn >= MAX_RESERVE || ra >= MAX_RESERVE || rb >= MAX_RESERVE) throw new GgMathError('ReserveTooLarge');
  const [rSold, rOther] = side === 'above' ? [ra, rb] : [rb, ra];
  const s = sharesIn;
  const k = rSold * rOther;
  const b = rSold + s + rOther;
  const c = s * rOther;
  const disc = b * b - 4n * c;
  const root = ceilSqrt(disc);
  let y = (b - root) / 2n;
  let guard = 0;
  while ((rSold + s - y) * (rOther - y) < k) {
    if (y === 0n || guard >= 4) throw new GgMathError('SellRootFailed');
    y -= 1n;
    guard += 1;
  }
  const usdcGross = u64(y);
  const fee = feeCeil(usdcGross, feeBps);
  const out = usdcGross - fee;
  const rSoldAfter = rSold + s - y;
  const rOtherAfter = rOther - y;
  if (rSoldAfter >= MAX_RESERVE) throw new GgMathError('ReserveTooLarge');
  const poolAfter: Pool =
    side === 'above' ? { reserveAbove: rSoldAfter, reserveBelow: rOtherAfter } : { reserveAbove: rOtherAfter, reserveBelow: rSoldAfter };
  return {
    usdcGross,
    usdcOut: out,
    feeUsdc: fee,
    poolAfter,
    priceBefore: priceAbove(pool),
    priceAfter: priceAbove(poolAfter),
    avgPrice: Number(out) / Number(s),
    priceImpactBps: impactBps(pool, poolAfter),
  };
}

export interface SeedResult {
  reserveAbove: bigint;
  reserveBelow: bigint;
  creatorAbove: bigint;
  creatorBelow: bigint;
}

/**
 * Initial reserves for a market opened at fair ABOVE price `p0Bps` with `liquidity` base units.
 * p0 < 50%: `ra = L`, `rb = floor(L p0 / (1 - p0))`, creator keeps `L - rb` BELOW. Mirrored for p0 >= 50%.
 */
export function seedReserves(liquidity: bigint, p0Bps: number): SeedResult {
  if (!Number.isInteger(p0Bps) || p0Bps < P0_MIN_BPS || p0Bps > P0_MAX_BPS) throw new GgMathError('InvalidP0');
  if (liquidity >= MAX_RESERVE) throw new GgMathError('ReserveTooLarge');
  if (liquidity < 0n) throw new GgMathError('Overflow');
  const p = BigInt(p0Bps);
  if (p0Bps < 5_000) {
    const rb = (liquidity * p) / (BPS - p);
    if (rb === 0n || liquidity === 0n) throw new GgMathError('ReserveEmpty');
    return { reserveAbove: liquidity, reserveBelow: rb, creatorAbove: 0n, creatorBelow: liquidity - rb };
  }
  const ra = (liquidity * (BPS - p)) / p;
  if (ra === 0n || liquidity === 0n) throw new GgMathError('ReserveEmpty');
  return { reserveAbove: ra, reserveBelow: liquidity, creatorAbove: liquidity - ra, creatorBelow: 0n };
}

/** `amountOut * (10_000 - slippageBps) / 10_000`, floor. Use for min-out bounds on the client. */
export function applySlippage(amountOut: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) throw new RangeError('slippageBps must be 0..10000');
  return (amountOut * (BPS - BigInt(slippageBps))) / BPS;
}

export interface FeeState {
  baseFeeBps: number;
  dynamicFee: boolean;
  emaImpactBps: number;
  emaTs: number;
  settleTs: number;
  maxFeeBps: number;
}

/** "Near expiry" component: 0 bps 72h out, ramping to 80 bps at settle time. */
export function nearFeeBps(settleTs: number, nowTs: number): number {
  const remaining = Math.min(Math.max(settleTs - nowTs, 0), NEAR_WINDOW);
  return Math.floor((NEAR_MAX_BPS * (NEAR_WINDOW - remaining)) / NEAR_WINDOW);
}

/** "Recent flow" component from the decayed EMA: `clamp(ema / 4, 0, 50)`. */
export function flowFeeBps(emaImpactBps: number): number {
  return Math.min(Math.floor(emaImpactBps / 4), FLOW_MAX_BPS);
}

/**
 * EMA of price impact with a 30 minute half-life (16 fractional bits):
 * `decay = (65536 >> min(n, 16)) * (3600 - rem) / 3600`, `ema' = (ema * decay + impact * (65536 - decay)) >> 16`.
 */
export function updateEma(emaImpactBps: number, emaTs: number, impactBpsNow: number, nowTs: number): number {
  const dt = nowTs > emaTs ? BigInt(nowTs - emaTs) : 0n;
  const n = dt / EMA_HALF_LIFE;
  const rem = dt % EMA_HALF_LIFE;
  const shift = n < 16n ? n : 16n;
  const decay = ((EMA_ONE >> shift) * (2n * EMA_HALF_LIFE - rem)) / (2n * EMA_HALF_LIFE);
  return Number(((BigInt(emaImpactBps) * decay + BigInt(impactBpsNow) * (EMA_ONE - decay)) >> 16n) & 0xffff_ffffn);
}

/** Fee in effect for a trade at `nowTs`, computed from the EMA before the trade (decayed to `nowTs`). */
export function feeBpsNow(f: FeeState, nowTs: number): { totalBps: number; baseBps: number; nearBps: number; flowBps: number } {
  if (!f.dynamicFee) return { totalBps: f.baseFeeBps, baseBps: f.baseFeeBps, nearBps: 0, flowBps: 0 };
  const near = nearFeeBps(f.settleTs, nowTs);
  const flow = flowFeeBps(updateEma(f.emaImpactBps, f.emaTs, 0, nowTs));
  const total = Math.min(f.baseFeeBps + near + flow, f.maxFeeBps);
  return { totalBps: total, baseBps: f.baseFeeBps, nearBps: near, flowBps: flow };
}

/** LP claim at settlement: the pool's remaining virtual tokens of the winning side plus the fee pool. */
export function settledLpClaim(aboveWon: boolean, pool: Pool, feePool: bigint): bigint {
  return u64((aboveWon ? pool.reserveAbove : pool.reserveBelow) + feePool);
}

/** LP claim for a voided market: `(N + fees) - ceil((realA + realB) / 2)`. */
export function voidLpClaim(completeSets: bigint, pool: Pool, feePool: bigint): bigint {
  const realA = completeSets - pool.reserveAbove;
  const realB = completeSets - pool.reserveBelow;
  if (realA < 0n || realB < 0n) throw new GgMathError('Overflow');
  const owed = (realA + realB + 1n) / 2n;
  const claim = completeSets + feePool - owed;
  if (claim < 0n) throw new GgMathError('Overflow');
  return u64(claim);
}

/** USDC paid for `amount` shares of either side in a voided market (0.5 USDC each, floor). */
export function voidRedeemPayout(amount: bigint): bigint {
  return amount / 2n;
}

/** `floor(claim * lpAmount / lpSupply)`. */
export function lpPayout(claimRemaining: bigint, lpAmount: bigint, lpSupplyRemaining: bigint): bigint {
  if (lpSupplyRemaining === 0n) throw new GgMathError('ZeroAmount');
  return u64((claimRemaining * lpAmount) / lpSupplyRemaining);
}

/** Compare `price * 10^expo` to `target * 10^targetExpo` exactly. Returns -1, 0 or 1. */
export function comparePrice(price: bigint, expo: number, target: bigint, targetExpo: number): -1 | 0 | 1 {
  let lhs: bigint;
  let rhs: bigint;
  if (expo >= targetExpo) {
    const diff = expo - targetExpo;
    if (diff > 18) throw new GgMathError('ExponentOutOfRange');
    lhs = price * 10n ** BigInt(diff);
    rhs = target;
  } else {
    const diff = targetExpo - expo;
    if (diff > 18) throw new GgMathError('ExponentOutOfRange');
    lhs = price;
    rhs = target * 10n ** BigInt(diff);
  }
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}

/** `conf * 10_000 <= maxConfBps * price` for a positive price. */
export function confidenceOk(conf: bigint, price: bigint, maxConfBps: number): boolean {
  if (price <= 0n) return false;
  return conf * BPS <= BigInt(maxConfBps) * price;
}
