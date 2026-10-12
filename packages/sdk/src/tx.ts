import { ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

/**
 * Build an unsigned v0 transaction. Compute budget instructions go first when a limit or priority fee is requested.
 * The caller (wallet or server) signs it.
 */
export function toUnsignedV0Tx(a: {
  payer: PublicKey;
  instructions: TransactionInstruction[];
  blockhash: string;
  computeUnitLimit?: number;
  priorityFeeMicroLamports?: number;
}): VersionedTransaction {
  const pre: TransactionInstruction[] = [];
  if (a.computeUnitLimit) pre.push(ComputeBudgetProgram.setComputeUnitLimit({ units: a.computeUnitLimit }));
  if (a.priorityFeeMicroLamports) pre.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: a.priorityFeeMicroLamports }));
  const msg = new TransactionMessage({
    payerKey: a.payer,
    recentBlockhash: a.blockhash,
    instructions: [...pre, ...a.instructions],
  }).compileToV0Message();
  return new VersionedTransaction(msg);
}
