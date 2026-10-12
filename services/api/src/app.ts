import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { createSubscriber } from '@groundgraph/svc-core';
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors, jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { Histogram } from 'prom-client';
import { countryOf, loadSession } from './auth/session';
import type { AppContext } from './context';
import { ApiHttpError, errorBody } from './errors';
import { accountRoutes } from './routes/account';
import { actionsRoutes } from './routes/actions';
import { authRoutes } from './routes/auth';
import { marketRoutes } from './routes/markets';
import { ogRoutes } from './routes/og';
import { opsRoutes } from './routes/ops';
import { radarRoutes } from './routes/radar';
import { txRoutes } from './routes/tx';
import { WsHub } from './ws/hub';

const PUBLIC_PREFIXES = ['/actions', '/og/', '/health', '/metrics', '/docs'];
const ACTION_HEADERS = ['Content-Type', 'Authorization', 'Content-Encoding', 'Accept-Encoding', 'X-Action-Version', 'X-Blockchain-Ids'];
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const isPublicPath = (url: string) => PUBLIC_PREFIXES.some((p) => url === p.replace(/\/$/, '') || url.startsWith(p));
const pathOf = (url: string) => url.split('?')[0] ?? url;

export interface BuiltApp {
  app: FastifyInstance;
  hub: WsHub;
}

