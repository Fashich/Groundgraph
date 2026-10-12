/**
 * Database writes of the indexer. Every function is idempotent: events are keyed by (tx_sig, ix_index), derived tables
 * (positions, scored_positions, lp_positions) are rebuilt from the event tables, so replays, out-of-order backfill and
 * restarts always converge to the same rows.
 */
import { addSpent, utcDay, type Sql } from '@groundgraph/db';
import {
  assetByFeedId,
  buildQuestion,
  categoryFor,
  feeBpsNow,
  numericToBigInt,
  rawToDecimalString,
  seedReserves,
  type ChainMarket,
  type NormEvent,
} from '@groundgraph/svc-core';
import type { DecodedTx } from './decode';
import { foldPositions, weightedEntryPrice, type PosEvent, type Side } from './positions';

export const MAX_FEE_BPS_DISPLAY = 300;

export interface ApplyOptions {
  now: Date;
  defaultLimit: bigint;
  /** creator supplied question text per market id (Redis q:pending:{id}) */
  questions?: ReadonlyMap<string, string>;
}

/** Messages to publish after the database transaction committed. */
export type Outgoing =
  | { channel: 'market'; marketId: string; data: Record<string, unknown> }
  | { channel: 'me'; wallet: string; data: Record<string, unknown> }
  | { channel: 'me-market'; marketId: string; data: Record<string, unknown> };

export interface ApplyResult {
  /** event rows that did not exist before */
  inserted: number;
  /** event rows that already existed (replay) */
  duplicates: number;
  /** names of the events seen, for metrics */
  names: string[];
  markets: Set<string>;
  out: Outgoing[];
  /** buy / create reservations to drop from Redis (rt:pending:{wallet}) */
  reservations: { wallet: string; usdc: string }[];
  /** Redis question keys that were consumed */
  consumedQuestions: string[];
}

const sec = (s: number) => new Date(s * 1000);

interface InsertOutcome {
  /** the row did not exist before */
  fresh: boolean;
  /** the row exists (new, or updated because the slot changed) */
  changed: boolean;
  id: number | null;
}

function outcomeOf(rows: { id: number; inserted: boolean }[]): InsertOutcome {
  const r = rows[0];
  if (!r) return { fresh: false, changed: false, id: null };
  return { fresh: r.inserted, changed: true, id: r.id };
}

/** Insert a market from its creation event. Returns whether the row is new. */
async function insertCreatedMarket(
  t: Sql,
  ev: Extract<NormEvent, { name: 'MarketCreated' }>,
  tx: DecodedTx,
  question: string | undefined,
): Promise<boolean> {
  const asset = assetByFeedId(ev.feedIdHex);
  const symbol = asset?.symbol ?? `FEED-${ev.feedIdHex.slice(0, 8)}`;
  const target = rawToDecimalString(ev.targetPrice, ev.targetExpo);
  let seed: { reserveAbove: bigint; reserveBelow: bigint };
  try {
    seed = seedReserves(ev.liquidity, ev.p0Bps);
  } catch {
    seed = { reserveAbove: ev.liquidity, reserveBelow: ev.liquidity };
  }
  const text =
    question ??
    buildQuestion({ assetSymbol: symbol, kind: ev.kind, ...(ev.kind === 'touch' ? { direction: 'up' as const } : {}), targetPrice: Number(target), settleTs: ev.settleTs });
  const rows = await t<{ inserted: boolean }[]>`INSERT INTO markets (id, creator, kind, direction, asset_symbol, feed_id, target_price, target_expo, target_raw,
      open_ts, trading_end_ts, settle_ts, base_fee_bps, dynamic_fee, question, category, status, above_mint, below_mint, lp_mint, vault,
      reserve_above, reserve_below, complete_sets, fee_pool, ema_impact_bps, ema_ts, created_tx, created_slot, last_slot)
    VALUES (${ev.market}, ${ev.creator}, ${ev.kind}, ${null}, ${symbol}, ${ev.feedIdHex}, ${target}, ${ev.targetExpo}, ${ev.targetPrice.toString()},
      ${sec(tx.ts)}, ${sec(ev.tradingEndTs)}, ${sec(ev.settleTs)}, ${ev.baseFeeBps}, ${ev.dynamicFee}, ${text}, ${categoryFor(symbol)}, 'open',
      ${ev.aboveMint}, ${ev.belowMint}, ${ev.lpMint}, ${ev.vault}, ${seed.reserveAbove.toString()}, ${seed.reserveBelow.toString()},
      ${ev.liquidity.toString()}, 0, 0, ${tx.ts}, ${tx.signature}, ${tx.slot}, ${tx.slot})
    ON CONFLICT (id) DO UPDATE SET
      created_tx = COALESCE(markets.created_tx, EXCLUDED.created_tx),
      created_slot = CASE WHEN markets.created_tx IS NULL OR markets.created_tx = EXCLUDED.created_tx THEN EXCLUDED.created_slot ELSE markets.created_slot END,
      open_ts = CASE WHEN markets.created_tx IS NULL THEN EXCLUDED.open_ts ELSE markets.open_ts END
    RETURNING (xmax = 0) AS inserted`;
  return rows[0]?.inserted === true;
}

