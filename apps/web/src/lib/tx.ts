import { VersionedTransaction, type Connection } from '@solana/web3.js';
import type { UnsignedTx } from '@groundgraph/sdk/api-types';
import { ApiRequestError } from './api';
import { base64ToBytes } from './siws';

export type FailureKind =
  | 'rejected'
  | 'expired'
  | 'slippage'
  | 'daily_limit'
  | 'break'
  | 'view_only'
  | 'tos'
  | 'geo'
  | 'stale'
  | 'liquidity'
  | 'below_min'
  | 'closed'
  | 'unauthorized'
  | 'rate_limited'
  | 'network'
  | 'no_wallet'
  | 'failed';

export class TxFailure extends Error {
  readonly kind: FailureKind;
  readonly code?: string;
  constructor(kind: FailureKind, message: string, code?: string) {
    super(message);
    this.name = 'TxFailure';
    this.kind = kind;
    this.code = code;
  }
}

const API_KIND: Record<string, FailureKind> = {
  view_only: 'view_only',
  tos_required: 'tos',
  break_active: 'break',
  daily_limit_exceeded: 'daily_limit',
  oracle_stale: 'stale',
  market_closed: 'closed',
  slippage_exceeded: 'slippage',
  below_min_trade: 'below_min',
  insufficient_liquidity: 'liquidity',
  rate_limited: 'rate_limited',
  geo_blocked: 'geo',
  unauthorized: 'unauthorized',
  network: 'network',
};

const REJECT_RE = /reject|denied|declin|cancel|user refus|closed the (window|popup)/i;

/** Normalise anything thrown by the API client, the wallet or the RPC into a TxFailure. */
export function toFailure(e: unknown): TxFailure {
  if (e instanceof TxFailure) return e;
  if (e instanceof ApiRequestError) return new TxFailure(API_KIND[e.code] ?? 'failed', e.message, e.code);
  const err = e as { name?: string; message?: string; code?: number; error?: { message?: string; code?: number } } | undefined;
  const msg = String(err?.message ?? err?.error?.message ?? e ?? 'Transaction failed');
  const code = err?.code ?? err?.error?.code;
  if (code === 4001 || REJECT_RE.test(msg) || (err?.name && REJECT_RE.test(err.name))) return new TxFailure('rejected', msg);
  if (/slippage/i.test(msg) || /custom program error: 0x(1770|1771)/i.test(msg)) return new TxFailure('slippage', msg);
  if (/blockhash not found|block height exceeded|expired/i.test(msg)) return new TxFailure('expired', msg);
  if (/failed to fetch|networkerror|load failed/i.test(msg)) return new TxFailure('network', msg);
  return new TxFailure('failed', msg);
}

/** Map an on-chain transaction error (as returned by getSignatureStatuses) to a TxFailure. Custom 6001 and 6002 are the program's slippage errors. */
export function onchainFailure(err: unknown): TxFailure {
  const text = typeof err === 'string' ? err : JSON.stringify(err);
  if (/"Custom":\s*(6001|6002)\b/.test(text)) return new TxFailure('slippage', 'Slippage exceeded', 'slippage_exceeded');
  if (/BlockhashNotFound/.test(text)) return new TxFailure('expired', 'Blockhash not found', 'expired');
  return toFailure(new Error(`Transaction failed on chain: ${text}`));
}

export type ActionId = 'retry' | 'retry_priority' | 'slippage2' | 'halve' | 'connect' | 'accept_tos' | 'open_limits' | 'dismiss' | 'refresh';

export interface FailureCopy {
  title: string;
  body: string;
  code?: string;
  primary?: { id: ActionId; label: string };
  secondary?: { id: ActionId; label: string };
}

