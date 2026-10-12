/**
 * Devnet smoke test: buy, sell and merge on a static-fee seeded market, asserting that the SDK quote equals the
 * on-chain fill (Trade/Merged events, token balance deltas and the Market account after each step). Also records the
 * compute units each transaction consumed.
 *
 *   pnpm --filter @groundgraph/scripts smoke:devnet
 *
 * Trades with the maker key (it holds the test USDC after the bootstrap). Needs scripts/.bootstrap-state.json.
 */
import { getAccount } from '@solana/spl-token';
import { PublicKey, type Connection, type Keypair, type TransactionInstruction } from '@solana/web3.js';
import {
  PROGRAM_ID,
  ata,
  buildBuyIx,
  buildMergeIx,
  buildSellIx,
  decodeConfig,
  decodeMarket,
  effectiveStatus,
  formatUsdc,
  parseEventsFromLogs,
  pda,
  simulateBuy,
  simulateSell,
  type GgEvent,
  type MarketAccount,
} from '@groundgraph/sdk';
import { RPC_URL, SMOKE_RECORD, USDC, connect, loadKey, loadState, log, send, writeJson } from './devnet-lib';

interface Step {
  name: string;
  signature: string;
  computeUnits: number | null;
  detail: string;
}

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failures++;
  log(`    ${ok ? 'ok  ' : 'FAIL'} ${label}: ${String(actual)}${ok ? '' : ` (expected ${String(expected)})`}`);
}

async function tokenBalance(conn: Connection, ata: PublicKey): Promise<bigint> {
  try {
    return (await getAccount(conn, ata, 'confirmed')).amount;
  } catch {
    return 0n;
  }
}

async function readMarket(conn: Connection, pk: PublicKey): Promise<MarketAccount> {
  const info = await conn.getAccountInfo(pk, 'confirmed');
  if (!info) throw new Error(`market ${pk.toBase58()} not found`);
  return decodeMarket(info.data);
}

async function fetchLogsAndCu(conn: Connection, signature: string): Promise<{ events: GgEvent[]; cu: number | null }> {
  for (let i = 0; i < 20; i++) {
    const tx = await conn.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (tx?.meta) return { events: parseEventsFromLogs(tx.meta.logMessages ?? []), cu: tx.meta.computeUnitsConsumed ?? null };
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`transaction ${signature} not available from the RPC`);
}

async function pickMarket(conn: Connection, now: number): Promise<{ pk: PublicKey; m: MarketAccount }> {
  const st = loadState();
  const candidates = Object.values(st.markets).map((x) => new PublicKey(x.pubkey));
  if (candidates.length === 0) throw new Error('no markets in scripts/.bootstrap-state.json; run the bootstrap first');
  for (const pk of candidates) {
    const m = await readMarket(conn, pk);
    if (!m.dynamicFee && effectiveStatus(m, now) === 'open' && Number(m.tradingEndTs) - now > 120) return { pk, m };
  }
  throw new Error('no open static-fee market with more than two minutes of trading left; run the bootstrap again or create one with create-market.ts');
}

