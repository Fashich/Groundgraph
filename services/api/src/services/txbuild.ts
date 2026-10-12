import { randomInt } from 'node:crypto';
import {
  assetBySymbol,
  buildBuyIx,
  buildCreateMarketIx,
  buildMergeIx,
  buildQuestion,
  buildRedeemIx,
  buildSellIx,
  expectedArbLossUsdc,
  MIN_TRADE_USDC,
  numberToRaw,
  parseU64,
  RK,
  seedReserves,
  toUnsignedV0Tx,
  type ChainMarket,
  type SimulationResult,
} from '@groundgraph/svc-core';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import type { Quote, Side, UnsignedTx } from '@groundgraph/sdk/api-types';
import type { AppContext } from '../context';
import type { SessionCtx } from '../auth/session';
import { ApiHttpError } from '../errors';
import { computeFairValue } from './fairvalue';
import { assertBuyGate, checkBuyGate, reserveSpend } from './limits';
import { isOracleStale, readOracle } from './oracle';
import { computeQuote, loadMarketState, marketClosedFor, type MarketState } from './quote';

export type UnsignedTxResp = UnsignedTx & { marketId?: string };

const CU_TRADE = 300_000;
const CU_SIMPLE = 200_000;
const CU_CREATE = 600_000;
export const DEFAULT_SLIPPAGE_BPS = 100;

/** Anchor error numbers start at 6000 in the order of the GgError enum in programs/groundgraph/src/errors.rs. */
const GG_ERRORS = [
  'Paused', 'NotEnabledInThisVersion', 'NotAdmin', 'NotUpgradeAuthority', 'InvalidConfig', 'InvalidCollateralMint', 'InvalidSymbol',
  'FeedNotAllowed', 'InvalidTarget', 'InvalidBaseFee', 'InvalidOpeningPrice', 'LiquidityTooLow', 'DurationTooShort', 'DurationTooLong',
  'WrongCollateralMint', 'WrongMint', 'WrongVault', 'WrongTokenAccount', 'MarketNotOpen', 'TradingEnded', 'ZeroAmount', 'BelowMinTrade',
  'SellTooSmall', 'SlippageExceeded', 'MathOverflow', 'ReserveTooLarge', 'ReserveEmpty', 'TooEarlyToSettle', 'TooEarlyToVoid', 'WrongFeedId',
  'InsufficientVerification', 'PriceStale', 'PriceOutsideWindow', 'NonPositivePrice', 'ConfidenceTooWide', 'ExponentOutOfRange', 'NotResolved',
  'NotWinningSide', 'AmountTooSmall', 'InvalidLpAmount', 'InvariantViolated',
];

/** Translate a failed pre-simulation into the API error contract. */
export function simulationFailure(sim: SimulationResult): ApiHttpError {
  const text = sim.logs.join('\n');
  let name: string | undefined;
  const logged = [...text.matchAll(/Error Code: (\w+)/g)].pop();
  if (logged) name = logged[1];
  const errObj = sim.err as { InstructionError?: [number, { Custom?: number } | string] } | string | null;
  if (!name && errObj && typeof errObj === 'object' && errObj.InstructionError) {
    const detail = errObj.InstructionError[1];
    if (detail && typeof detail === 'object' && typeof detail.Custom === 'number') name = GG_ERRORS[detail.Custom - 6000];
  }
  switch (name) {
    case 'SlippageExceeded':
      return new ApiHttpError('slippage_exceeded', 'The price moved beyond your slippage tolerance. Raise it to 2% or reduce the amount.', { suggestSlippageBps: 200 });
    case 'TradingEnded':
    case 'MarketNotOpen':
    case 'Paused':
    case 'NotResolved':
      return new ApiHttpError('market_closed', 'This market is not accepting this action right now.', { program: name });
    case 'BelowMinTrade':
    case 'SellTooSmall':
      return new ApiHttpError('below_min_trade', 'The amount is below the minimum trade size.', { program: name });
    case 'ReserveTooLarge':
    case 'ReserveEmpty':
    case 'MathOverflow':
      return new ApiHttpError('insufficient_liquidity', 'The pool cannot fill an order of this size.', { program: name });
    case 'NotWinningSide':
      return new ApiHttpError('bad_request', 'Only the winning side can be redeemed. This side settled at $0.', { program: name });
    default:
  }
  if (/insufficient funds/i.test(text) || /custom program error: 0x1\b/.test(text)) {
    return new ApiHttpError('bad_request', 'Your wallet does not hold enough of the required token for this transaction.', { reason: 'insufficient_token_balance' });
  }
  if (errObj === 'AccountNotFound' || errObj === 'InsufficientFundsForFee' || /insufficient lamports/i.test(text)) {
    return new ApiHttpError('bad_request', 'Your wallet needs a little SOL to pay network fees. On devnet, request an airdrop first.', { reason: 'no_sol_for_fees' });
  }
  return new ApiHttpError('bad_request', 'The transaction would fail on chain.', { err: sim.err, logs: sim.logs.slice(-6) });
}

