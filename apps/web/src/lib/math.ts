/**
 * Small client-side estimates used by the create-market form. Quotes and fair value come from the API
 * (identical to the program math); these only drive the live hints that need no round trip.
 */

/** Opening reserves of a pool seeded with `liquidity` complete sets at ABOVE probability p0. */
export function seedReserves(liquidity: number, p0: number): { ra: number; rb: number } {
  const p = Math.min(0.98, Math.max(0.02, p0));
  if (p < 0.5) return { ra: liquidity, rb: (liquidity * p) / (1 - p) };
  return { rb: liquidity, ra: (liquidity * (1 - p)) / p };
}

/** Price move in cents caused by buying `usdc` of ABOVE from a freshly seeded pool (fee ignored). */
export function impactCents(liquidity: number, p0: number, usdc: number): number {
  if (liquidity <= 0) return 100;
  const { ra, rb } = seedReserves(liquidity, p0);
  const k = ra * rb;
  const rb2 = rb + usdc;
  const ra2 = k / rb2;
  const p1 = rb2 / (ra2 + rb2);
  const before = rb / (ra + rb);
  return Math.max(0, (p1 - before) * 100);
}

export function depthLevel(moveCents: number): 1 | 2 | 3 {
  return moveCents > 10 ? 1 : moveCents > 3 ? 2 : 3;
}

/** Expected arbitrage loss when opening at 50/50 while the model fair value is pStar: L * (1 - 2 sqrt(p(1-p))). */
export function arbLoss(liquidity: number, pStar: number): number {
  const p = Math.min(0.99, Math.max(0.01, pStar));
  return liquidity * Math.max(0, 1 - 2 * Math.sqrt(p * (1 - p)));
}

/** Round an opening price to whole cents inside the program bounds (2..98). */
export function roundOpen(p: number): number {
  return Math.max(0.02, Math.min(0.98, Math.round(p * 100) / 100));
}