/** Market row for a market that exists on chain but whose creation event was never seen (history before the cursor). */
export async function insertMarketFromChain(t: Sql, m: ChainMarket, question?: string): Promise<boolean> {
  const asset = assetByFeedId(m.feedIdHex);
  const symbol = asset?.symbol ?? `FEED-${m.feedIdHex.slice(0, 8)}`;
  const target = rawToDecimalString(m.targetPrice, m.targetExpo);
  const text =
    question ??
    buildQuestion({ assetSymbol: symbol, kind: m.kind, ...(m.kind === 'touch' ? { direction: m.direction ?? ('up' as const) } : {}), targetPrice: Number(target), settleTs: m.settleTs });
  const settled = m.status !== 'open';
  const rows = await t<{ id: string }[]>`INSERT INTO markets (id, creator, kind, direction, asset_symbol, feed_id, target_price, target_expo, target_raw,
      open_ts, trading_end_ts, settle_ts, base_fee_bps, dynamic_fee, question, category, status, outcome, settle_price, settle_expo, settle_publish_ts,
      above_mint, below_mint, lp_mint, vault, reserve_above, reserve_below, complete_sets, fee_pool, ema_impact_bps, ema_ts,
      lp_claim_remaining, lp_supply_remaining)
    VALUES (${m.id}, ${m.creator}, ${m.kind}, ${m.direction}, ${symbol}, ${m.feedIdHex}, ${target}, ${m.targetExpo}, ${m.targetPrice.toString()},
      ${sec(m.openTs)}, ${sec(m.tradingEndTs)}, ${sec(m.settleTs)}, ${m.baseFeeBps}, ${m.dynamicFee}, ${text}, ${categoryFor(symbol)}, ${m.status}, ${m.outcome},
      ${settled && m.outcome ? rawToDecimalString(m.settlePrice, m.settleExpo) : null}, ${settled ? m.settleExpo : null}, ${settled ? sec(m.settlePublishTs) : null},
      ${m.aboveMint}, ${m.belowMint}, ${m.lpMint}, ${m.vault}, ${m.reserveAbove.toString()}, ${m.reserveBelow.toString()}, ${m.completeSets.toString()},
      ${m.feePool.toString()}, ${m.emaImpactBps}, ${m.emaTs}, ${m.lpClaimRemaining.toString()}, ${m.lpSupplyRemaining.toString()})
    ON CONFLICT (id) DO NOTHING RETURNING id`;
  return rows.length > 0;
}