async function main() {
  const conn = connect();
  const maker = loadKey('maker');
  const now = () => Math.floor(Date.now() / 1000);
  log(`RPC ${RPC_URL}`);
  const config = decodeConfig((await conn.getAccountInfo(pda.config(), 'confirmed'))!.data);
  const { pk: marketPk, m: m0 } = await pickMarket(conn, now());
  const user = maker.publicKey;
  log(`market ${marketPk.toBase58()} (static fee ${m0.baseFeeBps} bps, ${m0.status})`);
  const steps: Step[] = [];
  let boughtAbove = 0n;
  let boughtBelow = 0n;

  const ataOf = async (mint: PublicKey) => ata(mint, user);
  const usdcAta = await ataOf(m0.collateralMint);

  async function run(name: string, ixs: TransactionInstruction[], signer: Keypair): Promise<Step & { events: GgEvent[] }> {
    const signature = await send(conn, ixs, [signer], { label: name, units: 250_000 });
    const { events, cu } = await fetchLogsAndCu(conn, signature);
    return { name, signature, computeUnits: cu, detail: '', events };
  }

  /* ---- buy ABOVE ---- */
  log('\nbuy ABOVE 5 USDC');
  {
    const before = await readMarket(conn, marketPk);
    const sim = simulateBuy(before, config.maxFeeBps, 'above', 5n * USDC, now());
    const ownBefore = await tokenBalance(conn, await ataOf(before.aboveMint));
    const usdcBefore = await tokenBalance(conn, usdcAta);
    const minOut = sim.quote.sharesOut;
    const r = await run('buy', buildBuyIx({ market: before, marketPk, user, side: 'above', usdcIn: 5n * USDC, minSharesOut: minOut }), maker);
    const trade = r.events.find((e) => e.name === 'Trade');
    const after = await readMarket(conn, marketPk);
    const ownAfter = await tokenBalance(conn, await ataOf(before.aboveMint));
    const usdcAfter = await tokenBalance(conn, usdcAta);
    check('Trade event emitted', trade !== undefined, true);
    if (trade?.name === 'Trade') {
      check('event shares == quote', trade.data.shares, sim.quote.sharesOut);
      check('event fee == quote', trade.data.feeUsdc, sim.quote.feeUsdc);
      check('event fee bps == quote', trade.data.feeBps, sim.fee.totalBps);
    }
    check('share balance delta == quote', ownAfter - ownBefore, sim.quote.sharesOut);
    boughtAbove = ownAfter - ownBefore;
    check('USDC spent == 5', usdcBefore - usdcAfter, 5n * USDC);
    check('reserve above == simulated', after.reserveAbove, sim.marketAfter.reserveAbove);
    check('reserve below == simulated', after.reserveBelow, sim.marketAfter.reserveBelow);
    check('complete sets == simulated', after.completeSets, sim.marketAfter.completeSets);
    check('fee pool == simulated', after.feePool, sim.marketAfter.feePool);
    steps.push({ name: 'buy', signature: r.signature, computeUnits: r.computeUnits, detail: `${formatUsdc(5n * USDC)} USDC -> ${sim.quote.sharesOut} ABOVE shares` });
    log(`    compute units ${r.computeUnits}`);
  }

  /* ---- sell half of the ABOVE shares just bought ---- */
  log('\nsell half of the ABOVE shares just bought');
  {
    const before = await readMarket(conn, marketPk);
    const sellShares = boughtAbove / 2n;
    const sim = simulateSell(before, config.maxFeeBps, 'above', sellShares, now());
    const usdcBefore = await tokenBalance(conn, usdcAta);
    const r = await run('sell', buildSellIx({ market: before, marketPk, user, side: 'above', sharesIn: sellShares, minUsdcOut: sim.quote.usdcOut }), maker);
    const trade = r.events.find((e) => e.name === 'Trade');
    const after = await readMarket(conn, marketPk);
    const usdcAfter = await tokenBalance(conn, usdcAta);
    check('Trade event emitted', trade !== undefined, true);
    if (trade?.name === 'Trade') {
      check('event usdc out == quote', trade.data.usdc, sim.quote.usdcOut);
      check('event fee == quote', trade.data.feeUsdc, sim.quote.feeUsdc);
    }
    check('USDC received == quote', usdcAfter - usdcBefore, sim.quote.usdcOut);
    check('reserve above == simulated', after.reserveAbove, sim.marketAfter.reserveAbove);
    check('reserve below == simulated', after.reserveBelow, sim.marketAfter.reserveBelow);
    check('complete sets == simulated', after.completeSets, sim.marketAfter.completeSets);
    check('fee pool == simulated', after.feePool, sim.marketAfter.feePool);
    steps.push({ name: 'sell', signature: r.signature, computeUnits: r.computeUnits, detail: `${sellShares} ABOVE shares -> ${formatUsdc(sim.quote.usdcOut)} USDC` });
    log(`    compute units ${r.computeUnits}`);
  }

  /* ---- buy BELOW, then merge a complete set ---- */
  log('\nbuy BELOW 3 USDC');
  {
    const before = await readMarket(conn, marketPk);
    const sim = simulateBuy(before, config.maxFeeBps, 'below', 3n * USDC, now());
    const belowBefore = await tokenBalance(conn, await ataOf(before.belowMint));
    const r = await run('buy', buildBuyIx({ market: before, marketPk, user, side: 'below', usdcIn: 3n * USDC, minSharesOut: sim.quote.sharesOut }), maker);
    const after = await readMarket(conn, marketPk);
    boughtBelow = (await tokenBalance(conn, await ataOf(before.belowMint))) - belowBefore;
    check('BELOW share balance delta == quote', boughtBelow, sim.quote.sharesOut);
    check('reserve below == simulated', after.reserveBelow, sim.marketAfter.reserveBelow);
    check('fee pool == simulated', after.feePool, sim.marketAfter.feePool);
    steps.push({ name: 'buy', signature: r.signature, computeUnits: r.computeUnits, detail: `${formatUsdc(3n * USDC)} USDC -> ${sim.quote.sharesOut} BELOW shares` });
    log(`    compute units ${r.computeUnits}`);
  }
  log('\nmerge');
  {
    const before = await readMarket(conn, marketPk);
    const a = await tokenBalance(conn, await ataOf(before.aboveMint));
    const amount = a < boughtBelow ? a : boughtBelow;
    const usdcBefore = await tokenBalance(conn, usdcAta);
    const r = await run('merge', buildMergeIx({ market: before, marketPk, user, amount }), maker);
    const merged = r.events.find((e) => e.name === 'Merged');
    const after = await readMarket(conn, marketPk);
    const usdcAfter = await tokenBalance(conn, usdcAta);
    check('Merged event emitted', merged !== undefined, true);
    check('USDC received == merged amount', usdcAfter - usdcBefore, amount);
    check('complete sets reduced by amount', before.completeSets - after.completeSets, amount);
    check('reserves unchanged', `${after.reserveAbove}/${after.reserveBelow}`, `${before.reserveAbove}/${before.reserveBelow}`);
    steps.push({ name: 'merge', signature: r.signature, computeUnits: r.computeUnits, detail: `${amount} complete sets -> ${formatUsdc(amount)} USDC` });
    log(`    compute units ${r.computeUnits}`);
  }

  /* ---- vault solvency ---- */
  const fin = await readMarket(conn, marketPk);
  const vault = await tokenBalance(conn, fin.vault);
  log('\nsolvency');
  check('vault >= complete sets + fee pool', vault >= fin.completeSets + fin.feePool, true);

  writeJson(SMOKE_RECORD, {
    cluster: RPC_URL.includes('devnet') ? 'devnet' : RPC_URL,
    programId: PROGRAM_ID.toBase58(),
    market: marketPk.toBase58(),
    ok: failures === 0,
    steps,
    ranAt: new Date().toISOString(),
  });
  log(`\n${failures === 0 ? 'smoke test passed' : `smoke test FAILED (${failures} mismatches)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
