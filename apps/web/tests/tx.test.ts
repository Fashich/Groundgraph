import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, VersionedTransaction, type Connection } from '@solana/web3.js';
import type { UnsignedTx } from '@groundgraph/sdk/api-types';
import { PROGRAM_ID, buildBuyIx, buildMergeIx, buildRedeemIx, buildSellIx, decodeMarket, pda, toUnsignedV0Tx, type MarketAccount } from '@groundgraph/sdk';
import { ApiRequestError } from '@/lib/api';
import { TxFailure, failureCopy, nextPriorityFee, onchainFailure, runTx, toFailure, DEFAULT_PRIORITY_FEE, type FailureKind, type TxProgress } from '@/lib/tx';
import { bytesToBase64 } from '@/lib/siws';
import samples from '../../../packages/sdk/test/account-samples.json';

/* ---- a real unsigned v0 transaction built with the SDK, the way the API builds one ---- */
const user = Keypair.generate();
const creator = Keypair.generate().publicKey;
const marketPk = pda.market(creator, 7n);
const market: MarketAccount = {
  ...decodeMarket(Buffer.from(samples.marketOpen.hex, 'hex')),
  creator,
  nonce: 7n,
  collateralMint: Keypair.generate().publicKey,
  vault: pda.vault(marketPk),
  aboveMint: pda.aboveMint(marketPk),
  belowMint: pda.belowMint(marketPk),
  lpMint: pda.lpMint(marketPk),
};
const BLOCKHASH = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi5';
const args = { market, marketPk, user: user.publicKey };

function unsigned(ixs: ReturnType<typeof buildBuyIx>, over: Partial<UnsignedTx> = {}): UnsignedTx {
  const tx = toUnsignedV0Tx({ payer: user.publicKey, instructions: ixs, blockhash: BLOCKHASH, computeUnitLimit: 250_000, priorityFeeMicroLamports: 10_000 });
  return { transaction: bytesToBase64(tx.serialize()), blockhash: BLOCKHASH, lastValidBlockHeight: 1_000, summary: 'Buy ABOVE', ...over };
}
const buyTx = () => unsigned(buildBuyIx({ ...args, side: 'above', usdcIn: 5_000_000n, minSharesOut: 1n }));

function fakeConn(o: { statuses?: ({ err: unknown; confirmationStatus?: string } | null)[]; height?: number; sendError?: Error } = {}) {
  const sent: Uint8Array[] = [];
  let polls = 0;
  const conn = {
    sendRawTransaction: async (raw: Uint8Array) => {
      if (o.sendError) throw o.sendError;
      sent.push(raw);
      return 'SIG'.padEnd(88, 'x');
    },
    getSignatureStatuses: async () => {
      const s = o.statuses ? o.statuses[Math.min(polls, o.statuses.length - 1)] : { err: null, confirmationStatus: 'confirmed' };
      polls++;
      return { value: [s] };
    },
    getBlockHeight: async () => o.height ?? 10,
  } as unknown as Connection;
  return { conn, sent, polls: () => polls };
}

const kpSigner = { signTransaction: async (tx: VersionedTransaction) => (tx.sign([user]), tx) };
const fast = { pollMs: 1, slowAfterMs: 1_000_000, giveUpMs: 50 };

describe('SDK built transactions are readable by the client', () => {
  it('deserializes buy, sell, merge and redeem as v0 with the user as payer and the program invoked', () => {
    const all = [
      buildBuyIx({ ...args, side: 'above', usdcIn: 5_000_000n, minSharesOut: 1n }),
      buildSellIx({ ...args, side: 'below', sharesIn: 1_000_000n, minUsdcOut: 1n }),
      buildMergeIx({ ...args, amount: 1_000_000n }),
      buildRedeemIx({ ...args, side: 'above', amount: 1_000_000n }),
    ];
    for (const ixs of all) {
      const t = unsigned(ixs);
      const v = VersionedTransaction.deserialize(Buffer.from(t.transaction, 'base64'));
      expect(v.version).toBe(0);
      expect(v.message.staticAccountKeys[0]!.equals(user.publicKey)).toBe(true);
      const keys = v.message.staticAccountKeys.map((k) => k.toBase58());
      expect(keys).toContain(PROGRAM_ID.toBase58());
      expect(v.signatures.every((s) => s.every((b) => b === 0))).toBe(true); // unsigned
    }
  });
});