/** Apply one decoded transaction atomically. Safe to call any number of times with the same transaction. */
export async function applyTx(sql: Sql, tx: DecodedTx, o: ApplyOptions): Promise<ApplyResult> {
  const result: ApplyResult = { inserted: 0, duplicates: 0, names: [], markets: new Set(), out: [], reservations: [], consumedQuestions: [] };
  const today = utcDay(o.now) === utcDay(sec(tx.ts));
  await sql.begin(async (t0) => {
    const t = t0 as unknown as Sql;
    const posKeys = new Map<string, [string, string]>();
    const lpKeys = new Map<string, [string, string]>();
    const touchPos = (wallet: string, market: string) => posKeys.set(`${wallet}|${market}`, [wallet, market]);
    const touchLp = (wallet: string, market: string) => lpKeys.set(`${wallet}|${market}`, [wallet, market]);
    const note = (fresh: boolean) => (fresh ? result.inserted++ : result.duplicates++);

    for (const { ix, ev } of tx.events) {
      result.names.push(ev.name);
      switch (ev.name) {
        case 'MarketCreated': {
          const q = o.questions?.get(ev.market);
          const fresh = await insertCreatedMarket(t, ev, tx, q);
          let seedAbove = 0n;
          let seedBelow = 0n;
          try {
            const s = seedReserves(ev.liquidity, ev.p0Bps);
            seedAbove = s.creatorAbove;
            seedBelow = s.creatorBelow;
          } catch {
            /* invalid p0: no seeded shares */
          }
          await t`INSERT INTO liquidity_events (wallet, market_id, kind, lp_amount, usdc, seed_above, seed_below, p0_bps, tx_sig, ix_index, slot, ts)
            VALUES (${ev.creator}, ${ev.market}, 'create', ${ev.liquidity.toString()}, ${ev.liquidity.toString()}, ${seedAbove.toString()}, ${seedBelow.toString()},
              ${ev.p0Bps}, ${tx.signature}, ${ix}, ${tx.slot}, ${sec(tx.ts)})
            ON CONFLICT (tx_sig, ix_index) DO UPDATE SET slot = EXCLUDED.slot, ts = EXCLUDED.ts, finalized = false WHERE liquidity_events.slot <> EXCLUDED.slot`;
          note(fresh);
          result.markets.add(ev.market);
          touchPos(ev.creator, ev.market);
          touchLp(ev.creator, ev.market);
          if (fresh) {
            if (q) result.consumedQuestions.push(ev.market);
            if (today) await addSpent(t, ev.creator, ev.liquidity.toString(), o.now, o.defaultLimit);
            result.reservations.push({ wallet: ev.creator, usdc: ev.liquidity.toString() });
            result.out.push({ channel: 'me', wallet: ev.creator, data: { kind: 'created', marketId: ev.market, txSig: tx.signature } });
          }
          break;
        }
        case 'Trade': {
          const ts = ev.ts > 0 ? ev.ts : tx.ts;
          const priceAfter = (ev.priceAfterBps / 10_000).toFixed(4);
          const rows = await t<{ id: number; inserted: boolean }[]>`INSERT INTO trades (market_id, wallet, side, direction, usdc, shares, fee_usdc, price_after, tx_sig, ix_index, slot, ts)
            VALUES (${ev.market}, ${ev.wallet}, ${ev.side}, ${ev.isBuy ? 'buy' : 'sell'}, ${ev.usdc.toString()}, ${ev.shares.toString()}, ${ev.feeUsdc.toString()},
              ${priceAfter}, ${tx.signature}, ${ix}, ${tx.slot}, ${sec(ts)})
            ON CONFLICT (tx_sig, ix_index) DO UPDATE SET slot = EXCLUDED.slot, ts = EXCLUDED.ts, finalized = false WHERE trades.slot <> EXCLUDED.slot
            RETURNING id, (xmax = 0) AS inserted`;
          const oc = outcomeOf(rows);
          note(oc.fresh || !oc.changed ? oc.fresh : true);
          if (!oc.changed) {
            // exact replay: nothing to write or publish, but the market still counts as touched for the post-batch refresh
            result.markets.add(ev.market);
            touchPos(ev.wallet, ev.market);
            break;
          }
          await t`UPDATE markets SET reserve_above = ${ev.reserveAbove.toString()}, reserve_below = ${ev.reserveBelow.toString()},
            last_slot = ${tx.slot}, updated_at = now() WHERE id = ${ev.market} AND last_slot <= ${tx.slot}`;
          await t`INSERT INTO market_ticks (market_id, ts, price_above, reserve_above, reserve_below, fee_bps)
            VALUES (${ev.market}, ${sec(ts)}, ${priceAfter}, ${ev.reserveAbove.toString()}, ${ev.reserveBelow.toString()}, ${ev.feeBps})
            ON CONFLICT (market_id, ts) DO UPDATE SET price_above = EXCLUDED.price_above, reserve_above = EXCLUDED.reserve_above,
              reserve_below = EXCLUDED.reserve_below, fee_bps = EXCLUDED.fee_bps`;
          result.markets.add(ev.market);
          touchPos(ev.wallet, ev.market);
          if (oc.fresh) {
            if (ev.isBuy) {
              if (today) await addSpent(t, ev.wallet, ev.usdc.toString(), o.now, o.defaultLimit);
              result.reservations.push({ wallet: ev.wallet, usdc: ev.usdc.toString() });
            }
            result.out.push({
              channel: 'market',
              marketId: ev.market,
              data: {
                priceAbove: ev.priceAfterBps / 10_000,
                reserveAbove: ev.reserveAbove.toString(),
                reserveBelow: ev.reserveBelow.toString(),
                feeBps: ev.feeBps,
                trade: {
                  id: String(oc.id),
                  ts: sec(ts).toISOString(),
                  wallet: ev.wallet,
                  side: ev.side,
                  dir: ev.isBuy ? 'buy' : 'sell',
                  usdc: ev.usdc.toString(),
                  shares: ev.shares.toString(),
                  feeUsdc: ev.feeUsdc.toString(),
                  priceAfter: Number(priceAfter),
                  txSig: tx.signature,
                  flagged: false,
                },
              },
            });
            result.out.push({
              channel: 'me',
              wallet: ev.wallet,
              data: {
                kind: 'fill',
                marketId: ev.market,
                txSig: tx.signature,
                side: ev.side,
                dir: ev.isBuy ? 'buy' : 'sell',
                usdc: ev.usdc.toString(),
                shares: ev.shares.toString(),
                priceAfter: Number(priceAfter),
              },
            });
          }
          break;
        }
        case 'Settled': {
          await t`UPDATE markets SET status = 'settled', outcome = ${ev.outcome}, settle_price = ${rawToDecimalString(ev.price, ev.expo)}, settle_expo = ${ev.expo},
            settle_publish_ts = ${sec(ev.publishTs)}, lp_claim_remaining = ${ev.lpClaim.toString()}, last_slot = GREATEST(last_slot, ${tx.slot}), updated_at = now()
            WHERE id = ${ev.market}`;
          result.markets.add(ev.market);
          result.out.push({ channel: 'market', marketId: ev.market, data: { status: 'settled', outcome: ev.outcome, settlePrice: rawToDecimalString(ev.price, ev.expo) } });
          result.out.push({ channel: 'me-market', marketId: ev.market, data: { kind: 'settled', marketId: ev.market, outcome: ev.outcome } });
          note(true);
          break;
        }
        case 'Voided': {
          await t`UPDATE markets SET status = 'voided', outcome = NULL, lp_claim_remaining = ${ev.lpClaim.toString()}, last_slot = GREATEST(last_slot, ${tx.slot}), updated_at = now()
            WHERE id = ${ev.market}`;
          result.markets.add(ev.market);
          result.out.push({ channel: 'market', marketId: ev.market, data: { status: 'voided' } });
          result.out.push({ channel: 'me-market', marketId: ev.market, data: { kind: 'voided', marketId: ev.market } });
          note(true);
          break;
        }
        case 'Redeemed': {
          const rows = await t<{ id: number; inserted: boolean }[]>`INSERT INTO redemptions (wallet, market_id, side, shares, usdc, tx_sig, ix_index, slot, ts)
            VALUES (${ev.wallet}, ${ev.market}, ${ev.side}, ${ev.shares.toString()}, ${ev.usdc.toString()}, ${tx.signature}, ${ix}, ${tx.slot}, ${sec(tx.ts)})
            ON CONFLICT (tx_sig, ix_index) DO UPDATE SET slot = EXCLUDED.slot, ts = EXCLUDED.ts, finalized = false WHERE redemptions.slot <> EXCLUDED.slot
            RETURNING id, (xmax = 0) AS inserted`;
          const oc = outcomeOf(rows);
          note(oc.fresh);
          result.markets.add(ev.market);
          touchPos(ev.wallet, ev.market);
          if (oc.fresh) {
            result.out.push({
              channel: 'me',
              wallet: ev.wallet,
              data: { kind: 'redeemed', marketId: ev.market, txSig: tx.signature, side: ev.side, shares: ev.shares.toString(), usdc: ev.usdc.toString() },
            });
          }
          break;
        }
        case 'Merged': {
          const rows = await t<{ id: number; inserted: boolean }[]>`INSERT INTO merges (wallet, market_id, amount, tx_sig, ix_index, slot, ts)
            VALUES (${ev.wallet}, ${ev.market}, ${ev.amount.toString()}, ${tx.signature}, ${ix}, ${tx.slot}, ${sec(tx.ts)})
            ON CONFLICT (tx_sig, ix_index) DO UPDATE SET slot = EXCLUDED.slot, ts = EXCLUDED.ts, finalized = false WHERE merges.slot <> EXCLUDED.slot
            RETURNING id, (xmax = 0) AS inserted`;
          const oc = outcomeOf(rows);
          note(oc.fresh);
          result.markets.add(ev.market);
          touchPos(ev.wallet, ev.market);
          if (oc.fresh) {
            result.out.push({ channel: 'me', wallet: ev.wallet, data: { kind: 'merged', marketId: ev.market, txSig: tx.signature, amount: ev.amount.toString() } });
          }
          break;
        }
        case 'LiquidityChanged': {
          const rows = await t<{ id: number; inserted: boolean }[]>`INSERT INTO liquidity_events (wallet, market_id, kind, lp_amount, usdc, tx_sig, ix_index, slot, ts)
            VALUES (${ev.wallet}, ${ev.market}, ${ev.isAdd ? 'add' : 'remove'}, ${ev.lpAmount.toString()}, ${ev.usdc.toString()}, ${tx.signature}, ${ix}, ${tx.slot}, ${sec(tx.ts)})
            ON CONFLICT (tx_sig, ix_index) DO UPDATE SET slot = EXCLUDED.slot, ts = EXCLUDED.ts, finalized = false WHERE liquidity_events.slot <> EXCLUDED.slot
            RETURNING id, (xmax = 0) AS inserted`;
          const oc = outcomeOf(rows);
          note(oc.fresh);
          result.markets.add(ev.market);
          touchLp(ev.wallet, ev.market);
          if (oc.fresh) {
            result.out.push({
              channel: 'me',
              wallet: ev.wallet,
              data: { kind: 'liquidity', marketId: ev.market, txSig: tx.signature, isAdd: ev.isAdd, lpAmount: ev.lpAmount.toString(), usdc: ev.usdc.toString() },
            });
          }
          break;
        }
      }
    }
    for (const [wallet, market] of posKeys.values()) await rebuildPosition(t, wallet, market);
    for (const [wallet, market] of lpKeys.values()) await rebuildLp(t, wallet, market);
  });
  return result;
}