/** User-facing copy for each failure. No fake numbers: dynamic values come from the caller. */
export function failureCopy(f: TxFailure, ctx: { slippageBps?: number; breakUntil?: string | null; dailyLimit?: string | null } = {}): FailureCopy {
  const code = f.code ?? f.kind;
  switch (f.kind) {
    case 'rejected':
      return { title: 'Request rejected in your wallet', body: 'Nothing was sent and no funds moved. You can review the details and try again whenever you are ready.', code, primary: { id: 'retry', label: 'Try again' } };
    case 'expired':
      return { title: 'Transaction expired before it landed', body: 'The network was busy and the transaction was not confirmed in time. Nothing was charged. Retry with a higher priority fee so it lands faster.', code, primary: { id: 'retry_priority', label: 'Retry with higher priority fee' } };
    case 'slippage': {
      const cur = ctx.slippageBps ?? 100;
      const next = cur >= 200 ? null : { id: 'slippage2' as const, label: 'Retry at 2% slippage' };
      return { title: 'Price moved beyond your slippage limit', body: `The price changed before your trade settled, so it was not executed. You can accept a wider tolerance of 2% or halve the size to reduce the impact.`, code, primary: next ?? { id: 'halve', label: 'Halve the amount' }, secondary: next ? { id: 'halve', label: 'Halve the amount' } : undefined };
    }
    case 'daily_limit':
      return { title: 'Daily trading limit reached', body: 'This trade would take you past the daily limit you set for yourself. You can review or change it in Trading limits.', code, primary: { id: 'open_limits', label: 'Review trading limits' } };
    case 'break':
      return { title: 'You are on a break', body: `Buying and creating are paused until ${ctx.breakUntil ? new Date(ctx.breakUntil).toUTCString().replace(':00 GMT', ' UTC') : 'your break ends'}. You can still sell, merge and redeem existing positions. A break can only be extended, never shortened.`, code, primary: { id: 'open_limits', label: 'View trading limits' } };
    case 'view_only':
      return { title: 'This is a view-only session', body: 'You pasted an address, so Groundgraph can show positions but cannot build transactions for it. Connect a signing wallet to trade.', code, primary: { id: 'connect', label: 'Connect a signing wallet' } };
    case 'tos':
      return { title: 'Accept the Terms to continue', body: 'The Terms of Use and Risk Disclosure were updated. Review and accept the current version to trade.', code, primary: { id: 'accept_tos', label: 'Review and accept' } };
    case 'geo':
      return { title: 'Not available in your region', body: 'Buying and creating markets are not offered where you appear to be connecting from. Selling, merging and redeeming always work.', code };
    case 'stale':
      return { title: 'Price feed is stale, buys are paused', body: 'The oracle has not published a fresh price in over a minute. Selling and merging still work. Buying resumes automatically when the feed recovers.', code, primary: { id: 'refresh', label: 'Check again' } };
    case 'liquidity':
      return { title: 'Not enough liquidity for this size', body: 'The pool cannot fill this amount without breaking its reserves. Try a smaller amount.', code, primary: { id: 'halve', label: 'Halve the amount' } };
    case 'below_min':
      return { title: 'Below the 1 USDC minimum', body: 'Trades smaller than 1 USDC are not accepted.', code };
    case 'closed':
      return { title: 'Not available in this market right now', body: 'The market is not in a state that allows this action. Buying closes before the result, and redeeming opens after settlement. Check your positions.', code };
    case 'unauthorized':
      return { title: 'Your session has ended', body: 'Sign in again with your wallet to continue.', code, primary: { id: 'connect', label: 'Connect wallet' } };
    case 'rate_limited':
      return { title: 'Too many requests', body: 'Please wait a moment and try again.', code, primary: { id: 'retry', label: 'Try again' } };
    case 'network':
      return { title: 'Could not reach the network', body: 'Check your connection. Nothing was sent.', code, primary: { id: 'retry', label: 'Try again' } };
    case 'no_wallet':
      return { title: 'Wallet not connected', body: 'Your signing wallet is not connected in this browser. Reconnect it to sign this transaction.', code, primary: { id: 'connect', label: 'Reconnect wallet' } };
    default:
      return { title: 'Transaction failed', body: f.message && f.message.length >= 12 && f.message.length < 200 ? f.message : 'The transaction could not be completed. Nothing was charged.', code, primary: { id: 'retry', label: 'Try again' } };
  }
}

/* ------------------------------ execution ------------------------------ */

