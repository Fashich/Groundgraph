/**
 * Devnet bootstrap (idempotent): top up the service keys, create a 6-decimal test USDC mint (the faucet key is its mint
 * authority), initialize the program config, allowlist the Pyth feeds, fund the maker with test USDC and seed up to six
 * Close markets at a fair opening price.
 *
 *   pnpm --filter @groundgraph/scripts bootstrap:devnet           (RPC_URL defaults to https://api.devnet.solana.com)
 *
 * State: scripts/.bootstrap-state.json (git-ignored) remembers the mint; everything else is read back from the chain, so
 * a re-run only does what is still missing. A public record without secrets is written to
 * programs/groundgraph/deployments/devnet-bootstrap.json.
 *
 * Opening prices use the sponsored Pyth push feeds on the cluster for spot and documented default volatilities
 * (Pyth Benchmarks needs an API key; set VOL_<SYMBOL> to override). No Hermes dependency.
 */
import { createMint, getAccount, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  PROGRAM_ID,
  PYTH_FEEDS,
  buildAllowFeedIx,
  buildCreateMarketIx,
  buildInitializeConfigIx,
  buildQuestion,
  decodeConfig,
  decodeFeed,
  decodeMarket,
  feedIdFromHex,
  fairValueClose,
  formatUsdc,
  pda,
  toOpeningBps,
} from '@groundgraph/sdk';
import {
  PUBLIC_RECORD,
  RPC_URL,
  USDC,
  connect,
  loadKey,
  loadState,
  log,
  niceStrike,
  readPushPrice,
  requireProgram,
  saveState,
  send,
  sol,
  topUp,
  volFor,
  writeJson,
} from './devnet-lib';

const FEEDS = ['SOL', 'ETH', 'BTC', 'JUP', 'WIF', 'BONK'] as const;
/** Last-resort spot prices, used only when the cluster has no push feed account (e.g. a bare local validator). */
const FALLBACK_SPOT: Record<string, number> = { SOL: 150, BTC: 100_000, ETH: 3_500, JUP: 0.8, WIF: 1.5, BONK: 0.00002 };

interface PlanEntry {
  nonce: bigint;
  asset: (typeof FEEDS)[number];
  settleInSecs: number;
  /** Strike relative to spot in percent. */
  strikePct: number;
  dynamicFee: boolean;
}
const PLAN: PlanEntry[] = [
  { nonce: 1n, asset: 'SOL', settleInSecs: 45 * 60, strikePct: -1.5, dynamicFee: false },
  { nonce: 2n, asset: 'ETH', settleInSecs: 3 * 3600, strikePct: 1.0, dynamicFee: true },
  { nonce: 3n, asset: 'BTC', settleInSecs: 12 * 3600, strikePct: -2.0, dynamicFee: false },
  { nonce: 4n, asset: 'SOL', settleInSecs: 24 * 3600, strikePct: 3.0, dynamicFee: true },
  { nonce: 5n, asset: 'JUP', settleInSecs: 48 * 3600, strikePct: -4.0, dynamicFee: false },
  { nonce: 6n, asset: 'WIF', settleInSecs: 5 * 86400, strikePct: 8.0, dynamicFee: false },
];
const LIQUIDITY = 500n * USDC;
const BASE_FEE_BPS = 100 as const;
const MIN_DURATION = 1800n;
const TRADING_CLOSE = 300;
const MIN_LIQUIDITY = 100n * USDC;
/** The maker keeps this much test USDC for trading, plus a cushion whenever the bootstrap has to mint. */
const MAKER_USDC_RESERVE = 1_000n * USDC;
const MAKER_USDC_CUSHION = 6_000n * USDC;

/** Minimum SOL balances (lamports) the bootstrap keeps on each key. */
const MIN_SOL = { admin: 50_000_000, maker: 250_000_000, keeper: 100_000_000, faucet: 100_000_000 };
const DEPLOYER_RESERVE = 50_000_000;

