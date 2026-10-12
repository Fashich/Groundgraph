/**
 * Local (off-chain) simulation of trades against a decoded market, using exactly the fee and bookkeeping rules of the
 * program: the fee is computed from the EMA decayed to `nowTs`, and a dynamic-fee market folds the trade's price
 * impact into the EMA afterwards.
 */
import type { Side } from './api-types';
import type { MarketAccount } from './accounts';
import { marketFeeState, marketPool } from './accounts';
import { feeBpsNow, impactBps, quoteBuy, quoteSell, updateEma, type BuyQuote, type SellQuote } from './math';

export interface FeeBreakdown {
  totalBps: number;
  baseBps: number;
  nearBps: number;
  flowBps: number;
}

export interface SimulatedBuy {
  quote: BuyQuote;
  fee: FeeBreakdown;
  marketAfter: MarketAccount;
}
export interface SimulatedSell {
  quote: SellQuote;
  fee: FeeBreakdown;
  marketAfter: MarketAccount;
}

function afterPool(m: MarketAccount, poolAfter: { reserveAbove: bigint; reserveBelow: bigint }, nowTs: number): Pick<MarketAccount, 'reserveAbove' | 'reserveBelow' | 'emaImpactBps' | 'emaTs'> {
  if (!m.dynamicFee) return { ...poolAfter, emaImpactBps: m.emaImpactBps, emaTs: m.emaTs };
  const impact = impactBps(marketPool(m), poolAfter);
  return { ...poolAfter, emaImpactBps: updateEma(m.emaImpactBps, Number(m.emaTs), impact, nowTs), emaTs: BigInt(nowTs) };
}

export function simulateBuy(m: MarketAccount, maxFeeBps: number, side: Side, usdcIn: bigint, nowTs: number): SimulatedBuy {
  const fee = feeBpsNow(marketFeeState(m, maxFeeBps), nowTs);
  const quote = quoteBuy(marketPool(m), side, usdcIn, fee.totalBps);
  const marketAfter: MarketAccount = {
    ...m,
    completeSets: m.completeSets + quote.usdcIntoSets,
    feePool: m.feePool + quote.feeUsdc,
    ...afterPool(m, quote.poolAfter, nowTs),
  };
  return { quote, fee, marketAfter };
}

export function simulateSell(m: MarketAccount, maxFeeBps: number, side: Side, sharesIn: bigint, nowTs: number): SimulatedSell {
  const fee = feeBpsNow(marketFeeState(m, maxFeeBps), nowTs);
  const quote = quoteSell(marketPool(m), side, sharesIn, fee.totalBps);
  const marketAfter: MarketAccount = {
    ...m,
    completeSets: m.completeSets - quote.usdcGross,
    feePool: m.feePool + quote.feeUsdc,
    ...afterPool(m, quote.poolAfter, nowTs),
  };
  return { quote, fee, marketAfter };
}