/* ------------------------------ derived tables ------------------------------ */

interface EventRow {
  kind: 'buy' | 'sell' | 'redeem' | 'merge' | 'seed';
  side: Side | null;
  usdc: string;
  shares: string;
  p0Bps: number | null;
}

/** Rebuild one wallet's positions in one market from its events (positions, scored_positions). */
export async function rebuildPosition(t: Sql, wallet: string, marketId: string): Promise<void> {
  // serialize rebuilds of the same market across processes (live indexer + backfill CLI): events are read after the lock
  await t`SELECT 1 FROM markets WHERE id = ${marketId} FOR UPDATE`;
  const rows = await t<EventRow[]>`
    SELECT kind, side, usdc, shares, p0_bps FROM (
      SELECT CASE WHEN direction = 'buy' THEN 'buy' ELSE 'sell' END AS kind, side, usdc, shares, NULL::integer AS p0_bps, slot, ts, tx_sig, ix_index
        FROM trades WHERE wallet = ${wallet} AND market_id = ${marketId}
      UNION ALL SELECT 'redeem', side, usdc, shares, NULL::integer, slot, ts, tx_sig, ix_index FROM redemptions WHERE wallet = ${wallet} AND market_id = ${marketId}
      UNION ALL SELECT 'merge', NULL::text, amount, amount, NULL::integer, slot, ts, tx_sig, ix_index FROM merges WHERE wallet = ${wallet} AND market_id = ${marketId}
      UNION ALL SELECT 'seed', NULL::text, seed_above, seed_below, p0_bps, slot, ts, tx_sig, ix_index FROM liquidity_events
        WHERE wallet = ${wallet} AND market_id = ${marketId} AND kind = 'create'
    ) e ORDER BY slot, ts, tx_sig, ix_index`;
  const events: PosEvent[] = rows.map((r) => {
    switch (r.kind) {
      case 'buy':
      case 'sell':
      case 'redeem':
        return { kind: r.kind, side: r.side as Side, usdc: numericToBigInt(r.usdc), shares: numericToBigInt(r.shares) };
      case 'merge':
        return { kind: 'merge', amount: numericToBigInt(r.usdc) };
      case 'seed':
        return { kind: 'seed', seedAbove: numericToBigInt(r.usdc), seedBelow: numericToBigInt(r.shares), p0Bps: r.p0Bps ?? 5000 };
    }
  });
  const pos = foldPositions(events);
  await t`DELETE FROM positions WHERE wallet = ${wallet} AND market_id = ${marketId}`;
  for (const side of ['above', 'below'] as const) {
    const p = pos[side];
    if (!p.touched) continue;
    await t`INSERT INTO positions (wallet, market_id, side, shares, cost_basis_usdc, realized_pnl, updated_at)
      VALUES (${wallet}, ${marketId}, ${side}, ${p.shares.toString()}, ${p.cost.toString()}, ${p.realized.toString()}, now())`;
  }
  await mirrorScored(t, wallet, marketId, pos);
}

