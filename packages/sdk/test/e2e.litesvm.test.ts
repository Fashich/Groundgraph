/**
 * End to end: the SDK builders and decoders against the compiled program running in LiteSVM.
 * Skipped when target/deploy/groundgraph.so has not been built (cargo build-sbf --manifest-path programs/groundgraph/Cargo.toml).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Keypair, PublicKey, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  PROGRAM_ID,
  PYTH_FEEDS,
  PYTH_RECEIVER_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_DECIMALS,
  ata,
  buildAllowFeedIx,
  buildBuyIx,
  buildCreateMarketIx,
  buildInitializeConfigIx,
  buildMergeIx,
  buildRedeemIx,
  buildRemoveLiquidityIx,
  buildSellIx,
  buildSettleCloseIx,
  buildUpdateConfigIx,
  buildVoidMarketIx,
  decodeConfig,
  decodeFeed,
  decodeMarket,
  effectiveStatus,
  encodePriceUpdateV2,
  feedIdFromHex,
  marketPool,
  parseEventsFromLogs,
  pda,
  programErrorName,
  seedReserves,
  simulateBuy,
  simulateSell,
  toUnsignedV0Tx,
  type MarketAccount,
} from '../src/index';

const SO = resolve(__dirname, '../../../target/deploy/groundgraph.so');
const T0 = 1_800_000_000n;
const USDC = 1_000_000n;

type Lite = typeof import('litesvm');
let lite: Lite | null = null;
try {
  lite = await import('litesvm');
} catch {
  lite = null;
}
const enabled = existsSync(SO) && lite !== null;

function mintData(authority: PublicKey | null, supply: bigint, decimals: number): Uint8Array {
  const d = new Uint8Array(82);
  const v = new DataView(d.buffer);
  if (authority) {
    v.setUint32(0, 1, true);
    d.set(authority.toBytes(), 4);
  }
  v.setBigUint64(36, supply, true);
  d[44] = decimals;
  d[45] = 1;
  return d;
}
function tokenData(mint: PublicKey, owner: PublicKey, amount: bigint): Uint8Array {
  const d = new Uint8Array(165);
  d.set(mint.toBytes(), 0);
  d.set(owner.toBytes(), 32);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  d[108] = 1;
  return d;
}

describe.skipIf(!enabled)('SDK against the compiled program (LiteSVM)', () => {
  const { LiteSVM, Clock, FailedTransactionMetadata } = lite!;
  const svm = new LiteSVM();
  svm.addProgram(PROGRAM_ID.toBase58() as never, readFileSync(SO));

  const [deployer, admin, maker, alice, bob, keeper] = Array.from({ length: 6 }, () => Keypair.generate());
  const usdcMint = Keypair.generate().publicKey;
  const mintAuthority = Keypair.generate().publicKey;
  const solFeed = feedIdFromHex(PYTH_FEEDS.SOL!.feedIdHex);
  const logsOf = new Map<string, string[]>();

  const setAccount = (address: PublicKey, data: Uint8Array, owner: PublicKey, lamports = 10_000_000n) =>
    svm.setAccount({ address: address.toBase58(), data, executable: false, lamports, programAddress: owner.toBase58(), space: BigInt(data.length) } as never);
  const read = (address: PublicKey): Uint8Array | null => {
    const a = svm.getAccount(address.toBase58() as never) as { exists: boolean; data: Uint8Array };
    return a.exists ? a.data : null;
  };
  const tokenBalance = (address: PublicKey): bigint => {
    const d = read(address);
    return d ? new DataView(d.buffer, d.byteOffset).getBigUint64(64, true) : 0n;
  };
  const usdcOf = (owner: PublicKey) => tokenBalance(ata(usdcMint, owner));
  const setClock = (ts: bigint) => {
    const c = svm.getClock();
    svm.setClock(new Clock(c.slot + 1n, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, ts));
  };
  const now = () => Number(svm.getClock().unixTimestamp);
  const fund = (owner: PublicKey, amount: bigint) => setAccount(ata(usdcMint, owner), tokenData(usdcMint, owner, tokenBalance(ata(usdcMint, owner)) + amount), TOKEN_PROGRAM_ID);

  /** Sign with web3.js, convert to the kit transaction shape litesvm expects, send. */
  function send(ixs: TransactionInstruction[], signers: Keypair[], units = 400_000) {
    svm.expireBlockhash();
    const tx = toUnsignedV0Tx({ payer: signers[0]!.publicKey, instructions: ixs, blockhash: svm.latestBlockhash(), computeUnitLimit: units });
    tx.sign(signers);
    return svm.sendTransaction(toKit(tx) as never);
  }
  function toKit(tx: VersionedTransaction) {
    const keys = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
    const signatures: Record<string, Uint8Array> = {};
    keys.forEach((k, i) => (signatures[k.toBase58()] = tx.signatures[i]!));
    return { messageBytes: tx.message.serialize(), signatures };
  }
  function ok(res: ReturnType<typeof send>) {
    if (res instanceof FailedTransactionMetadata) throw new Error(`transaction failed: ${res.toString()}\n${res.meta().logs().join('\n')}`);
    return { logs: res.logs(), cu: Number(res.computeUnitsConsumed()) };
  }
  function failName(res: ReturnType<typeof send>): string | undefined {
    if (!(res instanceof FailedTransactionMetadata)) throw new Error('expected the transaction to fail');
    const line = res.meta().logs().find((l) => l.includes('custom program error: 0x'));
    if (!line) return undefined;
    return programErrorName(parseInt(/0x([0-9a-f]+)/.exec(line)![1]!, 16));
  }
  const market = (pk: PublicKey): MarketAccount => decodeMarket(read(pk)!);

  it('sets up the environment and initializes config and the feed allowlist', () => {
    for (const k of [deployer, admin, maker, alice, bob, keeper]) svm.airdrop(k!.publicKey.toBase58() as never, (100_000_000_000n as never));
    setClock(T0);
    setAccount(usdcMint, mintData(mintAuthority, 0n, USDC_DECIMALS), TOKEN_PROGRAM_ID, 1_461_600n);
    // Make the deployer the upgrade authority of the program.
    const pd = pda.programData();
    const data = Uint8Array.from(read(pd)!);
    new DataView(data.buffer).setUint32(0, 3, true);
    data[12] = 1;
    data.set(deployer!.publicKey.toBytes(), 13);
    setAccount(pd, data, BPF_LOADER_UPGRADEABLE_PROGRAM_ID, 100_000_000n);

    const init = buildInitializeConfigIx({
      authority: deployer!.publicKey,
      usdcMint,
      admin: admin!.publicKey,
      treasury: admin!.publicKey,
      minLiquidity: 100n * USDC,
      minDurationSecs: 1800n,
      tradingCloseSecs: 300,
    });
    ok(send([init], [deployer!]));
    const cfg = decodeConfig(read(pda.config())!);
    expect(cfg.admin.equals(admin!.publicKey)).toBe(true);
    expect(cfg.usdcMint.equals(usdcMint)).toBe(true);
    expect([cfg.maxFeeBps, cfg.maxStalenessSecs, cfg.maxConfBps, cfg.tradingCloseSecs, cfg.paused]).toEqual([300, 60, 50, 300, false]);
    expect(cfg.minDurationSecs).toBe(1800n);

    ok(send([buildAllowFeedIx({ admin: admin!.publicKey, feedId: solFeed, symbol: 'SOL/USD', expo: -8 })], [admin!]));
    const feed = decodeFeed(read(pda.feed(solFeed))!);
    expect(feed.symbol).toBe('SOL/USD');
    expect(feed.enabled).toBe(true);
    expect(feed.expo).toBe(-8);

    fund(maker!.publicKey, 100_000n * USDC);
    fund(alice!.publicKey, 10_000n * USDC);
    fund(bob!.publicKey, 10_000n * USDC);
  });

  let m1: PublicKey;
  let m2: PublicKey; // dynamic fee market

  it('creates markets with the builder and decodes them', () => {
    for (const [nonce, dynamic, settleIn, p0] of [[1n, false, 86_400, 4000], [2n, true, 48 * 3600, 7000]] as const) {
      const b = buildCreateMarketIx({
        creator: maker!.publicKey,
        nonce,
        feedId: solFeed,
        kind: 'close',
        targetPrice: 25_000_000_000n,
        targetExpo: -8,
        settleTs: now() + settleIn,
        baseFeeBps: 100,
        dynamicFee: dynamic,
        liquidity: 500n * USDC,
        p0Bps: p0,
        usdcMint,
      });
      const r = ok(send(b.instructions, [maker!]));
      expect(r.cu).toBeLessThan(400_000);
      const m = market(b.market);
      const seed = seedReserves(500n * USDC, p0);
      expect([m.reserveAbove, m.reserveBelow]).toEqual([seed.reserveAbove, seed.reserveBelow]);
      expect(m.completeSets).toBe(500n * USDC);
      expect(m.creator.equals(maker!.publicKey)).toBe(true);
      expect(m.vault.equals(b.accounts.vault)).toBe(true);
      expect(m.lpMint.equals(b.accounts.lpMint)).toBe(true);
      expect(m.dynamicFee).toBe(dynamic);
      expect(m.status).toBe('open');
      expect(effectiveStatus(m, now())).toBe('open');
      expect(tokenBalance(b.accounts.vault)).toBe(500n * USDC);
      expect(tokenBalance(ata(m.lpMint, maker!.publicKey))).toBe(500n * USDC);
      const evs = parseEventsFromLogs(r.logs);
      expect(evs.map((e) => e.name)).toEqual(['MarketCreated']);
      const ev = evs[0]!.data as { market: PublicKey; liquidity: bigint; p0Bps: number; settleTs: bigint };
      expect(ev.market.equals(b.market)).toBe(true);
      expect(ev.liquidity).toBe(500n * USDC);
      expect(ev.settleTs).toBe(m.settleTs);
      if (nonce === 1n) m1 = b.market;
      else m2 = b.market;
    }
  });

  it('SDK quotes equal the on-chain fills (buy, sell, merge) for static and dynamic fee markets', () => {
    const maxFee = decodeConfig(read(pda.config())!).maxFeeBps;
    for (const pk of [m1, m2]) {
      setClock(BigInt(now() + 1_800));
      for (const [who, side, amount] of [[alice!, 'above', 100n * USDC], [bob!, 'below', 80n * USDC], [alice!, 'below', 40n * USDC], [bob!, 'above', 2_500n * USDC]] as const) {
        const before = market(pk);
        const sim = simulateBuy(before, maxFee, side, amount, now());
        const r = ok(send(buildBuyIx({ market: before, marketPk: pk, user: who.publicKey, side, usdcIn: amount, minSharesOut: sim.quote.sharesOut }), [who]));
        const after = market(pk);
        expect(after.reserveAbove).toBe(sim.marketAfter.reserveAbove);
        expect(after.reserveBelow).toBe(sim.marketAfter.reserveBelow);
        expect(after.completeSets).toBe(sim.marketAfter.completeSets);
        expect(after.feePool).toBe(sim.marketAfter.feePool);
        expect(after.emaImpactBps).toBe(sim.marketAfter.emaImpactBps);
        expect(after.emaTs).toBe(sim.marketAfter.emaTs);
        const t = parseEventsFromLogs(r.logs).find((e) => e.name === 'Trade')!.data as { shares: bigint; usdc: bigint; feeUsdc: bigint; feeBps: number; priceAfterBps: number; isBuy: boolean };
        expect(t.isBuy).toBe(true);
        expect(t.shares).toBe(sim.quote.sharesOut);
        expect(t.usdc).toBe(amount);
        expect(t.feeUsdc).toBe(sim.quote.feeUsdc);
        expect(t.feeBps).toBe(sim.fee.totalBps);
        expect(t.priceAfterBps).toBe(Math.round(sim.quote.priceAfter * 10_000));
        expect(tokenBalance(ata(side === 'above' ? after.aboveMint : after.belowMint, who.publicKey))).toBeGreaterThanOrEqual(sim.quote.sharesOut);
        expect(tokenBalance(after.vault)).toBe(after.completeSets + after.feePool);
        setClock(BigInt(now() + 90));
      }
      // sell part of alice's ABOVE shares
      const before = market(pk);
      const held = tokenBalance(ata(before.aboveMint, alice!.publicKey));
      const sim = simulateSell(before, maxFee, 'above', held / 3n, now());
      const usdcBefore = usdcOf(alice!.publicKey);
      const r = ok(send(buildSellIx({ market: before, marketPk: pk, user: alice!.publicKey, side: 'above', sharesIn: held / 3n, minUsdcOut: sim.quote.usdcOut }), [alice!]));
      const after = market(pk);
      expect(usdcOf(alice!.publicKey) - usdcBefore).toBe(sim.quote.usdcOut);
      expect([after.reserveAbove, after.reserveBelow, after.completeSets, after.feePool]).toEqual([sim.marketAfter.reserveAbove, sim.marketAfter.reserveBelow, sim.marketAfter.completeSets, sim.marketAfter.feePool]);
      expect(after.emaImpactBps).toBe(sim.marketAfter.emaImpactBps);
      expect((parseEventsFromLogs(r.logs)[0]!.data as { usdc: bigint }).usdc).toBe(sim.quote.usdcOut);
      expect(tokenBalance(after.vault)).toBe(after.completeSets + after.feePool);

      // merge complete sets
      const sets = [tokenBalance(ata(after.aboveMint, alice!.publicKey)), tokenBalance(ata(after.belowMint, alice!.publicKey))].reduce((a, b) => (a < b ? a : b));
      expect(sets).toBeGreaterThan(0n);
      const u0 = usdcOf(alice!.publicKey);
      ok(send(buildMergeIx({ market: after, marketPk: pk, user: alice!.publicKey, amount: sets }), [alice!]));
      expect(usdcOf(alice!.publicKey) - u0).toBe(sets);
      expect(market(pk).completeSets).toBe(after.completeSets - sets);
    }
  });

  it('maps program errors to their names', () => {
    const m = market(m1);
    // slippage
    let res = send(buildBuyIx({ market: m, marketPk: m1, user: alice!.publicKey, side: 'above', usdcIn: 10n * USDC, minSharesOut: 1n << 60n }), [alice!]);
    expect(failName(res)).toBe('SlippageExceeded');
    res = send(buildBuyIx({ market: m, marketPk: m1, user: alice!.publicKey, side: 'above', usdcIn: 10n, minSharesOut: 0n }), [alice!]);
    expect(failName(res)).toBe('BelowMinTrade');
    // too early to settle
    const pu = Keypair.generate().publicKey;
    setAccount(pu, encodePriceUpdateV2({ writeAuthority: keeper!.publicKey, verification: { level: 'full' }, feedId: solFeed, price: 26_000_000_000n, conf: 1n, exponent: -8, publishTime: m.settleTs, prevPublishTime: m.settleTs - 1n, emaPrice: 1n, emaConf: 1n, postedSlot: 1n }), PYTH_RECEIVER_PROGRAM_ID);
    res = send([buildSettleCloseIx({ marketPk: m1, market: m, priceUpdate: pu, payer: keeper!.publicKey })], [keeper!]);
    expect(failName(res)).toBe('TooEarlyToSettle');
    // non-admin config change
    res = send([buildUpdateConfigIx({ admin: alice!.publicKey, params: { paused: true } })], [alice!]);
    expect(failName(res)).toBe('NotAdmin');
  });

  it('settles with a Pyth price update, pays winners and drains the vault', () => {
    const m = market(m1);
    setClock(m.tradingEndTs);
    const rej = send(buildBuyIx({ market: m, marketPk: m1, user: alice!.publicKey, side: 'above', usdcIn: 10n * USDC, minSharesOut: 0n }), [alice!]);
    expect(failName(rej)).toBe('TradingEnded');
    expect(effectiveStatus(m, now())).toBe('trading_closed');

    setClock(m.settleTs + 3n);
    const pu = Keypair.generate().publicKey;
    setAccount(pu, encodePriceUpdateV2({ writeAuthority: keeper!.publicKey, verification: { level: 'full' }, feedId: solFeed, price: 24_999_000_000n, conf: 2_000_000n, exponent: -8, publishTime: m.settleTs + 3n, prevPublishTime: m.settleTs + 2n, emaPrice: 1n, emaConf: 1n, postedSlot: 1n }), PYTH_RECEIVER_PROGRAM_ID);
    const r = ok(send([buildSettleCloseIx({ marketPk: m1, market: m, priceUpdate: pu, payer: keeper!.publicKey })], [keeper!]));
    const settled = market(m1);
    expect(settled.status).toBe('settled');
    expect(settled.outcome).toBe('below'); // 249.99 <= 250
    expect(settled.settlePrice).toBe(24_999_000_000n);
    expect(settled.settlePublishTs).toBe(m.settleTs + 3n);
    const ev = parseEventsFromLogs(r.logs)[0]!;
    expect(ev.name).toBe('Settled');
    expect((ev.data as { lpClaim: bigint }).lpClaim).toBe(settled.lpClaimRemaining);
    expect(effectiveStatus(settled, now())).toBe('settled');

    // BELOW holders redeem 1:1, ABOVE holders cannot.
    for (const who of [alice!, bob!]) {
      const bal = tokenBalance(ata(settled.belowMint, who.publicKey));
      if (bal > 0n) {
        const before = usdcOf(who.publicKey);
        ok(send(buildRedeemIx({ market: settled, marketPk: m1, user: who.publicKey, side: 'below', amount: bal }), [who]));
        expect(usdcOf(who.publicKey) - before).toBe(bal);
      }
      const above = tokenBalance(ata(settled.aboveMint, who.publicKey));
      if (above > 0n) {
        const res = send(buildRedeemIx({ market: settled, marketPk: m1, user: who.publicKey, side: 'above', amount: above }), [who]);
        expect(failName(res)).toBe('NotWinningSide');
      }
    }
    // The creator redeems the seed BELOW shares and removes all liquidity.
    const mk = tokenBalance(ata(settled.belowMint, maker!.publicKey));
    if (mk > 0n) ok(send(buildRedeemIx({ market: settled, marketPk: m1, user: maker!.publicKey, side: 'below', amount: mk }), [maker!]));
    const claim = settled.lpClaimRemaining;
    const before = usdcOf(maker!.publicKey);
    ok(send(buildRemoveLiquidityIx({ market: settled, marketPk: m1, user: maker!.publicKey, lpAmount: 500n * USDC }), [maker!]));
    expect(usdcOf(maker!.publicKey) - before).toBe(claim);
    expect(tokenBalance(settled.vault)).toBe(0n);
  });

  it('voids an unsettled market and pays 0.5 USDC per share', () => {
    const m = market(m2);
    setClock(m.settleTs + 3_599n);
    expect(failName(send([buildVoidMarketIx({ marketPk: m2, market: m, payer: keeper!.publicKey })], [keeper!]))).toBe('TooEarlyToVoid');
    setClock(m.settleTs + 3_600n);
    const r = ok(send([buildVoidMarketIx({ marketPk: m2, market: m, payer: keeper!.publicKey })], [keeper!]));
    expect(parseEventsFromLogs(r.logs)[0]!.name).toBe('Voided');
    const v = market(m2);
    expect(v.status).toBe('voided');
    expect(v.outcome).toBe('none');
    let redeems = 0n;
    for (const who of [alice!, bob!, maker!]) {
      for (const side of ['above', 'below'] as const) {
        const bal = tokenBalance(ata(side === 'above' ? v.aboveMint : v.belowMint, who.publicKey));
        if (bal >= 2n) {
          const before = usdcOf(who.publicKey);
          ok(send(buildRedeemIx({ market: v, marketPk: m2, user: who.publicKey, side, amount: bal }), [who]));
          expect(usdcOf(who.publicKey) - before).toBe(bal / 2n);
          redeems++;
        }
      }
    }
    ok(send(buildRemoveLiquidityIx({ market: v, marketPk: m2, user: maker!.publicKey, lpAmount: 500n * USDC }), [maker!]));
    expect(tokenBalance(v.vault)).toBeLessThanOrEqual(redeems + 1n);
  });

  it('keeps the pool view consistent with the decoded market', () => {
    const m = market(m1);
    expect(marketPool(m)).toEqual({ reserveAbove: m.reserveAbove, reserveBelow: m.reserveBelow });
  });
});
