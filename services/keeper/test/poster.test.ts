import { pythPushFeedAddress as sdkPushFeedAddress } from '@groundgraph/sdk';
import { PROGRAM_ID, pda, pushFeedAddress as pythPushFeedAddress } from '@groundgraph/svc-core';
import { ComputeBudgetProgram, Keypair, type Connection, type VersionedTransaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { buildSettlePushTx, buildVoidTx, RpcPoster, SETTLE_CU_LIMIT } from '../src/poster';
import { chainMarket, silentLog } from './helpers';

const SOL_FEED = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
const BLOCKHASH = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';

function decode(tx: VersionedTransaction) {
  const keys = tx.message.staticAccountKeys;
  return tx.message.compiledInstructions.map((ix) => ({
    program: keys[ix.programIdIndex]!.toBase58(),
    accounts: ix.accountKeyIndexes.map((i) => keys[i]!.toBase58()),
    data: Buffer.from(ix.data),
  }));
}

describe('transaction builders', () => {
  const payer = Keypair.generate();

  it('the push feed address agrees with the SDK derivation', () => {
    expect(pythPushFeedAddress(SOL_FEED).toBase58()).toBe(sdkPushFeedAddress(SOL_FEED).toBase58());
  });

  it('settle_close carries the market, the config, the LP mint and the push feed account, with compute budget first', () => {
    const m = chainMarket();
    const feed = pythPushFeedAddress(SOL_FEED);
    const tx = buildSettlePushTx({ m, payer: payer.publicKey, priceUpdate: feed, blockhash: BLOCKHASH, feeMicroLamports: 20_000 });
    const ixs = decode(tx);
    expect(ixs).toHaveLength(3);
    expect(ixs[0]!.program).toBe(ComputeBudgetProgram.programId.toBase58());
    expect(ixs[1]!.program).toBe(ComputeBudgetProgram.programId.toBase58());
    const settle = ixs[2]!;
    expect(settle.program).toBe(PROGRAM_ID.toBase58());
    expect(settle.accounts).toEqual([payer.publicKey.toBase58(), pda.config().toBase58(), m.id, m.lpMint, feed.toBase58()]);
    // compute unit limit and price are the two budget instructions
    const limit = ixs.find((i) => i.data[0] === 2)!;
    const price = ixs.find((i) => i.data[0] === 3)!;
    expect(limit.data.readUInt32LE(1)).toBe(SETTLE_CU_LIMIT);
    expect(Number(price.data.readBigUInt64LE(1))).toBe(20_000);
    expect(tx.message.staticAccountKeys[0]!.toBase58()).toBe(payer.publicKey.toBase58());
  });

  it('void_market carries only the caller, market and LP mint', () => {
    const m = chainMarket();
    const ixs = decode(buildVoidTx({ m, payer: payer.publicKey, blockhash: BLOCKHASH, feeMicroLamports: 0 }));
    expect(ixs).toHaveLength(2); // no price instruction when the fee is zero
    expect(ixs[1]!.accounts).toEqual([payer.publicKey.toBase58(), m.id, m.lpMint]);
  });

  it('the two instructions use different discriminators', () => {
    const m = chainMarket();
    const s = decode(buildSettlePushTx({ m, payer: payer.publicKey, priceUpdate: pythPushFeedAddress(SOL_FEED), blockhash: BLOCKHASH, feeMicroLamports: 0 })).at(-1)!;
    const v = decode(buildVoidTx({ m, payer: payer.publicKey, blockhash: BLOCKHASH, feeMicroLamports: 0 })).at(-1)!;
    expect(s.data.subarray(0, 8).equals(v.data.subarray(0, 8))).toBe(false);
  });
});

describe('RpcPoster', () => {
  function fakeConnection() {
    const sent: VersionedTransaction[] = [];
    const conn = {
      getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 99 }),
      sendRawTransaction: async (raw: Uint8Array) => {
        const { VersionedTransaction } = await import('@solana/web3.js');
        sent.push(VersionedTransaction.deserialize(raw));
        return `sig${sent.length}`;
      },
      confirmTransaction: async () => ({ value: { err: null } }),
      getBalance: async () => 1_234_567_890,
    };
    return { conn: conn as unknown as Connection, sent };
  }

  it('signs with the keeper key, sends, and escalates the priority fee with the attempt number', async () => {
    const kp = Keypair.generate();
    const { conn, sent } = fakeConnection();
    const poster = new RpcPoster(conn, kp, { feeBase: 5_000, feeMax: 15_000, confirmTimeoutSecs: 5 }, silentLog);
    const m = chainMarket();
    const feed = pythPushFeedAddress(SOL_FEED);
    expect(await poster.settlePush(m, feed, 0)).toBe('sig1');
    await poster.settlePush(m, feed, 1);
    await poster.settlePush(m, feed, 5);
    const fees = sent.map((t) => Number(decode(t).find((i) => i.data[0] === 3)!.data.readBigUInt64LE(1)));
    expect(fees).toEqual([5_000, 10_000, 15_000]);
    expect(sent[0]!.signatures[0]!.some((b) => b !== 0)).toBe(true);
    expect(sent[0]!.message.staticAccountKeys[0]!.toBase58()).toBe(kp.publicKey.toBase58());
    expect(await poster.voidMarket(m, 0)).toBe('sig4');
    expect(await poster.balanceLamports()).toBe(1_234_567_890n);
  });

  it('surfaces an on-chain failure as an error', async () => {
    const kp = Keypair.generate();
    const { conn } = fakeConnection();
    (conn as unknown as { confirmTransaction: unknown }).confirmTransaction = async () => ({ value: { err: { InstructionError: [2, { Custom: 6006 }] } } });
    const poster = new RpcPoster(conn, kp, { feeBase: 0, feeMax: 0, confirmTimeoutSecs: 5 }, silentLog);
    await expect(poster.voidMarket(chainMarket(), 0)).rejects.toThrow(/failed.*6006/);
  });

  it('times out an unconfirmed transaction', async () => {
    const kp = Keypair.generate();
    const { conn } = fakeConnection();
    (conn as unknown as { confirmTransaction: unknown }).confirmTransaction = () => new Promise(() => {});
    const poster = new RpcPoster(conn, kp, { feeBase: 0, feeMax: 0, confirmTimeoutSecs: 0.05 as never }, silentLog);
    await expect(poster.voidMarket(chainMarket(), 0)).rejects.toThrow(/not confirmed/);
  });
});