/**
 * scored_positions (data_source 'onchain'): one row per open position at cost with the usdc-weighted ABOVE price of its
 * buys. The row disappears when the position is closed while the market is open and is frozen once the market resolved.
 */
async function mirrorScored(t: Sql, wallet: string, marketId: string, pos: ReturnType<typeof foldPositions>): Promise<void> {
  const m = await t<{ status: string }[]>`SELECT status FROM markets WHERE id = ${marketId}`;
  const status = m[0]?.status;
  if (!status) return;
  const buys = await t<{ side: Side; usdc: string; priceAfter: string; ts: Date }[]>`SELECT side, usdc, price_after, ts FROM trades
    WHERE wallet = ${wallet} AND market_id = ${marketId} AND direction = 'buy' ORDER BY ts`;
  for (const side of ['above', 'below'] as const) {
    const p = pos[side];
    const mine = buys.filter((b) => b.side === side);
    if (p.shares > 0n && p.cost > 0n && mine.length > 0) {
      const entry = weightedEntryPrice(mine.map((b) => ({ usdc: numericToBigInt(b.usdc), priceAfter: Number(b.priceAfter) })))!;
      await t`INSERT INTO scored_positions (market_id, wallet, side, usdc, entry_price, ts, data_source)
        VALUES (${marketId}, ${wallet}, ${side}, ${p.cost.toString()}, ${entry}, ${mine[0]!.ts}, 'onchain')
        ON CONFLICT (market_id, wallet, side) DO UPDATE SET usdc = EXCLUDED.usdc, entry_price = EXCLUDED.entry_price, ts = EXCLUDED.ts
        WHERE scored_positions.data_source = 'onchain'`;
    } else if (status === 'open' && p.shares === 0n) {
      await t`DELETE FROM scored_positions WHERE market_id = ${marketId} AND wallet = ${wallet} AND side = ${side} AND data_source = 'onchain'`;
    }
  }
}

