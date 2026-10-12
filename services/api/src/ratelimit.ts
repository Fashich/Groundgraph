import type { FastifyRequest } from 'fastify';

/** Per-wallet rate limit key for signed-in routes, falling back to the client IP. */
export const walletKey = (req: FastifyRequest): string => (req.session?.wallet ? `w:${req.session.wallet}` : `ip:${req.clientIp || req.ip}`);
