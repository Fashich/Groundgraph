import type {} from '@fastify/cookie';
import { randomBytes } from 'node:crypto';
import { createSession, getSession, hasAcceptedTos, type SessionRow } from '@groundgraph/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { fail } from '../errors';

export interface SessionCtx {
  id: string;
  wallet: string;
  mode: 'sign' | 'view';
  walletName: string | null;
  tosVersion: string | null;
  expiresAt: Date;
}

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionCtx | null;
    clientIp: string;
    ipCountry: string | null;
  }
}

const COUNTRY_HEADERS = ['cf-ipcountry', 'x-vercel-ip-country', 'cloudfront-viewer-country', 'x-country-code', 'x-geo-country'];

export function countryOf(req: FastifyRequest): string | null {
  for (const h of COUNTRY_HEADERS) {
    const v = req.headers[h];
    const s = Array.isArray(v) ? v[0] : v;
    if (s && /^[A-Za-z]{2}$/.test(s) && s.toUpperCase() !== 'XX') return s.toUpperCase();
  }
  return null;
}

export function toSessionCtx(row: SessionRow): SessionCtx {
  return {
    id: row.id,
    wallet: row.wallet,
    mode: row.mode,
    walletName: row.walletName,
    tosVersion: row.tosVersion,
    expiresAt: row.expiresAt,
  };
}

export function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}

export async function startSession(
  ctx: AppContext,
  reply: FastifyReply,
  s: { wallet: string; mode: 'sign' | 'view'; walletName?: string | null; tosVersion?: string | null },
): Promise<SessionCtx> {
  const id = newSessionId();
  const now = ctx.now();
  const expiresAt = new Date(now.getTime() + ctx.cfg.SESSION_TTL_HOURS * 3600_000);
  await createSession(ctx.db.sql, { id, wallet: s.wallet, mode: s.mode, walletName: s.walletName ?? null, tosVersion: s.tosVersion ?? null, expiresAt });
  reply.setCookie(ctx.cfg.COOKIE_NAME, id, cookieOptions(ctx, expiresAt));
  return { id, wallet: s.wallet, mode: s.mode, walletName: s.walletName ?? null, tosVersion: s.tosVersion ?? null, expiresAt };
}

export function cookieOptions(ctx: AppContext, expires?: Date) {
  return {
    httpOnly: true,
    path: '/',
    sameSite: (ctx.cfg.COOKIE_STRICT ? 'strict' : 'lax') as 'strict' | 'lax',
    secure: ctx.cfg.COOKIE_SECURE,
    signed: true,
    ...(expires ? { expires } : {}),
  };
}

/** Resolve the session cookie of a request. Returns null for missing, tampered or expired cookies. */
export async function loadSession(ctx: AppContext, rawCookie: string | undefined, unsign: (v: string) => { valid: boolean; value: string | null }): Promise<SessionCtx | null> {
  if (!rawCookie) return null;
  const u = unsign(rawCookie);
  if (!u.valid || !u.value) return null;
  const row = await getSession(ctx.db.sql, u.value, ctx.now());
  return row ? toSessionCtx(row) : null;
}

export function requireSession(req: FastifyRequest): SessionCtx {
  if (!req.session) fail('unauthorized', 'Sign in or paste an address to continue');
  return req.session!;
}

export function requireSign(req: FastifyRequest): SessionCtx {
  const s = requireSession(req);
  if (s.mode !== 'sign') {
    fail('view_only', 'This is a view-only session. Connect a signing wallet to trade, create markets or redeem.');
  }
  return s;
}

/** Sign session whose wallet accepted the CURRENT Terms version (a version bump forces a re-accept). */
export async function requireSignWithTos(ctx: AppContext, req: FastifyRequest): Promise<SessionCtx> {
  const s = requireSign(req);
  if (!(await hasAcceptedTos(ctx.db.sql, s.wallet, ctx.cfg.TOS_VERSION))) {
    fail('tos_required', `Accept the Terms (version ${ctx.cfg.TOS_VERSION}) to continue`, { tosVersion: ctx.cfg.TOS_VERSION });
  }
  return s;
}

export function assertNotGeoBlocked(ctx: AppContext, req: FastifyRequest): void {
  const c = req.ipCountry;
  if (c && ctx.cfg.blockedCountries.has(c)) {
    fail('geo_blocked', 'Groundgraph is not available in your region.', { country: c });
  }
}