export type TxStep = 'build' | 'sign' | 'send' | 'confirm' | 'done';
export interface TxProgress {
  step: TxStep;
  label: string;
  sub: string;
  pct: number;
  signature?: string;
  slow?: boolean;
}

export interface SignerLike {
  signTransaction?: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
  sendTransaction?: (tx: VersionedTransaction, connection: Connection) => Promise<string>;
}

export const DEFAULT_PRIORITY_FEE = 10_000;
export const nextPriorityFee = (prev: number | undefined) => Math.min(2_000_000, (prev ?? DEFAULT_PRIORITY_FEE) * 4);

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      rej(new TxFailure('failed', 'Cancelled'));
    });
  });

export interface RunTxOptions {
  build: () => Promise<UnsignedTx>;
  signer: SignerLike | null;
  connection: Connection;
  onProgress: (p: TxProgress) => void;
  /** Poll interval in ms. Overridable for tests. */
  pollMs?: number;
  /** After this long without confirmation the UI is told the RPC is slow. */
  slowAfterMs?: number;
  /** Hard stop in ms when block height cannot be read. */
  giveUpMs?: number;
  signal?: AbortSignal;
}

export async function runTx(o: RunTxOptions): Promise<{ signature: string; tx: UnsignedTx }> {
  const poll = o.pollMs ?? 1200;
  o.onProgress({ step: 'build', label: 'Preparing transaction', sub: 'Building an unsigned transaction on the server', pct: 12 });
  let built: UnsignedTx;
  try {
    built = await o.build();
  } catch (e) {
    throw toFailure(e);
  }
  if (!o.signer || (!o.signer.signTransaction && !o.signer.sendTransaction)) throw new TxFailure('no_wallet', 'No signing wallet');
  let vtx: VersionedTransaction;
  try {
    vtx = VersionedTransaction.deserialize(base64ToBytes(built.transaction));
  } catch {
    throw new TxFailure('failed', 'The server returned a transaction this app cannot read.');
  }

  o.onProgress({ step: 'sign', label: 'Confirm in your wallet', sub: built.summary, pct: 30 });
  let signature: string;
  try {
    if (o.signer.signTransaction) {
      const signed = await o.signer.signTransaction(vtx);
      o.onProgress({ step: 'send', label: 'Sending to Solana', sub: 'Broadcasting the signed transaction', pct: 52 });
      signature = await o.connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3, preflightCommitment: 'confirmed' });
    } else {
      o.onProgress({ step: 'send', label: 'Sending to Solana', sub: 'Your wallet is signing and sending', pct: 52 });
      signature = await o.signer.sendTransaction!(vtx, o.connection);
    }
  } catch (e) {
    throw toFailure(e);
  }

  const started = Date.now();
  let n = 0;
  const slowAfter = o.slowAfterMs ?? 12_000;
  const giveUp = o.giveUpMs ?? 90_000;
  for (;;) {
    const slow = Date.now() - started > slowAfter;
    o.onProgress({ step: 'confirm', label: 'Confirming on Solana', sub: slow ? 'The network is slow right now, still waiting' : 'Waiting for confirmation', pct: Math.min(94, 60 + n * 4), signature, slow });
    let st: Awaited<ReturnType<Connection['getSignatureStatuses']>>['value'][number] = null;
    try {
      st = (await o.connection.getSignatureStatuses([signature])).value[0] ?? null;
    } catch {
      /* transient RPC error, keep polling */
    }
    if (st?.err) throw onchainFailure(st.err);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) break;
    if (n % 2 === 1) {
      try {
        const h = await o.connection.getBlockHeight('confirmed');
        if (h > built.lastValidBlockHeight) throw new TxFailure('expired', 'Block height exceeded', 'expired');
      } catch (e) {
        if (e instanceof TxFailure) throw e;
      }
    }
    if (Date.now() - started > giveUp) throw new TxFailure('expired', 'Timed out waiting for confirmation', 'expired');
    n++;
    await sleep(poll, o.signal);
  }
  o.onProgress({ step: 'done', label: 'Confirmed', sub: signature, pct: 100, signature });
  return { signature, tx: built };
}
