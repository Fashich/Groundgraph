import { PublicKey } from '@solana/web3.js';
import devnetDeployment from '../../../programs/groundgraph/deployments/devnet.json';

export const USDC_DECIMALS = 6;
/** Minimum gross USDC for a buy: 1 USDC. */
export const MIN_TRADE_USDC = 1_000_000n;
/** A sell must release at least 0.01 USDC (before the fee). */
export const MIN_SELL_GROSS_USDC = 10_000n;
/** Pool reserves and trade sizes must stay strictly below 2^62. */
export const MAX_RESERVE = 1n << 62n;
export const P0_MIN_BPS = 200;
export const P0_MAX_BPS = 9_800;
export const ALLOWED_BASE_FEES_BPS = [50, 100, 200] as const;
/** Seconds after settle_ts without a valid settlement before anyone can void a market. */
export const VOID_GRACE_SECS = 3_600;

/** Program id: `PROGRAM_ID` env var when set (node), otherwise the committed devnet deployment record. */
function resolveProgramId(): PublicKey {
  const fromEnv = typeof process !== 'undefined' ? process.env?.PROGRAM_ID : undefined;
  return new PublicKey(fromEnv && fromEnv.length > 0 ? fromEnv : devnetDeployment.programId);
}
export const PROGRAM_ID: PublicKey = resolveProgramId();

export const DEVNET_DEPLOYMENT = devnetDeployment;

export const PYTH_RECEIVER_PROGRAM_ID = new PublicKey('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ');
/** Pyth push-oracle program that maintains sponsored price feed accounts (owned by the receiver program). */
export const PYTH_PUSH_ORACLE_PROGRAM_ID = new PublicKey('pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT');

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

export const PYTH_FEEDS: Record<string, { feedIdHex: string; symbol: string; expo: number }> = {
  SOL: { feedIdHex: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d', symbol: 'SOL/USD', expo: -8 },
  BTC: { feedIdHex: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43', symbol: 'BTC/USD', expo: -8 },
  ETH: { feedIdHex: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace', symbol: 'ETH/USD', expo: -8 },
  JUP: { feedIdHex: '0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996', symbol: 'JUP/USD', expo: -8 },
  WIF: { feedIdHex: '4ca4beeca86f0d164160323817a4e42b10010a724c2217c6ee41b54cd4cc61fc', symbol: 'WIF/USD', expo: -8 },
  BONK: { feedIdHex: '72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419', symbol: 'BONK/USD', expo: -10 },
};

/** Look up a feed by asset ticker ("SOL") or pair symbol ("SOL/USD"). */
export function parseAssetFeed(symbol: string): { feedIdHex: string; symbol: string; expo: number } | undefined {
  const key = symbol.trim().toUpperCase().replace(/\/USD$/, '');
  return Object.prototype.hasOwnProperty.call(PYTH_FEEDS, key) ? PYTH_FEEDS[key] : undefined;
}

export function feedIdFromHex(hex: string): Uint8Array {
  const h = hex.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new TypeError('feed id must be 32 bytes of hex');
  return Uint8Array.from(Buffer.from(h, 'hex'));
}

export function feedIdToHex(id: Uint8Array): string {
  return Buffer.from(id).toString('hex');
}

/**
 * Address of the sponsored Pyth push-feed account for a feed (shard 0 by default): PDA of the push-oracle program
 * with seeds [shard_id (u16 LE), feed_id]. The account is a PriceUpdateV2 owned by the receiver program, so it can
 * be passed straight to `settle_close` when its publish time falls inside the settlement window.
 * Verified against the devnet RPC: all six `PYTH_FEEDS` resolve to receiver-owned PriceUpdateV2 accounts whose embedded
 * feed id matches. Sponsored feeds update on a slow cadence, so a keeper normally posts a fresh update instead.
 */
export function pythPushFeedAddress(feedIdHex: string, shard = 0): PublicKey {
  const shardBuf = Buffer.alloc(2);
  shardBuf.writeUInt16LE(shard);
  return PublicKey.findProgramAddressSync([shardBuf, feedIdFromHex(feedIdHex)], PYTH_PUSH_ORACLE_PROGRAM_ID)[0];
}
