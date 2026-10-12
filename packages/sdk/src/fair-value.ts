/** Fair value (digital option, zero drift) and related helpers. Floating point, not consensus-critical. */

/** Standard normal CDF, double precision (Hart 1968 / West 2005 rational approximation, |error| < 1e-15). */
export function normCdf(x: number): number {
  const xabs = Math.abs(x);
  let c: number;
  if (xabs > 37) {
    c = 0;
  } else {
    const e = Math.exp((-xabs * xabs) / 2);
    if (xabs < 7.07106781186547) {
      let b = 3.52624965998911e-2 * xabs + 0.700383064443688;
      b = b * xabs + 6.37396220353165;
      b = b * xabs + 33.912866078383;
      b = b * xabs + 112.079291497871;
      b = b * xabs + 221.213596169931;
      b = b * xabs + 220.206867912376;
      c = e * b;
      let d = 8.83883476483184e-2 * xabs + 1.75566716318264;
      d = d * xabs + 16.064177579207;
      d = d * xabs + 86.7807322029461;
      d = d * xabs + 296.564248779674;
      d = d * xabs + 637.333633378831;
      d = d * xabs + 793.826512519948;
      d = d * xabs + 440.413735824752;
      c = c / d;
    } else {
      let b = xabs + 0.65;
      b = xabs + 4 / b;
      b = xabs + 3 / b;
      b = xabs + 2 / b;
      b = xabs + 1 / b;
      c = e / b / 2.506628274631;
    }
  }
  return x > 0 ? 1 - c : c;
}

/**
 * Close market: `P(ABOVE) = N(d2)`, `d2 = (ln(S/K) - 0.5 sigma^2 T) / (sigma sqrt(T))`.
 * With no time or no volatility left the answer is the step function of spot vs strike.
 */
export function fairValueClose(spot: number, strike: number, volAnnual: number, yearsToSettle: number): number {
  if (!(spot > 0) || !(strike > 0)) throw new RangeError('spot and strike must be positive');
  if (yearsToSettle <= 0 || volAnnual <= 0) return spot > strike ? 1 : 0;
  const sd = volAnnual * Math.sqrt(yearsToSettle);
  const d2 = (Math.log(spot / strike) - 0.5 * volAnnual * volAnnual * yearsToSettle) / sd;
  return normCdf(d2);
}

/**
 * Touch market (Phase 2): `Up`: `min(0.99, 2 (1 - N(|ln(K/S)| / (sigma sqrt T))))`; `Down` is the complement.
 */
export function fairValueTouch(spot: number, strike: number, volAnnual: number, yearsToSettle: number, direction: 'up' | 'down'): number {
  if (!(spot > 0) || !(strike > 0)) throw new RangeError('spot and strike must be positive');
  const sd = volAnnual * Math.sqrt(Math.max(yearsToSettle, 1e-12));
  const pTouch = sd > 0 ? Math.min(0.99, 2 * (1 - normCdf(Math.abs(Math.log(strike / spot)) / sd))) : spot === strike ? 0.99 : 0;
  return direction === 'up' ? pTouch : 1 - pTouch;
}

/**
 * Expected arbitrage loss of the liquidity provider when a market opens at 50/50 although the fair price is `pStar`:
 * `L * (1 - 2 sqrt(p* (1 - p*)))`, in base units.
 */
export function expectedArbLossUsdc(liquidity: bigint, pStar: number): bigint {
  const p = Math.min(Math.max(pStar, 0), 1);
  const f = 1 - 2 * Math.sqrt(p * (1 - p));
  return BigInt(Math.round(Number(liquidity) * f));
}

/** A share price in USDC (0..1) is the market-implied probability of that outcome. */
export function impliedProbability(price: number): number {
  return Math.min(Math.max(price, 0), 1);
}

/** Annualized realized volatility from a series of closes (log returns, sample std, `periodsPerYear` e.g. 365 for daily). */
export function realizedVol(closes: number[], periodsPerYear = 365): number {
  if (closes.length < 3) return 0;
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1]!;
    const b = closes[i]!;
    if (a > 0 && b > 0) r.push(Math.log(b / a));
  }
  if (r.length < 2) return 0;
  const mean = r.reduce((s, v) => s + v, 0) / r.length;
  const variance = r.reduce((s, v) => s + (v - mean) ** 2, 0) / (r.length - 1);
  return Math.sqrt(variance * periodsPerYear);
}

/** Opening price in basis points for the program, clamped to the allowed [200, 9800] range. */
export function toOpeningBps(pAbove: number): number {
  return Math.min(9_800, Math.max(200, Math.round(pAbove * 10_000)));
}