export async function buildApp(ctx: AppContext, opts: { subscriber?: import('ioredis').Redis; hubTimers?: { summaryMs?: number; radarPollMs?: number; heartbeatMs?: number } } = {}): Promise<BuiltApp> {
  const { cfg } = ctx;
  const app = Fastify({
    loggerInstance: ctx.log,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: cfg.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
    // the reverse proxy may keep the /api prefix: /api/markets and /markets hit the same route
    rewriteUrl: (req) => (req.url ?? '/').replace(/^\/api(?=\/|\?|$)/, '') || '/',
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  /* ------------------------------ plugins (order matters: cookie -> cors -> session hook -> rate limit) ------------------------------ */

  await app.register(cookie, { secret: cfg.SESSION_SECRET });

  const webOrigin = new URL(cfg.WEB_ORIGIN).origin;
  const apiOrigin = new URL(cfg.PUBLIC_API_URL).origin;
  await app.register(cors, {
    delegator: (req, callback) => {
    const path = pathOf(req.url);
    const open = path === '/actions.json' || path.startsWith('/actions/') || path.startsWith('/og/');
    if (open) {
      callback(null, { origin: '*', credentials: false, methods: ['GET', 'POST', 'PUT', 'OPTIONS'], allowedHeaders: ACTION_HEADERS, exposedHeaders: ['X-Action-Version', 'X-Blockchain-Ids'], maxAge: 86400 });
    } else {
      callback(null, { origin: [webOrigin, apiOrigin], credentials: true, methods: ['GET', 'POST', 'PUT', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'], maxAge: 600 });
    }
    },
  });

  app.decorateRequest('session', null);
  app.decorateRequest('clientIp', '');
  app.decorateRequest('ipCountry', null);

  const authenticate = async (rawCookie: string | undefined) => {
    if (!rawCookie) return null;
    const parsed = app.parseCookie(rawCookie);
    return loadSession(ctx, parsed[cfg.COOKIE_NAME], (v) => app.unsignCookie(v));
  };

  app.addHook('onRequest', async (req: FastifyRequest, reply) => {
    req.clientIp = req.ip;
    req.ipCountry = countryOf(req);
    const url = pathOf(req.url);
    // CSRF defense in depth (cookies are SameSite already): a cookie-bearing mutating request from a foreign Origin is refused
    if (MUTATING.has(req.method) && req.headers.cookie?.includes(cfg.COOKIE_NAME) && !url.startsWith('/actions') && !url.startsWith('/webhooks')) {
      const origin = req.headers.origin;
      if (origin && origin !== webOrigin && origin !== apiOrigin) {
        return reply.code(403).send(errorBody('unauthorized', 'Cross-origin request blocked'));
      }
    }
    if (!isPublicPath(url) || url === '/health') {
      req.session = await authenticate(req.headers.cookie).catch((err) => {
        ctx.log.warn({ err: (err as Error).message }, 'session lookup failed');
        return null;
      });
    }
  });

  await app.register(rateLimit, {
    global: true,
    max: cfg.RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    redis: ctx.redis,
    nameSpace: 'gg:rl:',
    skipOnError: true,
    keyGenerator: (req) => `ip:${req.clientIp || req.ip}`,
    allowList: (req) => {
      const u = pathOf(req.url);
      return u === '/health' || u === '/metrics';
    },
    errorResponseBuilder: (_req, c) => ({ statusCode: 429, code: 'rate_limited', message: `Too many requests. Try again in ${c.after}.` }),
  });

  await app.register(swagger, {
    openapi: {
      info: { title: 'Groundgraph API', version: '1.0.0', description: 'ABOVE / BELOW price markets on Solana plus the smart money radar. Wallet-only sign-in (SIWS), httpOnly session cookie. Amounts are decimal strings of base units (6 decimals).' },
      tags: [{ name: 'auth' }, { name: 'markets' }, { name: 'tx' }, { name: 'radar' }, { name: 'account' }, { name: 'ops' }, { name: 'devnet' }, { name: 'blinks' }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  /* ------------------------------ observability + headers ------------------------------ */

  const httpHist = new Histogram({ name: 'gg_http_request_duration_seconds', help: 'HTTP request duration', labelNames: ['method', 'route', 'status'], buckets: [0.005, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers: [ctx.registry] });
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? 'unmatched';
    const secs = reply.elapsedTime / 1000;
    httpHist.observe({ method: req.method, route, status: String(reply.statusCode) }, secs);
    if (route !== '/health' && route !== '/metrics') {
      ctx.log.info({ method: req.method, route, status: reply.statusCode, ms: Math.round(reply.elapsedTime), wallet: req.session?.wallet?.slice(0, 6) }, 'request');
    }
  });
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    if (!pathOf(req.url).startsWith('/docs')) {
      reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
      if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    }
    if (cfg.COOKIE_SECURE) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    return payload;
  });

  /* ------------------------------ errors ------------------------------ */

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string; validation?: unknown }, req, reply) => {
    let status = 500;
    let code: ApiErrorCodeT = 'internal';
    let message = 'Something went wrong on our side. Try again in a moment.';
    let details: unknown;
    if (err instanceof ApiHttpError) {
      status = err.status;
      code = err.code;
      message = err.message;
      details = err.details;
    } else if (hasZodFastifySchemaValidationErrors(err)) {
      status = 400;
      code = 'bad_request';
      message = 'Invalid request';
      details = (err.validation as { message?: string; instancePath?: string; params?: unknown }[]).map((v) => ({ path: v.instancePath, message: v.message }));
    } else if (err.statusCode === 429) {
      status = 429;
      code = 'rate_limited';
      message = err.message || 'Too many requests';
    } else if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      status = err.statusCode;
      code = 'bad_request';
      message = err.statusCode === 413 ? 'Request body too large' : err.message || 'Bad request';
    } else {
      req.log.error({ err: { message: err.message, stack: err.stack, code: err.code } }, 'unhandled error');
    }
    const body = errorBody(code, message, details);
    const blink = pathOf(req.url).startsWith('/actions/');
    return reply.code(status).send(blink ? { message, ...body } : body);
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send(errorBody('not_found', 'Route not found')));

  /* ------------------------------ routes ------------------------------ */

  await app.register(authRoutes(ctx));
  await app.register(marketRoutes(ctx));
  await app.register(txRoutes(ctx));
  await app.register(radarRoutes(ctx));
  await app.register(accountRoutes(ctx));
  await app.register(opsRoutes(ctx));
  await app.register(actionsRoutes(ctx));
  await app.register(ogRoutes(ctx));

  const subscriber = opts.subscriber ?? createSubscriber(cfg.REDIS_URL, 'gg-api-ws');
  const hub = new WsHub(ctx, { authenticate, subscriber, ...opts.hubTimers });
  app.addHook('onReady', async () => {
    await hub.start(app.server);
  });
  app.addHook('onClose', async () => {
    await hub.close();
    if (!opts.subscriber) subscriber.disconnect();
  });

  return { app: app as unknown as FastifyInstance, hub };
}

type ApiErrorCodeT = import('@groundgraph/sdk/api-types').ApiErrorCode;