interface FinalizeArgs {
  payer: PublicKey;
  instructions: TransactionInstruction[];
  writable: string[];
  cuLimit: number;
  priorityOverride?: number | undefined;
  summary: string;
  receipt?: Partial<Quote> | undefined;
  marketId?: string | undefined;
}

async function finalize(ctx: AppContext, a: FinalizeArgs): Promise<UnsignedTxResp> {
  const { blockhash, lastValidBlockHeight } = await ctx.chain.getLatestBlockhash();
  const priority = Math.min(a.priorityOverride ?? (await ctx.chain.getPriorityFee(a.writable)), ctx.cfg.MAX_PRIORITY_FEE_MICROLAMPORTS);
  const tx = toUnsignedV0Tx({
    payer: a.payer,
    instructions: a.instructions,
    blockhash,
    computeUnitLimit: a.cuLimit,
    priorityFeeMicroLamports: priority,
  });
  if (ctx.cfg.SIMULATE_TX) {
    let sim: SimulationResult | null = null;
    try {
      sim = await ctx.chain.simulate(tx);
    } catch (err) {
      ctx.log.warn({ err }, 'pre-simulation unavailable, returning the transaction unchecked');
    }
    if (sim && sim.err) throw simulationFailure(sim);
  }
  const out: UnsignedTxResp = {
    transaction: Buffer.from(tx.serialize()).toString('base64'),
    blockhash,
    lastValidBlockHeight,
    summary: a.summary,
  };
  if (a.receipt) out.receipt = a.receipt;
  if (a.marketId) out.marketId = a.marketId;
  return out;
}

async function requireChainMarket(ctx: AppContext, id: string): Promise<{ state: MarketState; market: ChainMarket }> {
  const state = await loadMarketState(ctx, id, { requireChain: true });
  if (!state || !state.chain) throw new ApiHttpError('not_found', 'Market not found');
  return { state, market: state.chain };
}

async function assertNotPaused(ctx: AppContext): Promise<void> {
  const cfg = await ctx.chain.getConfig().catch(() => null);
  if (cfg?.paused) throw new ApiHttpError('market_closed', 'Trading and market creation are paused by the protocol admin.', { paused: true });
}

async function assertOracleFresh(ctx: AppContext, feedIdHex: string): Promise<void> {
  const snap = await readOracle(ctx, feedIdHex);
  if (isOracleStale(ctx, snap, ctx.now().getTime())) {
    throw new ApiHttpError('oracle_stale', 'The price feed for this market is stale, so buying is paused. Selling, merging and redeeming still work.', {
      ageSec: snap ? Math.round(ctx.now().getTime() / 1000 - snap.publishTs) : null,
    });
  }
}

async function assertBalance(ctx: AppContext, wallet: string, mint: string, need: bigint, label: string): Promise<void> {
  let bal: bigint | null;
  try {
    bal = await ctx.chain.getTokenBalance(wallet, mint);
  } catch {
    return; // balance unknown: the pre-simulation still catches shortfalls
  }
  if (bal === null || bal < need) {
    throw new ApiHttpError('bad_request', `Your wallet holds ${bal === null ? 'no' : (Number(bal) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${label}, but this needs ${(Number(need) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })}.`, {
      reason: 'insufficient_balance',
      have: bal?.toString() ?? '0',
      need: need.toString(),
    });
  }
}

const parseAmount = (s: string): bigint => {
  try {
    const v = parseU64(s);
    if (v === 0n) throw new RangeError('zero');
    return v;
  } catch {
    throw new ApiHttpError('bad_request', 'amount must be a positive decimal string of base units');
  }
};