export async function rebuildLp(t: Sql, wallet: string, marketId: string): Promise<void> {
  const rows = await t<{ lp: string | null }[]>`SELECT SUM(CASE WHEN kind = 'remove' THEN -lp_amount ELSE lp_amount END) AS lp
    FROM liquidity_events WHERE wallet = ${wallet} AND market_id = ${marketId}`;
  const lp = rows[0]?.lp;
  if (lp === null || lp === undefined) {
    await t`DELETE FROM lp_positions WHERE wallet = ${wallet} AND market_id = ${marketId}`;
    return;
  }
  await t`INSERT INTO lp_positions (wallet, market_id, lp_tokens) VALUES (${wallet}, ${marketId}, ${lp})
    ON CONFLICT (wallet, market_id) DO UPDATE SET lp_tokens = EXCLUDED.lp_tokens`;
}

/* ------------------------------ account mirror ------------------------------ */

export interface MarketSync {
  id: string;
  changedStatus: boolean;
}

/**
 * Copy the authoritative on-chain account state into the market row. `slot` is the RPC context slot of the read: the
 * reserve and fee state is only written when no newer event has been applied (last_slot).
 */
export async function applyMarketAccount(sql: Sql, m: ChainMarket, slot: number): Promise<MarketSync> {
  const settled = m.status === 'settled';
  const prev = await sql<{ status: string; direction: string | null; kind: string; question: string }[]>`SELECT status, direction, kind, question FROM markets WHERE id = ${m.id}`;
  const rows = await sql<{ id: string }[]>`UPDATE markets SET
      reserve_above = ${m.reserveAbove.toString()}, reserve_below = ${m.reserveBelow.toString()}, complete_sets = ${m.completeSets.toString()},
      fee_pool = ${m.feePool.toString()}, ema_impact_bps = ${m.emaImpactBps}, ema_ts = ${m.emaTs},
      status = ${m.status}, outcome = ${settled ? m.outcome : null},
      settle_price = ${settled ? rawToDecimalString(m.settlePrice, m.settleExpo) : null},
      settle_expo = ${settled ? m.settleExpo : null},
      settle_publish_ts = ${settled ? sec(m.settlePublishTs) : null},
      lp_claim_remaining = ${m.lpClaimRemaining.toString()}, lp_supply_remaining = ${m.lpSupplyRemaining.toString()},
      direction = COALESCE(direction, ${m.direction}),
      last_slot = GREATEST(last_slot, ${slot}), reconciled_at = now(), updated_at = now()
    WHERE id = ${m.id} AND last_slot <= ${slot} RETURNING id`;
  if (rows.length === 0) {
    await sql`UPDATE markets SET reconciled_at = now() WHERE id = ${m.id}`;
  }
  const before = prev[0];
  if (before && m.kind === 'touch' && before.direction === null && m.direction) {
    const asset = assetByFeedId(m.feedIdHex);
    if (asset) {
      const q = buildQuestion({ assetSymbol: asset.symbol, kind: 'touch', direction: m.direction, targetPrice: Number(rawToDecimalString(m.targetPrice, m.targetExpo)), settleTs: m.settleTs });
      await sql`UPDATE markets SET question = ${q} WHERE id = ${m.id} AND question = ${before.question}`;
    }
  }
  return { id: m.id, changedStatus: before !== undefined && before.status !== m.status };
}

