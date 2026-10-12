import { loadKeypair } from '@groundgraph/svc-core';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token';
import { PublicKey, Transaction, type Connection, type Keypair } from '@solana/web3.js';
import type { AppConfig } from '../config';
import type { FaucetMinter } from '../context';
import type { Logger } from '@groundgraph/svc-core';

/**
 * Devnet test-USDC faucet: the faucet keypair must be the mint authority of USDC_MINT (the devnet bootstrap script
 * creates the test mint with this key). Mints straight to the recipient's associated token account.
 * Returns null when the faucet is not configured (mainnet, or no key), so the route answers `faucet_unavailable`.
 */
export async function createFaucetMinter(cfg: AppConfig, connection: Connection, log: Logger): Promise<FaucetMinter | null> {
  if (!cfg.isDevnet || !cfg.FAUCET_KEYPAIR || !cfg.USDC_MINT) return null;
  let kp: Keypair;
  try {
    kp = loadKeypair(cfg.FAUCET_KEYPAIR);
  } catch (err) {
    log.error({ err: (err as Error).message }, 'FAUCET_KEYPAIR is set but unusable, faucet disabled');
    return null;
  }
  const mint = new PublicKey(cfg.USDC_MINT);
  try {
    const info = await getMint(connection, mint, 'confirmed');
    if (!info.mintAuthority || !info.mintAuthority.equals(kp.publicKey)) {
      log.warn({ mint: mint.toBase58(), authority: info.mintAuthority?.toBase58() ?? null, faucet: kp.publicKey.toBase58() }, 'faucet key is not the mint authority of USDC_MINT: mints will fail');
    }
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'could not verify the faucet mint authority at startup');
  }
  log.info({ faucet: kp.publicKey.toBase58() }, 'devnet faucet enabled');
  return {
    async mint(wallet: string, amount: bigint): Promise<string> {
      const owner = new PublicKey(wallet);
      const ata = getAssociatedTokenAddressSync(mint, owner, true);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ feePayer: kp.publicKey, blockhash, lastValidBlockHeight }).add(
        createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, ata, owner, mint),
        createMintToInstruction(mint, ata, kp.publicKey, amount),
      );
      tx.sign(kp);
      const sig = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
      const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
      if (res.value.err) throw new Error(`faucet mint failed: ${JSON.stringify(res.value.err)}`);
      return sig;
    },
  };
}
