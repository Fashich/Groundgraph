import { assetBySymbol, listAssetFeeds, parseU64 } from '@groundgraph/svc-core';
import type { Quote } from '@groundgraph/sdk/api-types';
import type { FastifyPluginAsync } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireSession } from '../auth/session';
import type { AppContext } from '../context';
import { ApiHttpError, fail } from '../errors';
import {
  AssetSchema,
  FairValueInfoSchema,
  MarketDetailSchema,
  MarketSummarySchema,
  MarketWalletRowSchema,
  paged,
  QuoteSchema,
  TradeRowSchema,
  U64,
} from '../schemas';
import { computeFairValue } from '../services/fairvalue';
import { checkBuyGate } from '../services/limits';
import { getMarketDetail, getMarketRow, listMarkets, marketTrades, marketWallets } from '../services/markets';
import { allOracles, isOracleStale, readOracle } from '../services/oracle';
import { computeQuote, loadMarketState, marketClosedFor } from '../services/quote';
import { DEFAULT_SLIPPAGE_BPS } from '../services/txbuild';

const boolQ = z.preprocess((v) => (v === undefined ? undefined : v === true || v === 'true' || v === '1'), z.boolean().optional());
const idParam = z.object({ id: z.string().min(32).max(44) });

export const marketRoutes = (ctx: AppContext): FastifyPluginAsync => async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/markets',
    {
      schema: {
        tags: ['markets'],
        querystring: z.object({
          cat: z.string().max(40).optional(),
          lean: z.enum(['any', 'above', 'below']).optional(),
          ends: z.enum(['any', '48h', '2w', 'long']).optional(),
          sort: z.enum(['signal', 'gap', 'ending', 'volume', 'newest']).optional(),
          q: z.string().max(80).optional(),
          watch: boolQ,
          status: z.enum(['active', 'all', 'resolved', 'open', 'trading_closed', 'settled', 'voided']).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(24),
          cursor: z.string().max(20).optional(),
        }),
        response: { 200: paged(MarketSummarySchema) },
      },
    },
    async (req) => {
      const q = req.query;
      let watchWallet: string | undefined;
      if (q.watch) watchWallet = requireSession(req).wallet;
      const offset = q.cursor?.startsWith('o:') ? Math.max(0, Number(q.cursor.slice(2)) || 0) : 0;
      return listMarkets(ctx, { ...q, watchWallet, limit: q.limit, offset });
    },
  );

  app.get(
    '/markets/:id',
    {
      schema: {
        tags: ['markets'],
        params: idParam,
        querystring: z.object({ tf: z.enum(['1D', '3D', '1W', 'ALL']).default('1D') }),
        response: { 200: MarketDetailSchema },
      },
    },
    async (req) => {
      const d = await getMarketDetail(ctx, req.params.id, req.query.tf);
      if (!d) fail('not_found', 'Market not found');
      return d!;
    },
  );

  app.get('/markets/:id/wallets', { schema: { tags: ['markets'], params: idParam, response: { 200: z.array(MarketWalletRowSchema) } } }, async (req) => {
    if (!(await getMarketRow(ctx, req.params.id))) fail('not_found', 'Market not found');
    return marketWallets(ctx, req.params.id);
  });

  app.get(
    '/markets/:id/trades',
    {
      schema: {
        tags: ['markets'],
        params: idParam,
        querystring: z.object({ cursor: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }),
        response: { 200: paged(TradeRowSchema) },
      },
    },
    async (req) => {
      if (!(await getMarketRow(ctx, req.params.id))) fail('not_found', 'Market not found');
      return marketTrades(ctx, req.params.id, req.query.cursor ?? null, req.query.limit);
    },
  );

  app.get(
    '/markets/:id/quote',
    {
      schema: {
        tags: ['markets'],
        params: idParam,
        querystring: z.object({
          side: z.enum(['above', 'below']),
          dir: z.enum(['buy', 'sell']),
          amount: U64,
          slippageBps: z.coerce.number().int().min(1).max(5000).default(DEFAULT_SLIPPAGE_BPS),
        }),
        response: { 200: QuoteSchema },
      },
    },
    async (req): Promise<Quote> => {
      const { side, dir, amount, slippageBps } = req.query;
      const state = await loadMarketState(ctx, req.params.id);
      if (!state) return fail('not_found', 'Market not found');
      const nowSec = Math.floor(ctx.now().getTime() / 1000);
      const closed = marketClosedFor(state, dir, nowSec);
      if (closed) return fail('market_closed', closed);
      const amt = parseU64(amount);
      if (amt === 0n) return fail('bad_request', 'amount must be greater than zero');
      const calc = computeQuote(state, side, dir, amt, slippageBps, nowSec);
      const warnings: string[] = [];
      if (calc.quote.priceImpactBps > slippageBps) warnings.push('exceeds_slippage');
      if (dir === 'buy') {
        const snap = await readOracle(ctx, state.feedIdHex);
        if (isOracleStale(ctx, snap, ctx.now().getTime())) warnings.push('oracle_stale');
        if (req.session && req.session.mode === 'sign') {
          const gate = await checkBuyGate(ctx, req.session.wallet, amt);
          if (!gate.ok) warnings.push(gate.code === 'break_active' ? 'break_active' : 'daily_limit');
          const mint = state.chain?.collateralMint ?? ctx.cfg.USDC_MINT;
          if (mint) {
            const bal = await ctx.chain.getTokenBalance(req.session.wallet, mint).catch(() => null);
            if (bal !== null && bal > 0n && amt * 4n > bal) warnings.push('large_vs_balance');
          }
        }
      }
      return { ...calc.quote, warnings };
    },
  );

  app.get(
    '/fair-value',
    {
      schema: {
        tags: ['markets'],
        querystring: z.object({
          asset: z.string().min(2).max(16),
          target: z.coerce.number().positive(),
          settleTs: z.string(),
          kind: z.enum(['close', 'touch']).default('close'),
          direction: z.enum(['up', 'down']).optional(),
        }),
        response: { 200: FairValueInfoSchema },
      },
    },
    async (req) => {
      const q = req.query;
      const asset = assetBySymbol(q.asset);
      if (!asset) return fail('bad_request', `Unknown asset ${q.asset}`);
      // settleTs may be ISO or unix seconds
      const ms = /^\d{9,11}$/.test(q.settleTs) ? Number(q.settleTs) * 1000 : Date.parse(q.settleTs);
      if (!Number.isFinite(ms)) return fail('bad_request', 'settleTs must be an ISO timestamp or unix seconds');
      const fv = await computeFairValue(ctx, { assetSymbol: asset.symbol, strike: q.target, settleTsSec: Math.floor(ms / 1000), kind: q.kind, direction: q.direction });
      if (!fv) throw new ApiHttpError('oracle_stale', `Fair value for ${asset.symbol} is unavailable right now (no fresh price or volatility estimate).`);
      return fv;
    },
  );

  app.get('/assets', { schema: { tags: ['markets'], response: { 200: z.array(AssetSchema) } } }, async () => {
    const nowSec = ctx.now().getTime() / 1000;
    const list = await allOracles(ctx);
    return list.map(({ asset, snap }) => ({
      symbol: asset.symbol,
      feedId: asset.feedIdHex,
      price: snap ? snap.price : null,
      ageSec: snap ? Math.max(0, Math.round(nowSec - snap.publishTs)) : null,
    }));
  });
  void listAssetFeeds;
};
