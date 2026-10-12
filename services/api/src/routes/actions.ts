import { hasAcceptedTos } from '@groundgraph/db';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import type { FastifyPluginAsync } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { assertNotGeoBlocked } from '../auth/session';
import { isValidSolanaAddress } from '../auth/siws';
import type { AppContext } from '../context';
import { ApiHttpError, fail } from '../errors';
import { getMarketSummary } from '../services/markets';
import { buildBuy, DEFAULT_SLIPPAGE_BPS } from '../services/txbuild';

export const ACTION_VERSION = '2.1.3';
export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const BLOCKCHAIN_IDS: Record<string, string> = {
  devnet: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  'mainnet-beta': 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  testnet: 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z',
};
const PRESETS = [10, 50];

/** Memo carried by every Blink transaction: records the Terms version the wallet accepted. */
export function blinkMemo(tosVersion: string, side: string, marketId: string): TransactionInstruction {
  return new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(`groundgraph blink tos:${tosVersion} buy ${side} ${marketId.slice(0, 8)}`) });
}

const cents = (p: number) => `${Math.round(p * 100)}¢`;

export const actionsRoutes = (ctx: AppContext): FastifyPluginAsync => async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const cluster = ctx.cfg.SOLANA_CLUSTER;
  const api = ctx.cfg.PUBLIC_API_URL.replace(/\/+$/, '');
  const termsUrl = `${ctx.cfg.WEB_ORIGIN.replace(/\/+$/, '')}/terms`;

  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Action-Version', ACTION_VERSION);
    reply.header('X-Blockchain-Ids', BLOCKCHAIN_IDS[cluster] ?? BLOCKCHAIN_IDS.devnet!);
  });

  app.get('/actions.json', { schema: { tags: ['blinks'] } }, async () => ({
    rules: [
      { pathPattern: '/m/*', apiPath: `${api}/api/actions/m/*` },
      { pathPattern: '/api/actions/**', apiPath: `${api}/api/actions/**` },
    ],
  }));

  app.get(
    '/actions/m/:id',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } }, schema: { tags: ['blinks'], params: z.object({ id: z.string().min(32).max(44) }) } },
    async (req) => {
      const m = await getMarketSummary(ctx, req.params.id);
      if (!m) return fail('not_found', 'Market not found');
      const base = `${api}/api/actions/m/${m.id}`;
      const radar =
        m.radar.state === 'ready' && m.radar.p !== null
          ? ` Radar P(above) ${Math.round(m.radar.p * 100)}%${m.radar.ci !== null ? ` ±${m.radar.ci}` : ''} from ${m.radar.n} flagged wallets.`
          : ' Radar is still building.';
      const description =
        `ABOVE ${cents(m.priceAbove)} (${Math.round(m.priceAbove * 100)}% implied) · BELOW ${cents(1 - m.priceAbove)}.${radar} ` +
        `A winning share settles at $1, a losing share at $0. ${cluster === 'mainnet-beta' ? '' : 'Solana devnet, unaudited. '}` +
        `By buying you accept the Terms (version ${ctx.cfg.TOS_VERSION}): ${termsUrl}`;
      const out: Record<string, unknown> = {
        type: 'action',
        icon: `${api}/og/m/${m.id}.png`,
        title: m.question,
        description,
        label: 'Buy',
      };
      if (m.status !== 'open') {
        out.disabled = true;
        out.label = 'Closed';
        out.error = { message: m.status === 'trading_closed' ? 'Trading has ended for this market.' : 'This market has resolved.' };
        return out;
      }
      const actions: unknown[] = [];
      for (const side of ['above', 'below'] as const) {
        for (const amt of PRESETS) actions.push({ type: 'transaction', label: `Buy ${side.toUpperCase()} $${amt}`, href: `${base}?side=${side}&amount=${amt}` });
        actions.push({
          type: 'transaction',
          label: `Buy ${side.toUpperCase()}`,
          href: `${base}?side=${side}&amount={amount}`,
          parameters: [{ name: 'amount', label: 'USDC amount (minimum 1)', type: 'number', required: true, min: 1 }],
        });
      }
      out.links = { actions };
      return out;
    },
  );

  app.post(
    '/actions/m/:id',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['blinks'],
        params: z.object({ id: z.string().min(32).max(44) }),
        querystring: z.object({ side: z.enum(['above', 'below']), amount: z.coerce.number().positive().max(1_000_000) }),
        body: z.object({ account: z.string().min(32).max(44) }),
      },
    },
    async (req) => {
      const { account } = req.body;
      if (!isValidSolanaAddress(account)) return fail('bad_request', 'account must be a base58 Solana address');
      assertNotGeoBlocked(ctx, req);
      if (!(await hasAcceptedTos(ctx.db.sql, account, ctx.cfg.TOS_VERSION))) {
        throw new ApiHttpError(
          'tos_required',
          `Accept the Terms (version ${ctx.cfg.TOS_VERSION}) once in the Groundgraph app with this wallet, then try again: ${termsUrl}`,
          { tosVersion: ctx.cfg.TOS_VERSION, termsUrl },
        );
      }
      const { side, amount } = req.query;
      const base = BigInt(Math.round(amount * 1e6));
      const sess = { id: 'blink', wallet: account, mode: 'sign' as const, walletName: null, tosVersion: ctx.cfg.TOS_VERSION, expiresAt: new Date(ctx.now().getTime() + 60_000) };
      const tx = await buildBuy(ctx, sess, { marketId: req.params.id, side, amount: base.toString(), slippageBps: DEFAULT_SLIPPAGE_BPS }, { extraIx: [blinkMemo(ctx.cfg.TOS_VERSION, side, req.params.id)] });
      return { type: 'transaction', transaction: tx.transaction, message: tx.summary };
    },
  );
};
