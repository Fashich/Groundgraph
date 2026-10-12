import { numericToBigInt } from '@groundgraph/svc-core';
import {
  applySlippage,
  feeBpsNow,
  MIN_TRADE_USDC,
  priceAbove,
  quoteBuy,
  quoteSell,
  type ChainConfig,
  type ChainMarket,
  type FeeState,
  type Pool,
} from '@groundgraph/svc-core';
import type { Quote, Side, TradeDir } from '@groundgraph/sdk/api-types';
import type { AppContext } from '../context';
import { ApiHttpError } from '../errors';
import { feeStateOf, getMarketRow, MAX_FEE_BPS } from './markets';

/** Smallest gross USDC a sell may release (0.01 USDC), mirrors MIN_SELL_GROSS_USDC in the program. */
export const MIN_SELL_GROSS_USDC = 10_000n;

export interface MarketState {
  id: string;
  pool: Pool;
  fee: FeeState;
  status: 'open' | 'settled' | 'voided';
  tradingEndTs: number;
  settleTs: number;
  feedIdHex: string;
  source: 'chain' | 'db';
  chain: ChainMarket | null;
}

/**
 * Authoritative market state for quotes and transactions: the on-chain account (decoded by the SDK).
 * If the RPC is unreachable the indexer's copy in Postgres is used for READ-ONLY quotes; building a transaction
 * always requires the chain account.
 */
export async function loadMarketState(ctx: AppContext, id: string, opts: { requireChain?: boolean } = {}): Promise<MarketState | null> {
  let cfg: ChainConfig | null = null;
  try {
    const chain = await ctx.chain.getMarket(id);
    if (chain) {
      cfg = await ctx.chain.getConfig().catch(() => null);
      return {
        id,
        pool: { reserveAbove: chain.reserveAbove, reserveBelow: chain.reserveBelow },
        fee: {
          baseFeeBps: chain.baseFeeBps,
          dynamicFee: chain.dynamicFee,
          emaImpactBps: chain.emaImpactBps,
          emaTs: chain.emaTs,
          settleTs: chain.settleTs,
          maxFeeBps: cfg?.maxFeeBps ?? MAX_FEE_BPS,
        },
        status: chain.status,
        tradingEndTs: chain.tradingEndTs,
        settleTs: chain.settleTs,
        feedIdHex: chain.feedIdHex,
        source: 'chain',
        chain,
      };
    }
    if (opts.requireChain) return null;
  } catch (err) {
    if (opts.requireChain) throw new ApiHttpError('internal', 'Could not read the market from the chain, try again', undefined, 502);
    ctx.log.warn({ err, id }, 'chain read failed, using indexed state for the quote');
  }
  const row = await getMarketRow(ctx, id);
  if (!row) return null;
  return {
    id,
    pool: { reserveAbove: numericToBigInt(row.reserveAbove), reserveBelow: numericToBigInt(row.reserveBelow) },
    fee: feeStateOf(row),
    status: row.status === 'settled' ? 'settled' : row.status === 'voided' ? 'voided' : 'open',
    tradingEndTs: Math.floor(row.tradingEndTs.getTime() / 1000),
    settleTs: Math.floor(row.settleTs.getTime() / 1000),
    feedIdHex: row.feedId,
    source: 'db',
    chain: null,
  };
}

export function marketClosedFor(state: MarketState, dir: TradeDir, nowSec: number): string | null {
  if (state.status === 'settled') return 'This market has settled. Redeem winning shares from your positions.';
  if (state.status === 'voided') return 'This market was voided. Redeem your shares at $0.50 each from your positions.';
  if (dir === 'buy' && nowSec >= state.tradingEndTs) return 'Trading has ended for this market. You can still sell or merge until it settles.';
  return null;
}

export interface QuoteCalc {
  quote: Quote;
  sharesOut: bigint; // buy
  usdcOut: bigint; // sell
  usdcGross: bigint; // sell
  minOutBase: bigint;
  poolAfter: Pool;
  feeParts: { totalBps: number; baseBps: number; nearBps: number; flowBps: number };
}

const sidePriceOf = (side: Side, pool: Pool) => (side === 'above' ? priceAbove(pool) : 1 - priceAbove(pool));

/** Quote with SDK math only (identical to the program). Throws ApiHttpError for amounts the program would reject. */
export function computeQuote(state: MarketState, side: Side, dir: TradeDir, amount: bigint, slippageBps: number, nowSec: number): QuoteCalc {
  const parts = feeBpsNow(state.fee, nowSec);
  const feeBps = parts.totalBps;
  const priceBefore = sidePriceOf(side, state.pool);
  try {
    if (dir === 'buy') {
      if (amount < MIN_TRADE_USDC) throw new ApiHttpError('below_min_trade', 'The minimum trade is 1 USDC');
      const q = quoteBuy(state.pool, side, amount, feeBps);
      if (q.sharesOut <= 0n) throw new ApiHttpError('insufficient_liquidity', 'This amount buys no shares at the current price');
      const minOut = applySlippage(q.sharesOut, slippageBps);
      const priceAfter = sidePriceOf(side, q.poolAfter);
      return {
        quote: {
          marketId: state.id,
          side,
          dir,
          amountIn: amount.toString(),
          amountOut: q.sharesOut.toString(),
          minOut: minOut.toString(),
          slippageBps,
          avgPrice: Number(amount) / Number(q.sharesOut),
          priceBefore,
          priceAfter,
          priceImpactBps: Math.round(Math.abs(priceAfter - priceBefore) * 10_000),
          feeBps,
          feeUsdc: q.feeUsdc.toString(),
          settleValue: q.sharesOut.toString(),
          warnings: [],
        },
        sharesOut: q.sharesOut,
        usdcOut: 0n,
        usdcGross: 0n,
        minOutBase: minOut,
        poolAfter: q.poolAfter,
        feeParts: parts,
      };
    }
    const q = quoteSell(state.pool, side, amount, feeBps);
    if (q.usdcGross < MIN_SELL_GROSS_USDC) throw new ApiHttpError('below_min_trade', 'A sale must return at least 0.01 USDC');
    const minOut = applySlippage(q.usdcOut, slippageBps);
    const priceAfter = sidePriceOf(side, q.poolAfter);
    return {
      quote: {
        marketId: state.id,
        side,
        dir,
        amountIn: amount.toString(),
        amountOut: q.usdcOut.toString(),
        minOut: minOut.toString(),
        slippageBps,
        avgPrice: Number(q.usdcOut) / Number(amount),
        priceBefore,
        priceAfter,
        priceImpactBps: Math.round(Math.abs(priceAfter - priceBefore) * 10_000),
        feeBps,
        feeUsdc: q.feeUsdc.toString(),
        settleValue: null,
        warnings: [],
      },
      sharesOut: 0n,
      usdcOut: q.usdcOut,
      usdcGross: q.usdcGross,
      minOutBase: minOut,
      poolAfter: q.poolAfter,
      feeParts: parts,
    };
  } catch (err) {
    if (err instanceof ApiHttpError) throw err;
    const msg = (err as Error).message ?? '';
    if (/Reserve|SellRoot|Overflow/i.test(msg)) {
      throw new ApiHttpError('insufficient_liquidity', 'The pool cannot fill an order of this size. Try a smaller amount.');
    }
    throw err;
  }
}