const fmtUsdc = (b: bigint) => (Number(b) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtShares = (b: bigint) => (Number(b) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 4 });
const upper = (s: Side) => s.toUpperCase();

/* ------------------------------ buy ------------------------------ */

export interface TradeBody {
  marketId: string;
  side: Side;
  amount: string;
  slippageBps?: number | undefined;
  priorityFeeMicroLamports?: number | undefined;
}

export async function buildBuy(ctx: AppContext, sess: SessionCtx, body: TradeBody, opts: { extraIx?: TransactionInstruction[] } = {}): Promise<UnsignedTxResp> {
  const amount = parseAmount(body.amount);
  if (amount < MIN_TRADE_USDC) throw new ApiHttpError('below_min_trade', 'The minimum trade is 1 USDC');
  const { state, market } = await requireChainMarket(ctx, body.marketId);
  const nowSec = Math.floor(ctx.now().getTime() / 1000);
  const closed = marketClosedFor(state, 'buy', nowSec);
  if (closed) throw new ApiHttpError('market_closed', closed);
  await assertNotPaused(ctx);
  // responsible-trading gate first: the break / limit message matters more to the user than a transient oracle pause
  assertBuyGate(await checkBuyGate(ctx, sess.wallet, amount));
  await assertOracleFresh(ctx, state.feedIdHex);
  const slippage = body.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const calc = computeQuote(state, body.side, 'buy', amount, slippage, nowSec);
  await assertBalance(ctx, sess.wallet, market.collateralMint, amount, 'USDC');
  const ixs = buildBuyIx({
    market: market.raw,
    marketPk: new PublicKey(market.id),
    user: new PublicKey(sess.wallet),
    side: body.side,
    usdcIn: amount,
    minSharesOut: calc.minOutBase,
  });
  const res = await finalize(ctx, {
    payer: new PublicKey(sess.wallet),
    instructions: [...ixs, ...(opts.extraIx ?? [])],
    writable: [market.id],
    cuLimit: CU_TRADE,
    priorityOverride: body.priorityFeeMicroLamports,
    summary: `Buy ${upper(body.side)}: pay $${fmtUsdc(amount)} for about ${fmtShares(calc.sharesOut)} shares (settles at $1 or $0)`,
    receipt: calc.quote,
  });
  await reserveSpend(ctx, sess.wallet, amount);
  return res;
}

/* ------------------------------ sell ------------------------------ */

export async function buildSell(ctx: AppContext, sess: SessionCtx, body: TradeBody): Promise<UnsignedTxResp> {
  const shares = parseAmount(body.amount);
  const { state, market } = await requireChainMarket(ctx, body.marketId);
  const nowSec = Math.floor(ctx.now().getTime() / 1000);
  const closed = marketClosedFor(state, 'sell', nowSec);
  if (closed) throw new ApiHttpError('market_closed', closed);
  const slippage = body.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const calc = computeQuote(state, body.side, 'sell', shares, slippage, nowSec);
  const mint = body.side === 'above' ? market.aboveMint : market.belowMint;
  await assertBalance(ctx, sess.wallet, mint, shares, `${upper(body.side)} shares`);
  const ixs = buildSellIx({
    market: market.raw,
    marketPk: new PublicKey(market.id),
    user: new PublicKey(sess.wallet),
    side: body.side,
    sharesIn: shares,
    minUsdcOut: calc.minOutBase,
  });
  return finalize(ctx, {
    payer: new PublicKey(sess.wallet),
    instructions: ixs,
    writable: [market.id],
    cuLimit: CU_TRADE,
    priorityOverride: body.priorityFeeMicroLamports,
    summary: `Sell ${fmtShares(shares)} ${upper(body.side)} shares for about $${fmtUsdc(calc.usdcOut)}`,
    receipt: calc.quote,
  });
}

/* ------------------------------ merge ------------------------------ */

