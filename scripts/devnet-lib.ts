/**
 * Shared helpers for the devnet scripts: key loading (never prints secrets), RPC, transaction sending with readable
 * failures, reading Pyth push-feed prices from the cluster, and the bootstrap state file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Commitment,
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  PROGRAM_ID,
  PYTH_FEEDS,
  decodePriceUpdateV2,
  pythPushFeedAddress,
  toUnsignedV0Tx,
  type PriceUpdateV2,
} from '@groundgraph/sdk';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const KEYS_DIR = process.env.KEYS_DIR ?? resolve(ROOT, '.keys');
export const RPC_URL = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
/** STATE_FILE, BOOTSTRAP_RECORD and SMOKE_RECORD can be redirected so a local rehearsal never touches the real files. */
export const STATE_FILE = process.env.STATE_FILE ?? resolve(ROOT, 'scripts/.bootstrap-state.json');
export const PUBLIC_RECORD = process.env.BOOTSTRAP_RECORD ?? resolve(ROOT, 'programs/groundgraph/deployments/devnet-bootstrap.json');
export const SMOKE_RECORD = process.env.SMOKE_RECORD ?? resolve(ROOT, 'programs/groundgraph/deployments/devnet-smoke.json');
export const DEPLOYMENT_FILE = resolve(ROOT, 'programs/groundgraph/deployments/devnet.json');
export const USDC = 1_000_000n;

/**
 * Annualized volatility used for the opening price of seeded markets. Pyth Benchmarks (historical prices) needs an
 * API key, so the scripts use these documented defaults unless `VOL_<SYMBOL>` is set in the environment.
 */
export const DEFAULT_VOL: Record<string, number> = { SOL: 0.8, BTC: 0.5, ETH: 0.65, JUP: 1.1, WIF: 1.4, BONK: 1.3 };

export function volFor(symbol: string): { vol: number; source: 'env' | 'default' } {
  const env = process.env[`VOL_${symbol}`];
  if (env && Number.isFinite(Number(env)) && Number(env) > 0) return { vol: Number(env), source: 'env' };
  return { vol: DEFAULT_VOL[symbol] ?? 1, source: 'default' };
}

export function loadKey(name: string): Keypair {
  const path = resolve(KEYS_DIR, `${name}.json`);
  if (!existsSync(path)) throw new Error(`missing key file ${path}`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]));
}

export function connect(commitment: Commitment = 'confirmed'): Connection {
  return new Connection(RPC_URL, { commitment, confirmTransactionInitialTimeout: 90_000 });
}

export const sol = (lamports: number | bigint): string => (Number(lamports) / 1e9).toFixed(4);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const log = (...a: unknown[]) => console.log(...a);

/** Send instructions as one v0 transaction signed by `signers[0]` (fee payer) and the others; throws with program logs. */
export async function send(
  conn: Connection,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  opts: { units?: number; label?: string } = {},
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const tx = toUnsignedV0Tx({ payer: signers[0]!.publicKey, instructions: ixs, blockhash, computeUnitLimit: opts.units ?? 300_000 });
  tx.sign(signers);
  try {
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
    const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    if (res.value.err) throw new Error(`${opts.label ?? 'transaction'} failed on chain: ${JSON.stringify(res.value.err)}`);
    return sig;
  } catch (e) {
    if (e instanceof SendTransactionError) {
      const logs = e.logs ?? [];
      const tail = logs.filter((l) => /Error|failed|custom program error|Program log:/.test(l)).slice(-8).join('\n  ');
      throw new Error(`${opts.label ?? 'transaction'} rejected: ${e.message}\n  ${tail}`);
    }
    throw e;
  }
}

export interface PushPrice {
  symbol: string;
  address: PublicKey;
  price: number;
  expo: number;
  publishTime: number;
  ageSecs: number;
  update: PriceUpdateV2;
}

/** Latest price of the sponsored shard-0 push feed on the cluster, or null when the account is missing. */
export async function readPushPrice(conn: Connection, symbol: string): Promise<PushPrice | null> {
  const feed = PYTH_FEEDS[symbol];
  if (!feed) throw new Error(`unknown asset ${symbol}`);
  const address = pythPushFeedAddress(feed.feedIdHex);
  const info = await conn.getAccountInfo(address, 'confirmed');
  if (!info) return null;
  const update = decodePriceUpdateV2(info.data);
  const price = Number(update.price) * 10 ** update.exponent;
  return { symbol, address, price, expo: update.exponent, publishTime: Number(update.publishTime), ageSecs: Math.floor(Date.now() / 1000) - Number(update.publishTime), update };
}

/** Round to 3 significant digits ("nice" strike prices). */
export function niceStrike(x: number): number {
  const digits = Math.floor(Math.log10(Math.abs(x)));
  const scale = 10 ** (digits - 2);
  return Number((Math.round(x / scale) * scale).toPrecision(3));
}

export interface BootstrapState {
  usdcMint?: string;
  markets: Record<string, { pubkey: string; createTx?: string; asset: string }>;
  [k: string]: unknown;
}

export function loadState(): BootstrapState {
  if (!existsSync(STATE_FILE)) return { markets: {} };
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as BootstrapState;
}

export function saveState(s: BootstrapState): void {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + '\n');
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
}

/** Program must be deployed (executable) on the target cluster. */
export async function requireProgram(conn: Connection): Promise<void> {
  const info = await conn.getAccountInfo(PROGRAM_ID, 'confirmed');
  if (!info?.executable) {
    throw new Error(`program ${PROGRAM_ID.toBase58()} is not deployed on ${RPC_URL}; run scripts/deploy-devnet.sh first`);
  }
}

/** Fund `to` from `from` with a plain transfer if its balance is below `minLamports`. */
export async function topUp(conn: Connection, from: Keypair, to: PublicKey, minLamports: number): Promise<void> {
  const bal = await conn.getBalance(to, 'confirmed');
  if (bal >= minLamports) return;
  const need = minLamports - bal;
  await send(conn, [SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: need })], [from], { label: 'top up', units: 10_000 });
  log(`  topped up ${to.toBase58().slice(0, 6)}... with ${sol(need)} SOL`);
}
