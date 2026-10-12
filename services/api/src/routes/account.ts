import { notDemo } from '@groundgraph/db';
import { numericToBigInt } from '@groundgraph/svc-core';
import type { ActivityRow, MeResp, MarketStatus, Paged, PositionRow, UserSettings } from '@groundgraph/sdk/api-types';
import type { FastifyPluginAsync } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireSession, requireSign } from '../auth/session';
import { isValidSolanaAddress } from '../auth/siws';
import type { AppContext } from '../context';
import { fail } from '../errors';
import { walletKey } from '../ratelimit';
import { ActivityRowSchema, MeRespSchema, paged, PositionRowSchema, U64, UserSettingsSchema } from '../schemas';
import { loadSettings, setLimitAndReminder, startBreak, toUserSettings } from '../services/limits';
import { buildingRadar, effectiveStatusOf, radarSummaries, round } from '../services/markets';

const NEUTRAL_SETTINGS: UserSettings = { dailyLimitUsdc: null, breakUntil: null, sessionReminder: false, spentToday: '0' };
const ACTIVITY_PAGE = 30;
const MAX_TRACKED = 200;
const DISPUTES_PER_DAY = 5;

const usd = (b: bigint) => (Number(b) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (b: bigint) => (Number(b) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 });

interface PositionSql {
  marketId: string;
  side: 'above' | 'below';
  shares: string;
  costBasisUsdc: string;
  realizedPnl: string;
  question: string;
  status: 'open' | 'trading_closed' | 'settled' | 'voided';
  outcome: 'above' | 'below' | null;
  reserveAbove: string;
  reserveBelow: string;
  tradingEndTs: Date;
  settleTs: Date;
}

/** Exact bigint valuation of a position. Open markets are marked at the pool price, resolved ones at the payout. */
export function valuePosition(
  p: { side: 'above' | 'below'; shares: bigint; status: MarketStatus; outcome: 'above' | 'below' | null; reserveAbove: bigint; reserveBelow: bigint },
): { value: bigint; redeemable: bigint; markPrice: number } {
  if (p.status === 'settled') {
    const win = p.outcome === p.side;
    return { value: win ? p.shares : 0n, redeemable: win ? p.shares : 0n, markPrice: win ? 1 : 0 };
  }
  if (p.status === 'voided') {
    const half = p.shares / 2n;
    return { value: half, redeemable: half, markPrice: 0.5 };
  }
  const total = p.reserveAbove + p.reserveBelow;
  if (total === 0n) return { value: 0n, redeemable: 0n, markPrice: 0.5 };
  // price of ABOVE = reserveBelow / total, price of BELOW = reserveAbove / total
  const num = p.side === 'above' ? p.reserveBelow : p.reserveAbove;
  return { value: (p.shares * num) / total, redeemable: 0n, markPrice: Number((num * 1_000_000_000n) / total) / 1_000_000_000 };
}