export async function buildMerge(ctx: AppContext, sess: SessionCtx, body: { marketId: string; amount: string; priorityFeeMicroLamports?: number | undefined }): Promise<UnsignedTxResp> {
  const amount = parseAmount(body.amount);
  const { state, market } = await requireChainMarket(ctx, body.marketId);
  if (state.status !== 'open') throw new ApiHttpError('market_closed', 'This market has resolved. Redeem your shares instead of merging.');
  await assertBalance(ctx, sess.wallet, market.aboveMint, amount, 'ABOVE shares');
  await assertBalance(ctx, sess.wallet, market.belowMint, amount, 'BELOW shares');
  const ixs = buildMergeIx({ market: market.raw, marketPk: new PublicKey(market.id), user: new PublicKey(sess.wallet), amount });
  return finalize(ctx, {
    payer: new PublicKey(sess.wallet),
    instructions: ixs,
    writable: [market.id],
    cuLimit: CU_SIMPLE,
    priorityOverride: body.priorityFeeMicroLamports,
    summary: `Merge ${fmtShares(amount)} ABOVE + ${fmtShares(amount)} BELOW into $${fmtUsdc(amount)} (no fee)`,
  });
}

/* ------------------------------ redeem ------------------------------ */

export async function buildRedeem(ctx: AppContext, sess: SessionCtx, body: { marketId: string; side: Side; amount: string; priorityFeeMicroLamports?: number | undefined }): Promise<UnsignedTxResp> {
  const amount = parseAmount(body.amount);
  const { state, market } = await requireChainMarket(ctx, body.marketId);
  if (state.status === 'open') throw new ApiHttpError('market_closed', 'This market has not settled yet. You can sell or merge before it settles.');
  let payout: bigint;
  if (state.status === 'settled') {
    if (market.outcome !== body.side) {
      throw new ApiHttpError('bad_request', `This market settled ${market.outcome ? upper(market.outcome) : ''}. ${upper(body.side)} shares settled at $0.`);
    }
    payout = amount;
  } else {
    payout = amount / 2n;
  }
  const mint = body.side === 'above' ? market.aboveMint : market.belowMint;
  await assertBalance(ctx, sess.wallet, mint, amount, `${upper(body.side)} shares`);
  const ixs = buildRedeemIx({ market: market.raw, marketPk: new PublicKey(market.id), user: new PublicKey(sess.wallet), side: body.side, amount });
  return finalize(ctx, {
    payer: new PublicKey(sess.wallet),
    instructions: ixs,
    writable: [market.id],
    cuLimit: CU_SIMPLE,
    priorityOverride: body.priorityFeeMicroLamports,
    summary: `Redeem ${fmtShares(amount)} ${upper(body.side)} shares for $${fmtUsdc(payout)}`,
  });
}

/* ------------------------------ create ------------------------------ */

export interface CreateBody {
  assetSymbol: string;
  kind: 'close' | 'touch';
  targetPrice: number;
  settleTs: string;
  baseFeeBps: 50 | 100 | 200;
  dynamicFee: boolean;
  liquidityUsdc: string;
  p0Bps?: number | undefined;
  question?: string | undefined;
}

const BANNED = /\b(bet|bets|betting|odds|gamble|gambling|jackpot|win big)\b|\b(YES|NO)\b/i;

