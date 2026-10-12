import { consumeNonce, deleteSession, getNonce, hasAcceptedTos, insertNonce, recordTosAcceptance, setSessionTos } from '@groundgraph/db';
import type { SessionResp } from '@groundgraph/sdk/api-types';
import type { FastifyPluginAsync } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { checkSiwsFields, isValidSolanaAddress, newNonce, NONCE_TTL_MS, SiwsError, tosStatement, verifyEd25519 } from '../auth/siws';
import { assertNotGeoBlocked, requireSession, requireSign, startSession, cookieOptions, type SessionCtx } from '../auth/session';
import type { AppContext } from '../context';
import { ApiHttpError, fail } from '../errors';
import { NonceRespSchema, SessionRespSchema, VerifyReqSchema } from '../schemas';

export async function sessionResp(ctx: AppContext, s: SessionCtx): Promise<SessionResp> {
  const accepted = s.mode === 'sign' ? await hasAcceptedTos(ctx.db.sql, s.wallet, ctx.cfg.TOS_VERSION) : false;
  return {
    wallet: s.wallet,
    mode: s.mode,
    walletName: s.walletName,
    tosVersion: accepted ? ctx.cfg.TOS_VERSION : null,
    tosAccepted: accepted,
    expiresAt: s.expiresAt.toISOString(),
  };
}

const authLimit = { rateLimit: { max: 30, timeWindow: '1 minute' } };

export const authRoutes = (ctx: AppContext): FastifyPluginAsync => async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.post('/auth/nonce', { config: authLimit, schema: { tags: ['auth'], body: z.object({ wallet: z.string() }), response: { 200: NonceRespSchema } } }, async (req) => {
    const { wallet } = req.body;
    if (!isValidSolanaAddress(wallet)) fail('bad_request', 'wallet must be a base58 Solana address');
    const now = ctx.now();
    const nonce = newNonce();
    const expiresAt = new Date(now.getTime() + NONCE_TTL_MS);
    await insertNonce(ctx.db.sql, { nonce, wallet, issuedAt: now, expiresAt });
    return {
      nonce,
      issuedAt: now.toISOString(),
      expirationTime: expiresAt.toISOString(),
      domain: ctx.cfg.siwsDomain,
      uri: ctx.cfg.siwsUri,
      statement: tosStatement(ctx.cfg.TOS_VERSION),
      tosVersion: ctx.cfg.TOS_VERSION,
      chainId: ctx.cfg.chainId,
    };
  });

  app.post('/auth/verify', { config: authLimit, schema: { tags: ['auth'], body: VerifyReqSchema, response: { 200: SessionRespSchema } } }, async (req, reply) => {
    assertNotGeoBlocked(ctx, req);
    const b = req.body;
    if (!b.tosAccepted) fail('tos_required', `Accept the Terms (version ${ctx.cfg.TOS_VERSION}) to sign in with a wallet`, { tosVersion: ctx.cfg.TOS_VERSION });
    if (!isValidSolanaAddress(b.wallet)) fail('bad_request', 'wallet must be a base58 Solana address');
    const now = ctx.now();
    let messageBytes: Buffer;
    let sigBytes: Buffer;
    try {
      messageBytes = Buffer.from(b.signedMessage, 'base64');
      sigBytes = Buffer.from(b.signature, 'base64');
    } catch {
      return fail('bad_request', 'signedMessage and signature must be base64');
    }
    const text = messageBytes.toString('utf8');
    let fields;
    try {
      fields = checkSiwsFields(text, {
        wallet: b.wallet,
        domain: ctx.cfg.siwsDomain,
        uri: ctx.cfg.siwsUri,
        chainId: ctx.cfg.chainId,
        tosVersion: ctx.cfg.TOS_VERSION,
        now,
      });
    } catch (err) {
      if (err instanceof SiwsError) return fail('bad_request', `Invalid sign-in message: ${err.message}`);
      throw err;
    }
    const nonceRow = await getNonce(ctx.db.sql, fields.nonce);
    if (!nonceRow || nonceRow.wallet !== b.wallet || nonceRow.used || nonceRow.expiresAt.getTime() <= now.getTime()) {
      return fail('unauthorized', 'Sign-in request expired or was already used. Start again.');
    }
    if (!verifyEd25519(messageBytes, sigBytes, b.wallet)) return fail('unauthorized', 'Signature verification failed');
    if (!(await consumeNonce(ctx.db.sql, fields.nonce, b.wallet, now))) {
      return fail('unauthorized', 'Sign-in request expired or was already used. Start again.');
    }
    await recordTosAcceptance(ctx.db.sql, {
      wallet: b.wallet,
      tosVersion: ctx.cfg.TOS_VERSION,
      signedMessage: b.signedMessage,
      signature: b.signature,
      ipCountry: req.ipCountry,
    });
    const s = await startSession(ctx, reply, { wallet: b.wallet, mode: 'sign', walletName: b.walletName ?? null, tosVersion: ctx.cfg.TOS_VERSION });
    return sessionResp(ctx, s);
  });

  app.post('/auth/view', { config: authLimit, schema: { tags: ['auth'], body: z.object({ address: z.string().max(100) }), response: { 200: SessionRespSchema } } }, async (req, reply) => {
    const address = req.body.address.trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x/i.test(address)) {
      fail('bad_request', 'That looks like an Ethereum (0x...) address. Groundgraph runs on Solana: paste a base58 address of 32 to 44 characters, for example one copied from Phantom or Solflare.', { reason: 'evm_address' });
    }
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) || !isValidSolanaAddress(address)) {
      fail('bad_request', 'Enter a valid Solana address (base58, 32 to 44 characters).', { reason: 'invalid_address' });
    }
    const s = await startSession(ctx, reply, { wallet: address, mode: 'view' });
    return sessionResp(ctx, s);
  });

  app.post('/auth/logout', { schema: { tags: ['auth'], response: { 200: z.object({ ok: z.literal(true) }) } } }, async (req, reply) => {
    if (req.session) await deleteSession(ctx.db.sql, req.session.id);
    reply.clearCookie(ctx.cfg.COOKIE_NAME, { ...cookieOptions(ctx), signed: false });
    return { ok: true as const };
  });

  app.get('/auth/session', { schema: { tags: ['auth'], response: { 200: SessionRespSchema } } }, async (req) => {
    return sessionResp(ctx, requireSession(req));
  });

  app.post('/auth/tos', { schema: { tags: ['auth'], body: z.object({ tosVersion: z.string() }), response: { 200: SessionRespSchema } } }, async (req) => {
    const s = requireSign(req);
    if (req.body.tosVersion !== ctx.cfg.TOS_VERSION) {
      throw new ApiHttpError('bad_request', `The current Terms version is ${ctx.cfg.TOS_VERSION}`, { tosVersion: ctx.cfg.TOS_VERSION });
    }
    assertNotGeoBlocked(ctx, req);
    await recordTosAcceptance(ctx.db.sql, {
      wallet: s.wallet,
      tosVersion: ctx.cfg.TOS_VERSION,
      signedMessage: `accepted in an authenticated session (${s.id.slice(0, 8)}) at ${ctx.now().toISOString()}`,
      signature: null,
      ipCountry: req.ipCountry,
    });
    await setSessionTos(ctx.db.sql, s.id, ctx.cfg.TOS_VERSION);
    return sessionResp(ctx, { ...s, tosVersion: ctx.cfg.TOS_VERSION });
  });
};