/* ------------------------------ finalization ------------------------------ */

export interface PendingSig {
  signature: string;
  slot: number;
}

/** Transactions with unfinalized rows whose slot is at or below the finalized slot (oldest first). */
export async function listUnfinalized(sql: Sql, maxSlot: number, limit: number): Promise<PendingSig[]> {
  const rows = await sql<{ txSig: string; slot: number }[]>`
    SELECT tx_sig, MIN(slot) AS slot FROM (
      SELECT tx_sig, slot FROM trades WHERE NOT finalized AND slot <= ${maxSlot}
      UNION ALL SELECT tx_sig, slot FROM redemptions WHERE NOT finalized AND slot <= ${maxSlot}
      UNION ALL SELECT tx_sig, slot FROM merges WHERE NOT finalized AND slot <= ${maxSlot}
      UNION ALL SELECT tx_sig, slot FROM liquidity_events WHERE NOT finalized AND slot <= ${maxSlot}
      UNION ALL SELECT created_tx, created_slot FROM markets WHERE NOT created_finalized AND created_tx IS NOT NULL AND created_slot <= ${maxSlot}
    ) u GROUP BY tx_sig ORDER BY MIN(slot) LIMIT ${limit}`;
  return rows.map((r) => ({ signature: r.txSig, slot: r.slot }));
}

export async function countUnfinalized(sql: Sql): Promise<number> {
  const rows = await sql<{ n: number }[]>`SELECT (
      (SELECT count(*) FROM trades WHERE NOT finalized) + (SELECT count(*) FROM redemptions WHERE NOT finalized) +
      (SELECT count(*) FROM merges WHERE NOT finalized) + (SELECT count(*) FROM liquidity_events WHERE NOT finalized) +
      (SELECT count(*) FROM markets WHERE NOT created_finalized AND created_tx IS NOT NULL))::bigint AS n`;
  return rows[0]?.n ?? 0;
}

export async function markFinalized(sql: Sql, sigs: string[]): Promise<void> {
  if (sigs.length === 0) return;
  await sql.begin(async (t0) => {
    const t = t0 as unknown as Sql;
    await t`UPDATE trades SET finalized = true WHERE tx_sig IN ${t(sigs)} AND NOT finalized`;
    await t`UPDATE redemptions SET finalized = true WHERE tx_sig IN ${t(sigs)} AND NOT finalized`;
    await t`UPDATE merges SET finalized = true WHERE tx_sig IN ${t(sigs)} AND NOT finalized`;
    await t`UPDATE liquidity_events SET finalized = true WHERE tx_sig IN ${t(sigs)} AND NOT finalized`;
    await t`UPDATE markets SET created_finalized = true WHERE created_tx IN ${t(sigs)} AND NOT created_finalized`;
  });
}

export interface DropResult {
  rows: number;
  marketsDeleted: number;
  positionsRebuilt: number;
}

/** Remove everything written for transactions that never reached finalized (dropped fork) and rebuild what depended on it. */
export async function dropTransactions(sql: Sql, sigs: string[]): Promise<DropResult> {
  const out: DropResult = { rows: 0, marketsDeleted: 0, positionsRebuilt: 0 };
  if (sigs.length === 0) return out;
  await sql.begin(async (t0) => {
    const t = t0 as unknown as Sql;
    const keys = await t<{ wallet: string; marketId: string }[]>`
      SELECT wallet, market_id FROM trades WHERE tx_sig IN ${t(sigs)}
      UNION SELECT wallet, market_id FROM redemptions WHERE tx_sig IN ${t(sigs)}
      UNION SELECT wallet, market_id FROM merges WHERE tx_sig IN ${t(sigs)}
      UNION SELECT wallet, market_id FROM liquidity_events WHERE tx_sig IN ${t(sigs)}`;
    const lpKeys = await t<{ wallet: string; marketId: string }[]>`SELECT wallet, market_id FROM liquidity_events WHERE tx_sig IN ${t(sigs)}`;
    for (const tbl of ['trades', 'redemptions', 'merges', 'liquidity_events'] as const) {
      const r = await t`DELETE FROM ${t(tbl)} WHERE tx_sig IN ${t(sigs)}`;
      out.rows += r.count;
    }
    const del = await t`DELETE FROM markets WHERE created_tx IN ${t(sigs)}`;
    out.marketsDeleted = del.count;
    for (const k of keys) {
      const exists = await t`SELECT 1 FROM markets WHERE id = ${k.marketId}`;
      if (exists.length === 0) continue;
      await rebuildPosition(t, k.wallet, k.marketId);
      out.positionsRebuilt++;
    }
    for (const k of lpKeys) {
      const exists = await t`SELECT 1 FROM markets WHERE id = ${k.marketId}`;
      if (exists.length > 0) await rebuildLp(t, k.wallet, k.marketId);
    }
  });
  return out;
}

