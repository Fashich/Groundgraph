import type { FastifyPluginAsync } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppContext } from '../context';
import { fail } from '../errors';
import { renderOgPng } from '../og';
import { getMarketSummary } from '../services/markets';

const TTL_MS = 15_000;
const MAX_ENTRIES = 200;

export const ogRoutes = (ctx: AppContext): FastifyPluginAsync => async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const cache = new Map<string, { at: number; png: Buffer }>();
  const inflight = new Map<string, Promise<Buffer | null>>();
  const webHost = new URL(ctx.cfg.WEB_ORIGIN).host;

  const render = async (id: string): Promise<Buffer | null> => {
    const market = await getMarketSummary(ctx, id);
    if (!market) return null;
    const clusterLabel = ctx.cfg.SOLANA_CLUSTER === 'mainnet-beta' ? 'Solana mainnet' : `Solana ${ctx.cfg.SOLANA_CLUSTER} · unaudited`;
    return renderOgPng({ market, webHost, clusterLabel });
  };

  app.get(
    '/og/m/:file',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } }, schema: { tags: ['blinks'], params: z.object({ file: z.string().min(32).max(52) }) } },
    async (req, reply) => {
      const id = req.params.file.replace(/\.png$/i, '');
      if (id.length > 44) return fail('not_found', 'Market not found');
      const hit = cache.get(id);
      let png: Buffer | null;
      if (hit && Date.now() - hit.at < TTL_MS) {
        png = hit.png;
      } else {
        let p = inflight.get(id);
        if (!p) {
          p = render(id).finally(() => inflight.delete(id));
          inflight.set(id, p);
        }
        png = await p;
        if (png) {
          if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
          cache.set(id, { at: Date.now(), png });
        }
      }
      if (!png) return fail('not_found', 'Market not found');
      return reply.header('content-type', 'image/png').header('cache-control', 'public, max-age=15').send(png);
    },
  );
};
