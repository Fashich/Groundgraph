/** The landing page hedge illustration. Every number is computed from the assumed inputs below, none is live data. */
export interface HedgeInputs {
  symbol: string;
  qty: number;
  spot: number;
  strike: number;
  shock: number;
  belowPrice: number;
  shares: number;
}

export const HEDGE_DEFAULT: HedgeInputs = { symbol: 'SOL', qty: 10, spot: 214.3, strike: 180, shock: 175, belowPrice: 0.08, shares: 300 };

export function hedgeExample(i: HedgeInputs = HEDGE_DEFAULT) {
  const holdValue = i.qty * i.spot;
  const cost = i.shares * i.belowPrice;
  const holdingsLoss = i.qty * (i.spot - i.shock);
  const positionGain = i.shares * (1 - i.belowPrice);
  return {
    holdValue,
    cost,
    holdingsLoss,
    positionGain,
    netWithHedge: positionGain - holdingsLoss,
    netWithout: -holdingsLoss,
    netIfHolds: -cost,
  };
}