const roundUp = (x: number, step: number) => Math.ceil(x / step) * step;

async function main() {
  const conn = connect();
  const deployer = loadKey('deployer');
  const admin = loadKey('admin');
  const maker = loadKey('maker');
  const faucet = loadKey('faucet');
  const keeper = loadKey('keeper');
  const notes: string[] = [];
  log(`RPC ${RPC_URL}\nprogram ${PROGRAM_ID.toBase58()}`);
  await requireProgram(conn);

  /* ---- 1. SOL for the service keys ---- */
  const targets: [string, Keypair, number][] = [
    ['admin', admin, MIN_SOL.admin],
    ['maker', maker, MIN_SOL.maker],
    ['keeper', keeper, MIN_SOL.keeper],
    ['faucet', faucet, MIN_SOL.faucet],
  ];
  let shortfall = 0;
  for (const [, kp, min] of targets) shortfall += Math.max(0, min - (await conn.getBalance(kp.publicKey)));
  const depBal = await conn.getBalance(deployer.publicKey);
  if (depBal < shortfall + DEPLOYER_RESERVE) {
    const need = shortfall + DEPLOYER_RESERVE - depBal;
    log(`\nBLOCKED: the deployer ${deployer.publicKey.toBase58()} holds ${sol(depBal)} SOL but the bootstrap needs ${sol(shortfall + DEPLOYER_RESERVE)} SOL.`);
    log(`Fund it with at least ${sol(need)} SOL more (https://faucet.solana.com, network: devnet) and re-run.`);
    process.exit(2);
  }
  log('\n1. SOL for service keys');
  for (const [name, kp, min] of targets) {
    log(`  ${name} ${kp.publicKey.toBase58()}`);
    await topUp(conn, deployer, kp.publicKey, min);
  }

  /* ---- 2. test USDC mint ---- */
  log('\n2. test USDC mint');
  const state = loadState();
  const configPk = pda.config();
  const configInfo = await conn.getAccountInfo(configPk, 'confirmed');
  let usdcMint: PublicKey;
  if (configInfo) {
    usdcMint = decodeConfig(configInfo.data).usdcMint;
    if (state.usdcMint && state.usdcMint !== usdcMint.toBase58()) notes.push(`state file mint ${state.usdcMint} differs from the config mint; using the config mint`);
  } else if (state.usdcMint) {
    usdcMint = new PublicKey(state.usdcMint);
  } else {
    usdcMint = await createMint(conn, deployer, faucet.publicKey, null, 6);
    log(`  created ${usdcMint.toBase58()} (mint authority: faucet key)`);
  }
  state.usdcMint = usdcMint.toBase58();
  saveState(state);
  log(`  ${usdcMint.toBase58()}`);

  /* ---- 3. config ---- */
  log('\n3. initialize_config');
  if (!configInfo) {
    const ix = buildInitializeConfigIx({
      authority: deployer.publicKey,
      usdcMint,
      admin: admin.publicKey,
      treasury: admin.publicKey,
      minLiquidity: MIN_LIQUIDITY,
      minDurationSecs: MIN_DURATION,
      tradingCloseSecs: TRADING_CLOSE,
    });
    const sig = await send(conn, [ix], [deployer], { label: 'initialize_config' });
    log(`  initialized (${sig.slice(0, 12)}...)`);
  } else {
    log('  already initialized');
  }
  const cfg = decodeConfig((await conn.getAccountInfo(configPk, 'confirmed'))!.data);
  log(`  admin ${cfg.admin.toBase58()}  min_duration ${cfg.minDurationSecs}s  min_liquidity ${formatUsdc(cfg.minLiquidity)} USDC  trading_close ${cfg.tradingCloseSecs}s  max_fee ${cfg.maxFeeBps} bps`);
  if (!cfg.admin.equals(admin.publicKey)) throw new Error(`config admin is ${cfg.admin.toBase58()}, not the admin key; cannot allowlist feeds`);

  /* ---- 4. feed allowlist ---- */
  log('\n4. feed allowlist');
  const missing: (typeof FEEDS)[number][] = [];
  for (const sym of FEEDS) {
    const id = feedIdFromHex(PYTH_FEEDS[sym]!.feedIdHex);
    const info = await conn.getAccountInfo(pda.feed(id), 'confirmed');
    if (info && decodeFeed(info.data).enabled) continue;
    missing.push(sym);
  }
  for (let i = 0; i < missing.length; i += 3) {
    const batch = missing.slice(i, i + 3);
    const ixs = batch.map((sym) => buildAllowFeedIx({ admin: admin.publicKey, feedId: feedIdFromHex(PYTH_FEEDS[sym]!.feedIdHex), symbol: PYTH_FEEDS[sym]!.symbol, expo: PYTH_FEEDS[sym]!.expo }));
    await send(conn, ixs, [admin], { label: 'allow_feed' });
    log(`  allowed ${batch.join(', ')}`);
  }
  if (missing.length === 0) log('  all six feeds already allowed');

  /* ---- 5. test USDC for the maker ---- */
  log('\n5. maker test USDC');
  const makerAta = await getOrCreateAssociatedTokenAccount(conn, deployer, usdcMint, maker.publicKey);
  const have = (await getAccount(conn, makerAta.address)).amount;
  let toCreate = 0n;
  for (const p of PLAN) if (!(await conn.getAccountInfo(pda.market(maker.publicKey, p.nonce), 'confirmed'))) toCreate++;
  const required = toCreate * LIQUIDITY + MAKER_USDC_RESERVE;
  if (have < required) {
    const amount = required + MAKER_USDC_CUSHION - have;
    await mintTo(conn, deployer, usdcMint, makerAta.address, faucet, amount);
    log(`  minted ${formatUsdc(amount)} USDC to the maker`);
  } else {
    log(`  maker holds ${formatUsdc(have)} USDC (enough for ${toCreate} market(s) still to create plus ${formatUsdc(MAKER_USDC_RESERVE)} to trade with)`);
  }

  /* ---- 6. markets ---- */
  log('\n6. markets');
  const startedAt = Math.floor(Date.now() / 1000);
  const records: Record<string, unknown>[] = [];
  const volSources = new Set<string>();
  for (const p of PLAN) {
    const feed = PYTH_FEEDS[p.asset]!;
    const market = pda.market(maker.publicKey, p.nonce);
    let info = await conn.getAccountInfo(market, 'confirmed');
    let createTx = loadState().markets[p.nonce.toString()]?.createTx;
    if (!info) {
      const push = await readPushPrice(conn, p.asset);
      let spot: number;
      if (push && push.price > 0) {
        spot = push.price;
        if (push.ageSecs > 6 * 3600) notes.push(`${p.asset} push feed price is ${Math.round(push.ageSecs / 60)} minutes old`);
      } else {
        const env = Number(process.env[`SPOT_${p.asset}`]);
        spot = Number.isFinite(env) && env > 0 ? env : FALLBACK_SPOT[p.asset]!;
        notes.push(`${p.asset}: no push feed account on this cluster, spot ${spot} is a fallback value`);
      }
      const { vol, source } = volFor(p.asset);
      volSources.add(source);
      const strike = niceStrike(spot * (1 + p.strikePct / 100));
      const settleTs = roundUp(startedAt + p.settleInSecs, 300);
      const years = (settleTs - startedAt) / (365 * 86400);
      const fair = fairValueClose(spot, strike, vol, years);
      const p0Bps = Math.min(9_800, Math.max(200, toOpeningBps(fair)));
      const targetRaw = BigInt(Math.round(strike * 10 ** -feed.expo));
      const built = buildCreateMarketIx({
        creator: maker.publicKey,
        nonce: p.nonce,
        feedId: feedIdFromHex(feed.feedIdHex),
        kind: 'close',
        targetPrice: targetRaw,
        targetExpo: feed.expo,
        settleTs,
        baseFeeBps: BASE_FEE_BPS,
        dynamicFee: p.dynamicFee,
        liquidity: LIQUIDITY,
        p0Bps,
        usdcMint,
      });
      createTx = await send(conn, built.instructions, [maker], { label: `create_market ${p.asset}`, units: 300_000 });
      log(`  #${p.nonce} ${p.asset} spot ${spot} strike ${strike} settle +${Math.round((settleTs - startedAt) / 60)}m  fair ${(fair * 100).toFixed(1)}%  p0 ${p0Bps} bps  ${p.dynamicFee ? 'dynamic' : 'static'} fee  ${market.toBase58()}`);
      const st = loadState();
      st.markets[p.nonce.toString()] = { pubkey: market.toBase58(), createTx, asset: p.asset };
      saveState(st);
      info = await conn.getAccountInfo(market, 'confirmed');
    } else {
      log(`  #${p.nonce} ${p.asset} exists ${market.toBase58()}`);
    }
    const m = decodeMarket(info!.data);
    const strikeNum = Number(m.targetPrice) * 10 ** m.targetExpo;
    records.push({
      nonce: p.nonce.toString(),
      pubkey: market.toBase58(),
      asset: p.asset,
      question: buildQuestion({ assetSymbol: p.asset, kind: 'close', targetPrice: strikeNum, settleTs: Number(m.settleTs) }),
      feedId: feed.feedIdHex,
      targetPrice: m.targetPrice.toString(),
      targetExpo: m.targetExpo,
      openTs: Number(m.openTs),
      tradingEndTs: Number(m.tradingEndTs),
      settleTs: Number(m.settleTs),
      baseFeeBps: m.baseFeeBps,
      dynamicFee: m.dynamicFee,
      liquidity: LIQUIDITY.toString(),
      status: m.status,
      vault: m.vault.toBase58(),
      aboveMint: m.aboveMint.toBase58(),
      belowMint: m.belowMint.toBase58(),
      lpMint: m.lpMint.toBase58(),
      createTx: createTx ?? null,
    });
  }
  if (volSources.has('default')) notes.push('volatility: documented default annualized vols were used (Pyth Benchmarks needs an API key); set VOL_<SYMBOL> to override');

  /* ---- 7. public record ---- */
  writeJson(PUBLIC_RECORD, {
    cluster: 'devnet',
    rpc: RPC_URL,
    programId: PROGRAM_ID.toBase58(),
    usdcMint: usdcMint.toBase58(),
    usdcMintAuthority: faucet.publicKey.toBase58(),
    config: configPk.toBase58(),
    admin: admin.publicKey.toBase58(),
    treasury: cfg.treasury.toBase58(),
    maker: maker.publicKey.toBase58(),
    keeper: keeper.publicKey.toBase58(),
    faucet: faucet.publicKey.toBase58(),
    feeds: FEEDS.map((s) => ({ asset: s, symbol: PYTH_FEEDS[s]!.symbol, feedIdHex: PYTH_FEEDS[s]!.feedIdHex, allowlist: pda.feed(feedIdFromHex(PYTH_FEEDS[s]!.feedIdHex)).toBase58() })),
    config_params: { minDurationSecs: Number(cfg.minDurationSecs), minLiquidity: cfg.minLiquidity.toString(), tradingCloseSecs: cfg.tradingCloseSecs, maxFeeBps: cfg.maxFeeBps, maxStalenessSecs: cfg.maxStalenessSecs, maxConfBps: cfg.maxConfBps },
    markets: records,
    notes,
    generatedAt: new Date().toISOString(),
  });
  log(`\nrecord written to ${PUBLIC_RECORD.replace(process.cwd() + '/', '')}`);
  for (const n of notes) log(`note: ${n}`);
  log('\nbootstrap complete');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
