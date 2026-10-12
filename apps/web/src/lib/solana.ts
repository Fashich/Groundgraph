import { Connection, PublicKey } from '@solana/web3.js';
import { env } from './env';

let conn: Connection | null = null;

/** Shared RPC connection (HTTP only: confirmation is done by polling, no RPC websocket). */
export function getConnection(): Connection {
  if (!conn) conn = new Connection(env.rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: false });
  return conn;
}

export function isPubkey(s: string): boolean {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

/** USDC balance of a wallet in base units, or null when no mint is configured (balance unknown). */
export async function fetchUsdcBalance(owner: string): Promise<string | null> {
  if (!env.usdcMint || !isPubkey(env.usdcMint)) return null;
  const res = await getConnection().getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(env.usdcMint) });
  let total = 0n;
  for (const a of res.value) {
    const amt = (a.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info?.tokenAmount?.amount;
    if (amt) total += BigInt(amt);
  }
  return total.toString();
}

export function explorerTx(sig: string): string {
  const c = env.cluster === 'mainnet-beta' ? '' : `?cluster=${env.cluster}`;
  return `https://explorer.solana.com/tx/${sig}${c}`;
}

export function explorerAddr(addr: string): string {
  const c = env.cluster === 'mainnet-beta' ? '' : `?cluster=${env.cluster}`;
  return `https://explorer.solana.com/address/${addr}${c}`;
}