export async function buildCreate(ctx: AppContext, sess: SessionCtx, body: CreateBody): Promise<UnsignedTxResp> {
  if (body.kind !== 'close') throw new ApiHttpError('bad_request', 'Touch markets are not enabled in this version. Create a Close market.', { feature: 'touch' });
  const asset = assetBySymbol(body.assetSymbol);
  if (!asset) throw new ApiHttpError('bad_request', `Unknown asset ${body.assetSymbol}`, { supported: ['SOL', 'BTC', 'ETH', 'JUP', 'WIF', 'BONK'] });
  if (body.question && BANNED.test(body.question)) {
    throw new ApiHttpError('bad_request', 'Questions use ABOVE / BELOW wording; please rephrase without gambling terms or YES/NO labels.');
  }
  const settleMs = Date.parse(body.settleTs);
  if (!Number.isFinite(settleMs)) throw new ApiHttpError('bad_request', 'settleTs must be an ISO-8601 timestamp');
  const settleSec = Math.floor(settleMs / 1000);
  const nowSec = Math.floor(ctx.now().getTime() / 1000);
  const cfg = await ctx.chain.getConfig().catch(() => null);
  if (!cfg) throw new ApiHttpError('internal', 'The program is not initialized on this cluster yet', undefined, 503);
  if (cfg.paused) throw new ApiHttpError('market_closed', 'Market creation is paused by the protocol admin.', { paused: true });
  const duration = settleSec - nowSec;
  if (duration < cfg.minDurationSecs) {
    throw new ApiHttpError('bad_request', `Settlement must be at least ${Math.round(cfg.minDurationSecs / 60)} minutes from now.`, { minDurationSecs: cfg.minDurationSecs });
  }
  if (duration > cfg.maxDurationSecs) {
    throw new ApiHttpError('bad_request', `Settlement must be within ${Math.round(cfg.maxDurationSecs / 86400)} days.`, { maxDurationSecs: cfg.maxDurationSecs });
  }
  const liquidity = parseAmount(body.liquidityUsdc);
  if (liquidity < cfg.minLiquidity) {
    throw new ApiHttpError('bad_request', `Minimum liquidity is $${fmtUsdc(cfg.minLiquidity)}.`, { minLiquidity: cfg.minLiquidity.toString() });
  }
  assertBuyGate(await checkBuyGate(ctx, sess.wallet, liquidity));
  await assertOracleFresh(ctx, asset.feedIdHex);

  let p0 = body.p0Bps;
  if (p0 === undefined) {
    const fv = await computeFairValue(ctx, { assetSymbol: asset.symbol, strike: body.targetPrice, settleTsSec: settleSec, kind: 'close' });
    if (!fv) throw new ApiHttpError('bad_request', 'The model fair value is unavailable right now. Choose an opening price (p0Bps) yourself.', { reason: 'fair_value_unavailable' });
    p0 = Math.min(9800, Math.max(200, Math.round(fv.pAbove * 10_000)));
  }
  try {
    seedReserves(liquidity, p0);
  } catch {
    throw new ApiHttpError('bad_request', 'That liquidity and opening price leave an empty side of the pool. Increase liquidity or move the opening price toward 50%.');
  }

  const feed = await ctx.chain.getFeed(asset.feedIdHex).catch(() => null);
  if (!feed || !feed.enabled) throw new ApiHttpError('bad_request', `${asset.symbol} is not enabled on this deployment`, { reason: 'feed_not_allowed' });
  const expo = Math.min(0, Math.max(-18, feed.expo));
  let raw: bigint;
  try {
    raw = numberToRaw(body.targetPrice, expo);
  } catch {
    throw new ApiHttpError('bad_request', 'targetPrice is not valid');
  }
  if (raw <= 0n) throw new ApiHttpError('bad_request', 'targetPrice is too small for this feed precision');

  const usdcMint = ctx.cfg.USDC_MINT ?? cfg.usdcMint;
  await assertBalance(ctx, sess.wallet, usdcMint, liquidity, 'USDC');

  const nonce = BigInt(ctx.now().getTime()) * 1000n + BigInt(randomInt(0, 1000));
  const creator = new PublicKey(sess.wallet);
  const built = buildCreateMarketIx({
    creator,
    nonce,
    feedId: Uint8Array.from(Buffer.from(asset.feedIdHex, 'hex')),
    kind: 'close',
    targetPrice: raw,
    targetExpo: expo,
    settleTs: settleSec,
    baseFeeBps: body.baseFeeBps,
    dynamicFee: body.dynamicFee,
    liquidity,
    p0Bps: p0,
    usdcMint: new PublicKey(usdcMint),
  });
  const marketId = built.market.toBase58();
  const question = body.question ?? buildQuestion({ assetSymbol: asset.symbol, kind: 'close', targetPrice: body.targetPrice, settleTs: settleSec });
  if (body.question) {
    await ctx.redis.set(RK.pendingQuestion(marketId), body.question, 'EX', 3600).catch(() => undefined);
  }
  const arbLoss = expectedArbLossUsdc(liquidity, p0 / 10_000);
  const res = await finalize(ctx, {
    payer: creator,
    instructions: built.instructions,
    writable: [marketId],
    cuLimit: CU_CREATE,
    summary: `Create market "${question}" with $${fmtUsdc(liquidity)} liquidity opening at ${(p0 / 100).toFixed(1)}% ABOVE (est. arbitrage cost if wrong: $${fmtUsdc(arbLoss)})`,
    marketId,
  });
  await reserveSpend(ctx, sess.wallet, liquidity);
  return res;
}
