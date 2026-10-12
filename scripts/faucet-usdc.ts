/**
 * Mint test USDC to a wallet (the faucet key is the mint authority of the devnet test mint).
 *
 *   pnpm --filter @groundgraph/scripts faucet-usdc <wallet> [amount=1000]
 *
 * The faucet key pays for the recipient's token account (about 0.002 SOL), so it needs a little SOL.
 */
import { getAccount, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { decodeConfig, formatUsdc, pda } from '@groundgraph/sdk';
import { RPC_URL, USDC, connect, loadKey, log } from './devnet-lib';

async function main() {
  const [walletArg, amountArg] = process.argv.slice(2);
  if (!walletArg) {
    console.error('usage: faucet-usdc <wallet> [amount in USDC, default 1000]');
    process.exit(1);
  }
  const wallet = new PublicKey(walletArg);
  const amount = BigInt(Math.round(Number(amountArg ?? '1000') * 1_000_000));
  if (amount <= 0n || amount > 100_000n * USDC) throw new Error('amount must be between 0 and 100000 USDC');
  const conn = connect();
  const faucet = loadKey('faucet');
  const cfgInfo = await conn.getAccountInfo(pda.config(), 'confirmed');
  if (!cfgInfo) throw new Error(`config not initialized on ${RPC_URL}; run the bootstrap first`);
  const mint = decodeConfig(cfgInfo.data).usdcMint;
  const ata = await getOrCreateAssociatedTokenAccount(conn, faucet, mint, wallet);
  await mintTo(conn, faucet, mint, ata.address, faucet, amount);
  const bal = (await getAccount(conn, ata.address)).amount;
  log(`minted ${formatUsdc(amount)} test USDC to ${wallet.toBase58()} (balance ${formatUsdc(bal)}, mint ${mint.toBase58()})`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