describe('runTx', () => {
  it('builds, asks the wallet to sign, broadcasts the signed bytes and waits for confirmation', async () => {
    const { conn, sent } = fakeConn();
    const steps: string[] = [];
    const res = await runTx({ build: async () => buyTx(), signer: kpSigner, connection: conn, onProgress: (p: TxProgress) => steps.push(p.step), ...fast });
    expect(res.signature).toMatch(/^SIG/);
    expect(steps[0]).toBe('build');
    expect(steps).toContain('sign');
    expect(steps).toContain('send');
    expect(steps.at(-1)).toBe('done');
    // what was broadcast is the same message, now carrying a valid signature from the user
    const back = VersionedTransaction.deserialize(sent[0]!);
    expect(back.signatures[0]!.some((b) => b !== 0)).toBe(true);
    expect(back.message.staticAccountKeys[0]!.equals(user.publicKey)).toBe(true);
  });

  it('uses the wallet to send when it only offers sendTransaction', async () => {
    const { conn, sent } = fakeConn();
    let called = false;
    const res = await runTx({
      build: async () => buyTx(),
      signer: { sendTransaction: async () => ((called = true), 'WALLETSIG'.padEnd(88, 'y')) },
      connection: conn,
      onProgress: () => undefined,
      ...fast,
    });
    expect(called).toBe(true);
    expect(sent).toHaveLength(0);
    expect(res.signature).toMatch(/^WALLETSIG/);
  });

  it('polls until the status turns confirmed', async () => {
    const { conn, polls } = fakeConn({ statuses: [null, { err: null, confirmationStatus: 'processed' }, { err: null, confirmationStatus: 'confirmed' }] });
    await runTx({ build: async () => buyTx(), signer: kpSigner, connection: conn, onProgress: () => undefined, ...fast, giveUpMs: 5_000 });
    expect(polls()).toBe(3);
  });

  it('reports a rejected signature as rejected, and sends nothing', async () => {
    const { conn, sent } = fakeConn();
    const err = Object.assign(new Error('User rejected the request.'), { code: 4001 });
    await expect(runTx({ build: async () => buyTx(), signer: { signTransaction: async () => Promise.reject(err) }, connection: conn, onProgress: () => undefined, ...fast })).rejects.toMatchObject({ kind: 'rejected' });
    expect(sent).toHaveLength(0);
  });

  it('maps an on-chain slippage error to slippage', async () => {
    const { conn } = fakeConn({ statuses: [{ err: { InstructionError: [2, { Custom: 6001 }] } }] });
    await expect(runTx({ build: async () => buyTx(), signer: kpSigner, connection: conn, onProgress: () => undefined, ...fast })).rejects.toMatchObject({ kind: 'slippage' });
  });

  it('expires when the block height passes lastValidBlockHeight', async () => {
    const { conn } = fakeConn({ statuses: [null], height: 5_000 });
    await expect(runTx({ build: async () => buyTx(), signer: kpSigner, connection: conn, onProgress: () => undefined, ...fast, giveUpMs: 5_000 })).rejects.toMatchObject({ kind: 'expired' });
  });

  it('gives up with expired when nothing confirms', async () => {
    const { conn } = fakeConn({ statuses: [null] });
    await expect(runTx({ build: async () => buyTx(), signer: kpSigner, connection: conn, onProgress: () => undefined, ...fast })).rejects.toMatchObject({ kind: 'expired' });
  });

  it('needs a signer, and says so', async () => {
    const { conn } = fakeConn();
    await expect(runTx({ build: async () => buyTx(), signer: null, connection: conn, onProgress: () => undefined, ...fast })).rejects.toMatchObject({ kind: 'no_wallet' });
  });

  it('surfaces API errors from the build step with their kind', async () => {
    const { conn } = fakeConn();
    for (const [code, kind] of [['geo_blocked', 'geo'], ['break_active', 'break'], ['view_only', 'view_only'], ['tos_required', 'tos'], ['daily_limit_exceeded', 'daily_limit'], ['oracle_stale', 'stale'], ['slippage_exceeded', 'slippage']] as const) {
      await expect(
        runTx({ build: async () => Promise.reject(new ApiRequestError(403, code, 'nope')), signer: kpSigner, connection: conn, onProgress: () => undefined, ...fast }),
      ).rejects.toMatchObject({ kind });
    }
  });

  it('refuses a garbage transaction instead of crashing', async () => {
    const { conn } = fakeConn();
    await expect(runTx({ build: async () => ({ ...buyTx(), transaction: 'AAAA' }), signer: kpSigner, connection: conn, onProgress: () => undefined, ...fast })).rejects.toMatchObject({ kind: 'failed' });
  });

  it('turns a failed broadcast into a failure', async () => {
    const { conn } = fakeConn({ sendError: new Error('failed to fetch') });
    await expect(runTx({ build: async () => buyTx(), signer: kpSigner, connection: conn, onProgress: () => undefined, ...fast })).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('failure mapping', () => {
  it('toFailure recognises wallet, RPC and program messages', () => {
    expect(toFailure({ code: 4001, message: 'x' }).kind).toBe('rejected');
    expect(toFailure(new Error('Transaction cancelled')).kind).toBe('rejected');
    expect(toFailure(new Error('custom program error: 0x1771')).kind).toBe('slippage');
    expect(toFailure(new Error('Blockhash not found')).kind).toBe('expired');
    expect(toFailure(new Error('block height exceeded')).kind).toBe('expired');
    expect(toFailure(new Error('Failed to fetch')).kind).toBe('network');
    expect(toFailure(new Error('something odd')).kind).toBe('failed');
    const f = new TxFailure('geo', 'x');
    expect(toFailure(f)).toBe(f);
  });
  it('onchainFailure maps the two slippage codes and an expired blockhash', () => {
    expect(onchainFailure({ InstructionError: [1, { Custom: 6001 }] }).kind).toBe('slippage');
    expect(onchainFailure({ InstructionError: [1, { Custom: 6002 }] }).kind).toBe('slippage');
    expect(onchainFailure('BlockhashNotFound').kind).toBe('expired');
    expect(onchainFailure({ InstructionError: [1, { Custom: 6010 }] }).kind).toBe('failed');
  });
  it('priority fee steps up by 4x and stops at 2,000,000', () => {
    expect(nextPriorityFee(undefined)).toBe(DEFAULT_PRIORITY_FEE * 4);
    expect(nextPriorityFee(40_000)).toBe(160_000);
    expect(nextPriorityFee(1_900_000)).toBe(2_000_000);
  });
});

describe('failure copy', () => {
  const kinds: FailureKind[] = ['rejected', 'expired', 'slippage', 'daily_limit', 'break', 'view_only', 'tos', 'geo', 'stale', 'liquidity', 'below_min', 'closed', 'unauthorized', 'rate_limited', 'network', 'no_wallet', 'failed'];
  const EM = String.fromCharCode(0x2014);
  it('every failure has a title, a body, and no banned wording', () => {
    for (const k of kinds) {
      const c = failureCopy(new TxFailure(k, 'x'));
      expect(c.title.length, k).toBeGreaterThan(5);
      expect(c.body.length, k).toBeGreaterThan(10);
      expect(`${c.title} ${c.body}`.includes(EM), k).toBe(false);
      expect(/\b(bet|betting|odds|gamble|jackpot)\b/i.test(`${c.title} ${c.body}`), k).toBe(false);
    }
  });
  it('geo and break copy tell the user that exits still work', () => {
    expect(failureCopy(new TxFailure('geo', 'x')).body).toMatch(/sell/i);
    expect(failureCopy(new TxFailure('break', 'x')).body).toMatch(/sell/i);
  });
  it('slippage offers a wider tolerance only below 2%', () => {
    expect(failureCopy(new TxFailure('slippage', 'x'), { slippageBps: 100 }).primary?.id).toBe('slippage2');
    expect(failureCopy(new TxFailure('slippage', 'x'), { slippageBps: 200 }).primary?.id).not.toBe('slippage2');
  });
  it('expired offers a priority fee retry', () => {
    expect(failureCopy(new TxFailure('expired', 'x')).primary?.id).toBe('retry_priority');
  });
});

describe('sanity', () => {
  it('the test wallet is a valid public key', () => {
    expect(new PublicKey(user.publicKey.toBase58()).equals(user.publicKey)).toBe(true);
  });
});
