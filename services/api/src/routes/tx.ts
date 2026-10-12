import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { assertNotGeoBlocked, requireSignWithTos, type SessionCtx } from '../auth/session';
import type { AppContext } from '../context';
import { walletKey } from '../ratelimit';
import { BuildBuySellSchema, BuildCreateSchema, BuildMergeSchema, BuildRedeemSchema, UnsignedTxSchema } from '../schemas';
import { buildBuy, buildCreate, buildMerge, buildRedeem, buildSell } from '../services/txbuild';

/**
 * Transaction builders. Every route requires a SIGN session whose wallet accepted the current Terms version.
 * Buy and create are also geofenced and pass through the responsible-trading gate inside the builders.
 * Sell, merge and redeem are never blocked by a break, a daily limit, a stale oracle or the geofence, so users can always exit.
 */
export const txRoutes = (ctx: AppContext): FastifyPluginAsync => async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const limit = { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: walletKey } };
  const schema = <B extends object>(body: B) => ({ tags: ['tx'], body, response: { 200: UnsignedTxSchema } }) as const;

  const gate = async (req: FastifyRequest, opts: { geo: boolean }): Promise<SessionCtx> => {
    const s = await requireSignWithTos(ctx, req);
    if (opts.geo) assertNotGeoBlocked(ctx, req);
    return s;
  };

  app.post('/tx/buy', { config: limit, schema: schema(BuildBuySellSchema) }, async (req) => buildBuy(ctx, await gate(req, { geo: true }), req.body));
  app.post('/tx/sell', { config: limit, schema: schema(BuildBuySellSchema) }, async (req) => buildSell(ctx, await gate(req, { geo: false }), req.body));
  app.post('/tx/merge', { config: limit, schema: schema(BuildMergeSchema) }, async (req) => buildMerge(ctx, await gate(req, { geo: false }), req.body));
  app.post('/tx/redeem', { config: limit, schema: schema(BuildRedeemSchema) }, async (req) => buildRedeem(ctx, await gate(req, { geo: false }), req.body));
  app.post('/tx/create', { config: limit, schema: schema(BuildCreateSchema) }, async (req) => buildCreate(ctx, await gate(req, { geo: true }), req.body));
};
