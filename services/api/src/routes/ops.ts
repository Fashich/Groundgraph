import { timingSafeEqual } from 'node:crypto';
import { CH, readHeartbeat, RK } from '@groundgraph/svc-core';
import type { FastifyPluginAsync } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { isValidSolanaAddress } from '../auth/siws';
import type { AppContext } from '../context';
import { fail } from '../errors';
import { HealthSchema, U64 } from '../schemas';

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms).unref())]);

const KEEPER_MAX_AGE_SEC = 30;

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const opsRoutes = (ctx: AppContext): FastifyPluginAsync => async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  /* ------------------------------ health ------------------------------ */

  app.get('/health', { schema: { tags: ['ops'], response: { 200: HealthSchema, 503: HealthSchema } } }, async (_req, reply) => {
    const [db, redis, slot] = await Promise.all([
      withTimeout(ctx.db.sql`SELECT 1`, 2000).then(() => true, () => false),
      withTimeout(ctx.redis.ping(), 1500).then((r) => r === 'PONG', () => false),
      withTimeout(ctx.chain.getSlot(), 2500).then((s) => s, () => null as number | null),
    ]);
    let indexerLagSlots: number | null = null;
    let keeper = { ok: false, ageSec: null as number | null };
    if (redis) {
      const [ib, kb] = await Promise.all([readHeartbeat(ctx.redis, RK.heartbeatIndexer).catch(() => null), readHeartbeat(ctx.redis, RK.heartbeatKeeper).catch(() => null)]);
      const indexed = typeof ib?.['indexedSlot'] === 'number' ? (ib['indexedSlot'] as number) : null;
      if (slot !== null && indexed !== null) indexerLagSlots = Math.max(0, slot - indexed);
      if (kb) {
        const ageSec = Math.max(0, Math.round((ctx.now().getTime() - kb.ts) / 1000));
        keeper = { ok: ageSec <= KEEPER_MAX_AGE_SEC, ageSec };
      }
    }
    const rpc = slot !== null;
    const ok = db && redis && rpc;
    return reply.code(ok ? 200 : 503).send({ ok, db, redis, rpc, indexerLagSlots, keeper, demoMode: ctx.cfg.DEMO_MODE });
  });

  /* ------------------------------ metrics ------------------------------ */

  app.get('/metrics', { schema: { hide: true } }, async (req, reply) => {
    const token = ctx.cfg.METRICS_TOKEN;
    if (token) {
      const h = req.headers.authorization ?? '';
      if (!safeEqual(h, `Bearer ${token}`)) return reply.code(401).send({ error: { code: 'unauthorized', message: 'metrics token required' } });
    }
    return reply.header('content-type', ctx.registry.contentType).send(await ctx.registry.metrics());
  });

  /* ------------------------------ faucet (devnet only) ------------------------------ */

  app.post(
    '/faucet/usdc',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['devnet'],
        body: z.object({ wallet: z.string().min(32).max(44) }),
        response: { 200: z.object({ txSig: z.string(), amount: U64 }) },
      },
    },
    async (req) => {
      if (!ctx.cfg.isDevnet) return fail('faucet_unavailable', 'The faucet only exists on devnet.');
      if (!ctx.faucet) return fail('faucet_unavailable', 'The faucet is not configured on this deployment.');
      const { wallet } = req.body;
      if (!isValidSolanaAddress(wallet)) return fail('bad_request', 'wallet must be a base58 Solana address');
      const day = ctx.now().toISOString().slice(0, 10);
      const wKey = RK.faucetWallet(wallet, day);
      const iKey = RK.faucetIp(req.clientIp, day);
      const nW = await ctx.redis.incr(wKey);
      if (nW === 1) await ctx.redis.expire(wKey, 90_000);
      const nI = await ctx.redis.incr(iKey);
      if (nI === 1) await ctx.redis.expire(iKey, 90_000);
      const rollback = async () => {
        await ctx.redis.decr(wKey).catch(() => undefined);
        await ctx.redis.decr(iKey).catch(() => undefined);
      };
      if (nW > ctx.cfg.FAUCET_MAX_PER_WALLET_PER_DAY) {
        await rollback();
        return fail('rate_limited', `This wallet already received test USDC ${ctx.cfg.FAUCET_MAX_PER_WALLET_PER_DAY} times today. Try again tomorrow (UTC).`, { limit: ctx.cfg.FAUCET_MAX_PER_WALLET_PER_DAY });
      }
      if (nI > ctx.cfg.FAUCET_MAX_PER_IP_PER_DAY) {
        await rollback();
        return fail('rate_limited', 'This network reached the daily test USDC limit. Try again tomorrow (UTC).', { limit: ctx.cfg.FAUCET_MAX_PER_IP_PER_DAY });
      }
      try {
        const txSig = await ctx.faucet.mint(wallet, ctx.cfg.faucetAmountBase);
        return { txSig, amount: ctx.cfg.faucetAmountBase.toString() };
      } catch (err) {
        await rollback();
        ctx.log.error({ err: (err as Error).message, wallet }, 'faucet mint failed');
        return fail('faucet_unavailable', 'The faucet could not send test USDC right now. Try again in a minute.');
      }
    },
  );

  /* ------------------------------ helius webhook (optional) ------------------------------ */

  app.post('/webhooks/helius', { bodyLimit: 8 * 1024 * 1024, schema: { tags: ['ops'], hide: true } }, async (req, reply) => {
    const secret = ctx.cfg.HELIUS_WEBHOOK_SECRET;
    if (!secret) return fail('not_found', 'Not found');
    const header = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!safeEqual(header, secret)) return reply.code(401).send({ error: { code: 'unauthorized', message: 'bad webhook credentials' } });
    const body = req.body;
    const sigs = Array.isArray(body)
      ? body.map((t) => (t && typeof t === 'object' ? (t as { signature?: unknown }).signature : null)).filter((s): s is string => typeof s === 'string').slice(0, 25)
      : [];
    await ctx.redis.publish(CH.indexerNudge, JSON.stringify({ source: 'helius', sigs }));
    return reply.code(204).send();
  });
};