export const accountRoutes = (ctx: AppContext): FastifyPluginAsync => async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const sql = ctx.db.sql;
  const demo = ctx.cfg.DEMO_MODE;
  const writeLimit = { rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: walletKey } };

  /* ------------------------------ me ------------------------------ */

  app.get('/me', { schema: { tags: ['account'], response: { 200: MeRespSchema } } }, async (req): Promise<MeResp> => {
    const s = requireSession(req);
    const rows = await sql<{ score: number; smart: boolean; reasons: unknown }[]>`
      SELECT s.score, s.smart, s.reasons FROM wallet_scores s
      LEFT JOIN wallets w ON w.address = s.address
      WHERE s.address = ${s.wallet} AND ${notDemo(sql, demo, 's.data_source')} AND COALESCE(w.label_hidden, false) = false
      ORDER BY s.as_of DESC LIMIT 1`;
    const r = rows[0];
    // a view session is somebody else's address: it never reads or creates responsible-trading settings
    const settings = s.mode === 'sign' ? toUserSettings(await loadSettings(ctx, s.wallet), ctx.now()) : NEUTRAL_SETTINGS;
    return {
      wallet: s.wallet,
      mode: s.mode,
      walletScore: r ? { score: r.score, smart: r.smart, reasons: Array.isArray(r.reasons) ? (r.reasons as unknown[]).filter((x): x is string => typeof x === 'string') : [] } : null,
      settings,
    };
  });

  /* ------------------------------ positions ------------------------------ */

  app.get(
    '/me/positions',
    { schema: { tags: ['account'], querystring: z.object({ tab: z.enum(['open', 'redeem', 'resolved']).default('open') }), response: { 200: z.array(PositionRowSchema) } } },
    async (req): Promise<PositionRow[]> => {
      const s = requireSession(req);
      const tab = req.query.tab;
      const filter =
        tab === 'open' ? sql`m.status = 'open' AND p.shares > 0` : tab === 'redeem' ? sql`m.status IN ('settled','voided') AND p.shares > 0` : sql`m.status IN ('settled','voided')`;
      const rows = await sql<PositionSql[]>`
        SELECT p.market_id, p.side, p.shares, p.cost_basis_usdc, p.realized_pnl, m.question, m.status, m.outcome,
               m.reserve_above, m.reserve_below, m.trading_end_ts, m.settle_ts
        FROM positions p JOIN markets m ON m.id = p.market_id
        WHERE p.wallet = ${s.wallet} AND ${filter}
        ORDER BY ${tab === 'open' ? sql`m.settle_ts ASC` : sql`m.settle_ts DESC`}, p.market_id, p.side
        LIMIT 200`;
      const now = ctx.now();
      const radar = await radarSummaries(ctx, [...new Set(rows.map((r) => r.marketId))]);
      const out: PositionRow[] = [];
      for (const r of rows) {
        const status = effectiveStatusOf(r.status, r.tradingEndTs, now);
        const shares = numericToBigInt(r.shares);
        const cost = numericToBigInt(r.costBasisUsdc);
        const realized = numericToBigInt(r.realizedPnl);
        const v = valuePosition({ side: r.side, shares, status, outcome: r.outcome, reserveAbove: numericToBigInt(r.reserveAbove), reserveBelow: numericToBigInt(r.reserveBelow) });
        if (tab === 'redeem' && v.redeemable === 0n) continue;
        out.push({
          marketId: r.marketId,
          question: r.question,
          side: r.side,
          shares: shares.toString(),
          avgPrice: shares > 0n ? round(Number(cost) / Number(shares), 4) : 0,
          costBasis: cost.toString(),
          markPrice: round(v.markPrice, 4),
          value: v.value.toString(),
          pnl: (v.value + realized - cost).toString(),
          status,
          outcome: r.outcome,
          redeemable: v.redeemable.toString(),
          radar: radar.get(r.marketId) ?? buildingRadar(),
          endsAt: r.settleTs.toISOString(),
        });
      }
      return out;
    },
  );

  /* ------------------------------ activity ------------------------------ */

  app.get(
    '/me/activity',
    { schema: { tags: ['account'], querystring: z.object({ cursor: z.string().max(80).optional() }), response: { 200: paged(ActivityRowSchema) } } },
    async (req): Promise<Paged<ActivityRow>> => {
      const s = requireSession(req);
      const m = req.query.cursor ? /^(\d{10,16})\.([a-z]\w{0,40})$/.exec(req.query.cursor) : null;
      if (req.query.cursor && !m) return fail('bad_request', 'Invalid cursor');
      const curTs = m ? new Date(Number(m[1])) : null;
      const curUid = m ? m[2]! : null;
      const w = s.wallet;
      const rows = await sql<
        { type: string; ts: Date; marketId: string | null; txSig: string | null; uid: string; side: string | null; usdc: string | null; shares: string | null; note: string | null }[]
      >`
        SELECT * FROM (
          SELECT t.direction AS type, date_trunc('milliseconds', t.ts) AS ts, t.market_id, t.tx_sig, 't' || lpad(t.id::text, 20, '0') AS uid,
                 t.side, t.usdc, t.shares, m.question AS note
            FROM trades t JOIN markets m ON m.id = t.market_id WHERE t.wallet = ${w}
          UNION ALL
          SELECT 'redeem', date_trunc('milliseconds', r.ts), r.market_id, r.tx_sig, 'r' || lpad(r.id::text, 20, '0'), r.side, r.usdc, r.shares, m.question
            FROM redemptions r JOIN markets m ON m.id = r.market_id WHERE r.wallet = ${w}
          UNION ALL
          SELECT 'merge', date_trunc('milliseconds', g.ts), g.market_id, g.tx_sig, 'g' || lpad(g.id::text, 20, '0'), NULL::text, g.amount, g.amount, m.question
            FROM merges g JOIN markets m ON m.id = g.market_id WHERE g.wallet = ${w}
          UNION ALL
          SELECT 'create', date_trunc('milliseconds', c.created_at), c.id, c.created_tx, 'c' || c.id, NULL::text, NULL::numeric, NULL::numeric, c.question
            FROM markets c WHERE c.creator = ${w}
          UNION ALL
          SELECT a.type, date_trunc('milliseconds', a.ts), a.market_id, a.tx_sig, 'a' || lpad(a.id::text, 20, '0'), NULL::text, NULL::numeric, NULL::numeric, a.summary
            FROM user_activity a WHERE a.wallet = ${w}
        ) u
        WHERE (${curTs}::timestamptz IS NULL OR (u.ts, u.uid) < (${curTs}::timestamptz, ${curUid}::text))
        ORDER BY u.ts DESC, u.uid DESC LIMIT ${ACTIVITY_PAGE + 1}`;
      const page = rows.slice(0, ACTIVITY_PAGE);
      const items: ActivityRow[] = page.map((r) => {
        const usdc = r.usdc === null ? 0n : numericToBigInt(r.usdc);
        const shares = r.shares === null ? 0n : numericToBigInt(r.shares);
        const side = (r.side ?? '').toUpperCase();
        const q = r.note ? ` · ${r.note}` : '';
        let summary: string;
        switch (r.type) {
          case 'buy': summary = `Bought ${qty(shares)} ${side} for $${usd(usdc)}${q}`; break;
          case 'sell': summary = `Sold ${qty(shares)} ${side} for $${usd(usdc)}${q}`; break;
          case 'redeem': summary = `Redeemed ${qty(shares)} ${side} for $${usd(usdc)}${q}`; break;
          case 'merge': summary = `Merged ${qty(shares)} ABOVE + ${qty(shares)} BELOW into $${usd(usdc)}${q}`; break;
          case 'create': summary = `Created market${q}`; break;
          default: summary = r.note ?? r.type;
        }
        return {
          ts: r.ts.toISOString(),
          type: r.type as ActivityRow['type'],
          ...(r.marketId ? { marketId: r.marketId } : {}),
          summary,
          ...(r.txSig ? { txSig: r.txSig } : {}),
        };
      });
      const last = page[page.length - 1];
      return { items, nextCursor: rows.length > ACTIVITY_PAGE && last ? `${last.ts.getTime()}.${last.uid}` : null };
    },
  );

  /* ------------------------------ responsible trading ------------------------------ */

  app.put(
    '/me/settings',
    {
      config: writeLimit,
      schema: {
        tags: ['account'],
        body: z.object({ dailyLimitUsdc: U64.nullable(), sessionReminder: z.boolean() }),
        response: { 200: UserSettingsSchema },
      },
    },
    async (req): Promise<UserSettings> => {
      const s = requireSign(req);
      const limit = req.body.dailyLimitUsdc;
      if (limit !== null && BigInt(limit) <= 0n) return fail('bad_request', 'dailyLimitUsdc must be positive, or null for no limit');
      const row = await setLimitAndReminder(ctx, s.wallet, limit === null ? null : BigInt(limit).toString(), req.body.sessionReminder);
      return toUserSettings(row, ctx.now());
    },
  );

  app.post(
    '/me/break',
    {
      config: writeLimit,
      schema: { tags: ['account'], body: z.object({ days: z.union([z.literal(1), z.literal(7), z.literal(30)]) }), response: { 200: UserSettingsSchema } },
    },
    async (req): Promise<UserSettings> => {
      const s = requireSign(req);
      return toUserSettings(await startBreak(ctx, s.wallet, req.body.days), ctx.now());
    },
  );

  /* ------------------------------ watch / track ------------------------------ */

  app.post(
    '/me/watch/:marketId',
    { config: writeLimit, schema: { tags: ['account'], params: z.object({ marketId: z.string().min(32).max(44) }), response: { 200: z.object({ watching: z.boolean() }) } } },
    async (req) => {
      const s = requireSign(req);
      const id = req.params.marketId;
      const exists = await sql`SELECT 1 FROM markets WHERE id = ${id}`;
      if (exists.length === 0) return fail('not_found', 'Market not found');
      const removed = await sql`DELETE FROM watchlist WHERE wallet = ${s.wallet} AND market_id = ${id} RETURNING 1`;
      if (removed.length > 0) return { watching: false };
      await sql`INSERT INTO watchlist (wallet, market_id) VALUES (${s.wallet}, ${id}) ON CONFLICT DO NOTHING`;
      return { watching: true };
    },
  );

  app.post(
    '/me/track/:wallet',
    { config: writeLimit, schema: { tags: ['account'], params: z.object({ wallet: z.string().min(32).max(44) }), response: { 200: z.object({ tracking: z.boolean() }) } } },
    async (req) => {
      const s = requireSign(req);
      const target = req.params.wallet;
      if (!isValidSolanaAddress(target)) return fail('bad_request', 'Not a valid Solana address');
      if (target === s.wallet) return fail('bad_request', 'You cannot track your own wallet');
      const removed = await sql`DELETE FROM tracked_wallets WHERE owner_wallet = ${s.wallet} AND target_wallet = ${target} RETURNING 1`;
      if (removed.length > 0) return { tracking: false };
      const count = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM tracked_wallets WHERE owner_wallet = ${s.wallet}`;
      if ((count[0]?.n ?? 0) >= MAX_TRACKED) return fail('bad_request', `You can track up to ${MAX_TRACKED} wallets`);
      await sql`INSERT INTO tracked_wallets (owner_wallet, target_wallet) VALUES (${s.wallet}, ${target}) ON CONFLICT DO NOTHING`;
      return { tracking: true };
    },
  );

  /* ------------------------------ disputes ------------------------------ */

  app.post(
    '/flags/dispute',
    { config: writeLimit, schema: { tags: ['account'], body: z.object({ message: z.string().trim().min(10).max(1500) }), response: { 200: z.object({ id: z.string() }) } } },
    async (req) => {
      // sent from the wallet in question: only a signed-in owner of the wallet can dispute its label
      const s = requireSign(req);
      const day = ctx.now().toISOString().slice(0, 10);
      const key = `dispute:${s.wallet}:${day}`;
      const n = await ctx.redis.incr(key);
      if (n === 1) await ctx.redis.expire(key, 86_400 + 3600);
      if (n > DISPUTES_PER_DAY) return fail('rate_limited', 'Too many disputes today. We will review the ones already sent.');
      const rows = await sql<{ id: number }[]>`INSERT INTO flag_disputes (wallet, message) VALUES (${s.wallet}, ${req.body.message}) RETURNING id`;
      return { id: String(rows[0]!.id) };
    },
  );
};
