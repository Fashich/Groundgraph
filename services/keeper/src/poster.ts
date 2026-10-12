import { buildSettleCloseIx, buildVoidMarketIx, toUnsignedV0Tx, type ChainMarket, type Logger } from '@groundgraph/svc-core';
import { type Connection, type Keypair, PublicKey, type TransactionInstruction, type VersionedTransaction } from '@solana/web3.js';
import { escalateFee } from './settle-logic';
import { KeypairWallet } from './wallet';

/** Sends the keeper's transactions. Injected so the settle loop can be tested without a cluster. */
export interface Poster {
  readonly payer: PublicKey;
  /** settle_close with an existing, fully verified price update account (the sponsored push feed) */
  settlePush(m: ChainMarket, priceUpdate: PublicKey, attempt: number): Promise<string>;
  /** post the Hermes update through the Pyth receiver and settle_close in the same bundle */
  settleHermes(m: ChainMarket, updates: string[], attempt: number): Promise<string>;
  voidMarket(m: ChainMarket, attempt: number): Promise<string>;
  balanceLamports(): Promise<bigint>;
}

export interface PosterOptions {
  feeBase: number;
  feeMax: number;
  confirmTimeoutSecs: number;
}

/** settle_close and void_market are light: well under 100k compute units each. */
export const SETTLE_CU_LIMIT = 200_000;

export function buildSettlePushTx(a: { m: Pick<ChainMarket, 'id' | 'raw'>; payer: PublicKey; priceUpdate: PublicKey; blockhash: string; feeMicroLamports: number }): VersionedTransaction {
  const ix = buildSettleCloseIx({ marketPk: new PublicKey(a.m.id), market: a.m.raw, priceUpdate: a.priceUpdate, payer: a.payer });
  return toUnsignedV0Tx({ payer: a.payer, instructions: [ix], blockhash: a.blockhash, computeUnitLimit: SETTLE_CU_LIMIT, priorityFeeMicroLamports: a.feeMicroLamports });
}

export function buildVoidTx(a: { m: Pick<ChainMarket, 'id' | 'raw'>; payer: PublicKey; blockhash: string; feeMicroLamports: number }): VersionedTransaction {
  const ix = buildVoidMarketIx({ marketPk: new PublicKey(a.m.id), market: a.m.raw, payer: a.payer });
  return toUnsignedV0Tx({ payer: a.payer, instructions: [ix], blockhash: a.blockhash, computeUnitLimit: SETTLE_CU_LIMIT, priorityFeeMicroLamports: a.feeMicroLamports });
}

export class RpcPoster implements Poster {
  private wallet: KeypairWallet;
  constructor(
    private connection: Connection,
    private keypair: Keypair,
    private o: PosterOptions,
    private log: Logger,
  ) {
    this.wallet = new KeypairWallet(keypair);
  }

  get payer(): PublicKey {
    return this.keypair.publicKey;
  }

  async balanceLamports(): Promise<bigint> {
    return BigInt(await this.connection.getBalance(this.keypair.publicKey, 'confirmed'));
  }

  private fee(attempt: number): number {
    return escalateFee(this.o.feeBase, attempt, this.o.feeMax);
  }

  private async sendAndConfirm(tx: VersionedTransaction, blockhash: string, lastValidBlockHeight: number): Promise<string> {
    tx.sign([this.keypair]);
    const signature = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3, preflightCommitment: 'confirmed' });
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`transaction ${signature} not confirmed within ${this.o.confirmTimeoutSecs}s`)), this.o.confirmTimeoutSecs * 1000).unref());
    const res = await Promise.race([this.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed'), timeout]);
    if (res.value.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(res.value.err)}`);
    return signature;
  }

  async settlePush(m: ChainMarket, priceUpdate: PublicKey, attempt: number): Promise<string> {
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
    const tx = buildSettlePushTx({ m, payer: this.payer, priceUpdate, blockhash, feeMicroLamports: this.fee(attempt) });
    return this.sendAndConfirm(tx, blockhash, lastValidBlockHeight);
  }

  async voidMarket(m: ChainMarket, attempt: number): Promise<string> {
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
    const tx = buildVoidTx({ m, payer: this.payer, blockhash, feeMicroLamports: this.fee(attempt) });
    return this.sendAndConfirm(tx, blockhash, lastValidBlockHeight);
  }

  async settleHermes(m: ChainMarket, updates: string[], attempt: number): Promise<string> {
    // heavy import (anchor + wormhole IDLs): only paid in Hermes mode
    const { PythSolanaReceiver } = await import('@pythnetwork/pyth-solana-receiver');
    const receiver = new PythSolanaReceiver({ connection: this.connection, wallet: this.wallet as never });
    const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: true });
    await builder.addPostPriceUpdates(updates);
    const marketPk = new PublicKey(m.id);
    await builder.addPriceConsumerInstructions(async (getPriceUpdateAccount) => {
      const instruction: TransactionInstruction = buildSettleCloseIx({
        marketPk,
        market: m.raw,
        priceUpdate: getPriceUpdateAccount(`0x${m.feedIdHex}`),
        payer: this.payer,
      });
      return [{ instruction, signers: [] }];
    });
    const txs = await builder.buildVersionedTransactions({ computeUnitPriceMicroLamports: this.fee(attempt) });
    this.log.info({ market: m.id, transactions: txs.length }, 'posting Hermes price update and settling');
    const sigs = await receiver.provider.sendAll(txs, { skipPreflight: false, commitment: 'confirmed', preflightCommitment: 'confirmed' });
    return sigs[sigs.length - 1] ?? '';
  }
}

/** KEEPER_SEND_TRANSACTIONS=false: logs what would have been sent. */
export class DryRunPoster implements Poster {
  constructor(
    readonly payer: PublicKey,
    private log: Logger,
  ) {}
  async settlePush(m: ChainMarket, priceUpdate: PublicKey): Promise<string> {
    this.log.warn({ market: m.id, priceUpdate: priceUpdate.toBase58() }, 'dry run: would settle with push feed');
    return 'dry-run';
  }
  async settleHermes(m: ChainMarket): Promise<string> {
    this.log.warn({ market: m.id }, 'dry run: would post the Hermes update and settle');
    return 'dry-run';
  }
  async voidMarket(m: ChainMarket): Promise<string> {
    this.log.warn({ market: m.id }, 'dry run: would void');
    return 'dry-run';
  }
  async balanceLamports(): Promise<bigint> {
    return 0n;
  }
}