/* ------------------------------ read helpers ------------------------------ */

export async function knownMarkets(sql: Sql, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await sql<{ id: string }[]>`SELECT id FROM markets WHERE id IN ${sql(ids)}`;
  return new Set(rows.map((r) => r.id));
}

/** Markets whose on-chain state should be re-read: open ones and recently resolved ones. */
export async function listReconcileTargets(sql: Sql, now: Date, resolvedWithinSecs = 86_400): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`SELECT id FROM markets
    WHERE status = 'open' OR updated_at > ${new Date(now.getTime() - resolvedWithinSecs * 1000)} OR reconciled_at IS NULL
    ORDER BY reconciled_at NULLS FIRST LIMIT 2000`;
  return rows.map((r) => r.id);
}

/** Wallets that still hold shares in a market (to notify on settlement or voiding). */
export async function holders(sql: Sql, marketId: string, limit = 5000): Promise<string[]> {
  const rows = await sql<{ wallet: string }[]>`SELECT DISTINCT wallet FROM positions WHERE market_id = ${marketId} AND shares > 0 LIMIT ${limit}`;
  return rows.map((r) => r.wallet);
}

/** wallets flagged as smart money by the scorer (real data only), for TradeRow.flagged in live deltas */
export async function flaggedWallets(sql: Sql, wallets: string[]): Promise<Set<string>> {
  if (wallets.length === 0) return new Set();
  const rows = await sql<{ address: string }[]>`SELECT DISTINCT s.address FROM wallet_scores s
    WHERE s.address IN ${sql(wallets)} AND s.data_source <> 'demo-synthetic' AND s.smart
      AND s.as_of = (SELECT max(x.as_of) FROM wallet_scores x WHERE x.address = s.address AND x.data_source <> 'demo-synthetic')
      AND NOT COALESCE((SELECT w.label_hidden FROM wallets w WHERE w.address = s.address), false)`;
  return new Set(rows.map((r) => r.address));
}

/** One tick per open market (1-minute snapshots, price from the mirrored reserves). Returns how many rows were written. */
export async function snapshotTicks(sql: Sql, now: Date): Promise<number> {
  const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const nowSec = Math.floor(now.getTime() / 1000);
  const rows = await sql<
    { id: string; reserveAbove: string; reserveBelow: string; baseFeeBps: number; dynamicFee: boolean; emaImpactBps: number; emaTs: number; settleTs: Date }[]
  >`SELECT id, reserve_above, reserve_below, base_fee_bps, dynamic_fee, ema_impact_bps, ema_ts, settle_ts FROM markets WHERE status = 'open'`;
  if (rows.length === 0) return 0;
  const values = rows.map((r) => {
    const ra = numericToBigInt(r.reserveAbove);
    const rb = numericToBigInt(r.reserveBelow);
    const total = ra + rb;
    const price = total === 0n ? 0.5 : Number((rb * 1_000_000n) / total) / 1_000_000;
    const fee = feeBpsNow(
      {
        baseFeeBps: r.baseFeeBps,
        dynamicFee: r.dynamicFee,
        emaImpactBps: r.emaImpactBps,
        emaTs: r.emaTs,
        settleTs: Math.floor(r.settleTs.getTime() / 1000),
        maxFeeBps: MAX_FEE_BPS_DISPLAY,
      },
      nowSec,
    ).totalBps;
    return { market_id: r.id, ts: minute, price_above: price.toFixed(6), reserve_above: r.reserveAbove, reserve_below: r.reserveBelow, fee_bps: fee };
  });
  const res = await sql`INSERT INTO market_ticks ${sql(values)} ON CONFLICT (market_id, ts) DO NOTHING`;
  return res.count;
}
