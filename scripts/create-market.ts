/**
 * Create one Close market on devnet.
 *
 *   pnpm --filter @groundgraph/scripts create-market -- --asset SOL --target 120 --settle +24h
 *       [--liquidity 500] [--fee 100] [--dynamic] [--p0 auto|4200] [--vol 0.8] [--nonce N] [--creator maker]
 *
 * --settle takes an ISO timestamp (2026-11-01T20:00:00Z) or a relative duration (+45m, +6h, +3d).
 * --p0 auto (default) opens at the fair price from the live Pyth push feed price and a default volatility.
 */
import { PublicKey } from '@solana/web3.js';
import {
  PYTH_FEEDS,
  buildCreateMarketIx,
  buildQuestion,
  decodeConfig,
  decodeMarket,
  fairValueClose,
  feedIdFromHex,
  formatUsdc,
  pda,
  toOpeningBps,
} from '@groundgraph/sdk';
import { USDC, connect, loadKey, log, readPushPrice, send, volFor } from './devnet-lib';

function args(): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  const argv = process.argv.slice(2).filter((a) => a !== '--');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
    else {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}

function parseSettle(s: string, now: number): number {
  const rel = /^\+(\d+)([mhd])$/.exec(s);
  if (rel) return now + Number(rel[1]) * { m: 60, h: 3600, d: 86400 }[rel[2] as 'm' | 'h' | 'd'];
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw new Error(`cannot parse --settle ${s}`);
  return Math.floor(t / 1000);
}

async function main() {
  const a = args();
  const asset = String(a.asset ?? '').toUpperCase().replace(/\/USD$/, '');
  const feed = PYTH_FEEDS[asset];
  if (!feed) throw new Error(`--asset must be one of ${Object.keys(PYTH_FEEDS).join(', ')}`);
  const target = Number(a.target);
  if (!(target > 0)) throw new Error('--target <price in USD> is required');
  if (typeof a.settle !== 'string') throw new Error('--settle <ISO time | +45m | +6h | +3d> is required');
  const conn = connect();
  const creator = loadKey(typeof a.creator === 'string' ? a.creator : 'maker');
  const cfgInfo = await conn.getAccountInfo(pda.config(), 'confirmed');
  if (!cfgInfo) throw new Error('config not initialized; run the bootstrap first');
  const cfg = decodeConfig(cfgInfo.data);

  const now = Math.floor(Date.now() / 1000);
  const settleTs = parseSettle(a.settle, now);
  const liquidity = BigInt(Math.round(Number(a.liquidity ?? '500') * 1_000_000));
  const fee = Number(a.fee ?? '100');
  if (fee !== 50 && fee !== 100 && fee !== 200) throw new Error('--fee must be 50, 100 or 200');
  let p0Bps: number;
  if (a.p0 === undefined || a.p0 === 'auto') {
    const push = await readPushPrice(conn, asset);
    if (!push) throw new Error(`no push feed price for ${asset} on this cluster; pass --p0 <bps>`);
    const vol = typeof a.vol === 'string' ? Number(a.vol) : volFor(asset).vol;
    const fair = fairValueClose(push.price, target, vol, Math.max(settleTs - now, 60) / (365 * 86400));
    p0Bps = toOpeningBps(fair);
    log(`spot ${push.price} (${push.ageSecs}s old), vol ${vol}, fair ABOVE ${(fair * 100).toFixed(1)}% -> p0 ${p0Bps} bps`);
  } else {
    p0Bps = Number(a.p0);
  }
  const nonce = typeof a.nonce === 'string' ? BigInt(a.nonce) : BigInt(now);
  const built = buildCreateMarketIx({
    creator: creator.publicKey,
    nonce,
    feedId: feedIdFromHex(feed.feedIdHex),
    kind: 'close',
    targetPrice: BigInt(Math.round(target * 10 ** -feed.expo)),
    targetExpo: feed.expo,
    settleTs,
    baseFeeBps: fee as 50 | 100 | 200,
    dynamicFee: a.dynamic === true,
    liquidity,
    p0Bps,
    usdcMint: cfg.usdcMint,
  });
  const sig = await send(conn, built.instructions, [creator], { label: 'create_market', units: 300_000 });
  const m = decodeMarket((await conn.getAccountInfo(built.market, 'confirmed'))!.data);
  log(buildQuestion({ assetSymbol: asset, kind: 'close', targetPrice: target, settleTs }));
  log(`market ${built.market.toBase58()}  liquidity ${formatUsdc(liquidity)} USDC  opens at ${p0Bps} bps  settles ${new Date(settleTs * 1000).toISOString()}  trading ends ${new Date(Number(m.tradingEndTs) * 1000).toISOString()}`);
  log(`tx ${sig}`);
  void PublicKey;
  void USDC;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
