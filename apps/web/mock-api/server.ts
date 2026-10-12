/**
 * Groundgraph mock API. Implements the HTTP, WebSocket and Solana JSON-RPC surface the web app needs, with
 * deterministic fixtures labelled 'demo-synthetic'. Run with `pnpm --filter web mock` (port 4000).
 *
 * Test controls (not part of the real API): POST /__mock/config, POST /__mock/reset, POST /__mock/tick, GET /__mock/state.
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import type { BuildBuySellReq, BuildCreateReq, GraphPayload, MeResp, NonceResp, Paged, Quote, SessionResp, Side, UnsignedTx } from '@groundgraph/sdk/api-types';
import { CLUSTERS, DATA_SOURCE, MODEL_VERSION, ASSETS, DAY, HOUR, marketWalletRows, nodesFor, trackRecord } from './fixtures';
import { ApiFail, MockState, USDC, state, type Session } from './state';
import * as amm from './amm';
import { fakeAddress, mulberry32, hashStr } from './rng';

const PORT = Number(process.env.MOCK_PORT || 4000);
const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const COOKIE = 'gg_session';

/* ------------------------------ helpers ------------------------------ */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseCookies(h: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (h ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionFrom(cookieHeader: string | undefined): Session | null {
  const id = parseCookies(cookieHeader)[COOKIE];
  if (!id) return null;
  const s = state.sessions.get(id);
  if (!s || s.expiresAt < Date.now()) return null;
  return s;
}

const sessionResp = (s: Session): SessionResp => ({ wallet: s.wallet, mode: s.mode, walletName: s.walletName, tosVersion: s.tosVersion, tosAccepted: s.mode === 'sign' && s.tosVersion === state.cfg.tosVersion, expiresAt: new Date(s.expiresAt).toISOString() });

const isBase58Pubkey = (a: string) => {
  try {
    return bs58.decode(a).length === 32;
  } catch {
    return false;
  }
};

const u64 = (v: unknown, name = 'amount'): bigint => {
  if (typeof v !== 'string' || !/^\d+$/.test(v)) throw new ApiFail(400, 'bad_request', `${name} must be a decimal string of base units`);
  return BigInt(v);
};

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(text);
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ApiFail(400, 'bad_request', 'Body must be JSON');
  }
}

/* ------------------------------ websocket ------------------------------ */

interface Client {
  ws: WebSocket;
  subs: Set<string>;
  session: Session | null;
}
const clients = new Set<Client>();

function frame(ch: string, type: 'snapshot' | 'delta', data: unknown, seq?: number) {
  const ts = new Date(Date.now() - state.cfg.wsLagMs).toISOString();
  return JSON.stringify({ ch, type, seq: seq ?? state.nextSeq(ch), ts, data });
}

function emit(ch: string, data: unknown, only?: (c: Client) => boolean) {
  const msg = frame(ch, 'delta', data);
  for (const c of clients) if (c.subs.has(ch) && c.ws.readyState === 1 && (!only || only(c))) c.ws.send(msg);
}

function snapshotFor(c: Client, ch: string) {
  const [kind, ...rest] = ch.split(':');
  const id = rest.join(':');
  if (ch === 'markets:summary') return { markets: state.markets.map((m) => state.summary(m)) };
  if (kind === 'market') {
    const m = state.markets.find((x) => x.id === id);
    if (!m) return null;
    const f = state.fee(m);
    return { priceAbove: state.price(m), reserveAbove: m.pool.ra.toString(), reserveBelow: m.pool.rb.toString(), feeBps: f.totalBps };
  }
  if (kind === 'radar') {
    const m = state.markets.find((x) => x.id === id);
    return m ? state.summary(m).radar : null;
  }
  if (kind === 'oracle') {
    const norm = (h: string) => h.replace(/^0x/i, '').toLowerCase();
    const m = state.markets.find((x) => norm(state.oracleInfo(x).feedId) === norm(id));
    return m ? state.oracleInfo(m) : null;
  }
  if (kind === 'me') return c.session ? {} : null;
  return null;
}

function marketDelta(m: ReturnType<MockState['market']>, trade?: unknown) {
  const f = state.fee(m);
  return { priceAbove: state.price(m), reserveAbove: m.pool.ra.toString(), reserveBelow: m.pool.rb.toString(), feeBps: f.totalBps, ...(trade ? { trade } : {}) };
}

function pushMarketUpdate(m: ReturnType<MockState['market']>, trade?: unknown) {
  emit(`market:${m.id}`, marketDelta(m, trade));
  const s = state.summary(m);
  emit('markets:summary', { markets: [{ id: m.id, priceAbove: s.priceAbove, implied: s.implied, ch24: s.ch24, feeBpsNow: s.feeBpsNow, volume: s.volume, liquidity: s.liquidity, traders: s.traders, radar: s.radar }] });
}

/** One simulated trade by another wallet, so live flashes have something to show. */
function tick() {
  const open = state.markets.filter((m) => m.status === 'open');
  if (open.length === 0) return;
  for (let i = 0; i < 2; i++) {
    const m = open[Math.floor(state.rng() * open.length)]!;
    const side: Side = state.rng() < 0.5 ? 'above' : 'below';
    const usdc = BigInt(Math.round(20 + state.rng() * 280)) * USDC;
    const w = state.wallets[Math.floor(state.rng() * state.wallets.length)]!;
    const fee = state.fee(m).totalBps;
    const r = amm.buy(m.pool, side, usdc, fee);
    m.pool = r.pool;
    m.volume += usdc;
    m.completeSets += usdc - r.fee;
    state.recordFlow(m, usdc);
    const row = state.pushTrade(m, w.addr, side, 'buy', usdc, r.shares, r.fee);
    row.flagged = w.smart;
    m.series.push(state.price(m));
    m.series.shift();
    pushMarketUpdate(m, row);
  }
}

let ticker: ReturnType<typeof setInterval> | null = null;
let oracleTicker: ReturnType<typeof setInterval> | null = null;
let radarTicker: ReturnType<typeof setInterval> | null = null;
function startTimers() {
  stopTimers();
  ticker = setInterval(() => state.cfg.wsPush && tick(), 2600);
  oracleTicker = setInterval(() => {
    if (!state.cfg.wsPush) return;
    for (const a of ASSETS) {
      state.bumpOracle(a.symbol);
      emit(`oracle:${a.feedId}`, { feedId: a.feedId, symbol: a.feed, price: state.assetPrice(a.symbol), conf: state.assetPrice(a.symbol) * 0.0004, publishTs: new Date().toISOString(), ageSec: 1, stale: false });
    }
  }, 6000);
  radarTicker = setInterval(() => {
    if (!state.cfg.wsPush) return;
    const open = state.markets.filter((m) => m.status === 'open');
    const m = open[Math.floor(state.rng() * open.length)];
    if (m) emit(`radar:${m.id}`, state.summary(m).radar);
  }, 20000);
}
function stopTimers() {
  for (const t of [ticker, oracleTicker, radarTicker]) if (t) clearInterval(t);
}

/* ------------------------------ transactions ------------------------------ */

interface Pending {
  sig: string;
  wallet: string;
  memo: Record<string, unknown>;
  lastValid: number;
  sentAt: number;
  confirmAt: number;
  status: 'pending' | 'confirmed' | 'failed';
  err?: unknown;
}
const pending = new Map<string, Pending>();

function buildTx(wallet: string, memo: Record<string, unknown>, summary: string, priorityFee: number | undefined, receipt?: Partial<Quote>): UnsignedTx {
  const payer = new PublicKey(wallet);
  const lastValid = state.height() + 150;
  const blockhash = bs58.encode(randomBytes(32));
  const ix = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.max(0, Math.round(priorityFee ?? 10_000)) }),
    new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [{ pubkey: payer, isSigner: true, isWritable: false }], data: Buffer.from(JSON.stringify({ gg: 1, tos: state.cfg.tosVersion, ...memo })) }),
  ];
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ix }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  return { transaction: Buffer.from(tx.serialize()).toString('base64'), blockhash, lastValidBlockHeight: lastValid, summary, receipt };
}

function guardTx(session: Session | null, kind: 'buy' | 'sell' | 'merge' | 'redeem' | 'create'): Session {
  if (!session) throw new ApiFail(401, 'unauthorized', 'Sign in with your wallet first');
  if (session.mode !== 'sign') throw new ApiFail(403, 'view_only', 'This is a view-only session. Connect a signing wallet to trade.');
  if (session.tosVersion !== state.cfg.tosVersion) throw new ApiFail(403, 'tos_required', 'Accept the current Terms to continue');
  // Only opening exposure is geofenced. Sells, merges and redeems must always work so nobody is trapped in a position.
  if (state.cfg.geoBlockTx && (kind === 'buy' || kind === 'create')) throw new ApiFail(403, 'geo_blocked', 'Buying and creating are not available in your region');
  const f = state.cfg.failNext;
  if (f) {
    state.cfg.failNext = null;
    const status = f === 'rate_limited' ? 429 : f === 'internal' ? 500 : 409;
    throw new ApiFail(status, f, `Simulated ${f}`);
  }
  return session;
}

function checkBuyLimits(wallet: string, amount: bigint) {
  const s = state.setting(wallet);
  if (s.breakUntil && s.breakUntil > Date.now()) throw new ApiFail(403, 'break_active', 'You are on a break. Buying and creating are paused.', { breakUntil: new Date(s.breakUntil).toISOString() });
  if (s.dailyLimit !== null && s.spent + amount > s.dailyLimit) throw new ApiFail(403, 'daily_limit_exceeded', 'This would exceed your daily limit', { limit: s.dailyLimit.toString(), spent: s.spent.toString() });
}

/** The `me` channel payload for a confirmed transaction, in the shape the indexer publishes. */
function meEvent(op: string, m: Record<string, unknown>, p: Pending): Record<string, unknown> {
  const base = { marketId: String(m.marketId ?? ''), txSig: p.sig };
  if (op === 'buy' || op === 'sell') {
    const mk = state.market(base.marketId);
    return { kind: 'fill', ...base, side: m.side, dir: op, usdc: op === 'buy' ? String(m.amount) : '0', shares: op === 'sell' ? String(m.amount) : '0', priceAfter: state.price(mk) };
  }
  if (op === 'merge') return { kind: 'merged', ...base, amount: String(m.amount) };
  if (op === 'redeem') return { kind: 'redeemed', ...base, side: m.side, shares: String(m.amount), usdc: String(m.amount) };
  return { kind: 'created', ...base };
}

function applyConfirmed(p: Pending) {
  const m = p.memo;
  const op = String(m.op);
  try {
    if (op === 'buy' || op === 'sell') {
      const mk = state.market(String(m.marketId));
      const side = m.side as Side;
      const amount = BigInt(String(m.amount));
      const minOut = BigInt(String(m.minOut ?? '0'));
      const q = state.quote(mk, side, op, amount, 0, null);
      if (BigInt(q.amountOut) < minOut) throw new Error('slippage');
      const row = op === 'buy' ? state.applyBuy(p.wallet, mk, side, amount) : state.applySell(p.wallet, mk, side, amount);
      mk.series.push(state.price(mk));
      mk.series.shift();
      pushMarketUpdate(mk, row);
    } else if (op === 'merge') {
      state.applyMerge(p.wallet, state.market(String(m.marketId)), BigInt(String(m.amount)));
    } else if (op === 'redeem') {
      state.applyRedeem(p.wallet, state.market(String(m.marketId)), m.side as Side, BigInt(String(m.amount)));
    } else if (op === 'create') {
      const mk = state.applyCreate(p.wallet, m.params as Parameters<MockState['applyCreate']>[1]);
      m.marketId = mk.id;
      emit('markets:summary', { markets: [state.summary(mk)] });
    }
    p.status = 'confirmed';
    emit('me', meEvent(op, m, p), (c) => c.session?.wallet === p.wallet);
  } catch (e) {
    p.status = 'failed';
    p.err = (e as Error).message === 'slippage' ? { InstructionError: [2, { Custom: 6001 }] } : { InstructionError: [2, { Custom: 6000 }] };
  }
}

/* ------------------------------ JSON-RPC ------------------------------ */

function rpcCall(method: string, params: unknown[]): unknown {
  const slot = 400_000_000 + Math.floor((Date.now() - state.t0) / 400);
  const ctx = { slot };
  switch (method) {
    case 'getLatestBlockhash':
      return { context: ctx, value: { blockhash: bs58.encode(randomBytes(32)), lastValidBlockHeight: state.height() + 150 } };
    case 'getBlockHeight': {
      if (state.cfg.rpc === 'expire') {
        const last = [...pending.values()].pop();
        if (last) return last.lastValid + 5;
      }
      return state.height();
    }
    case 'getSlot':
      return slot;
    case 'getVersion':
      return { 'solana-core': '2.2.0', 'feature-set': 1 };
    case 'getHealth':
      return 'ok';
    case 'getBalance':
      return { context: ctx, value: 2_500_000_000 };
    case 'getParsedTokenAccountsByOwner': {
      const owner = String(params[0]);
      const bal = state.balance(owner);
      const funded = state.balances.has(owner);
      if (!funded) return { context: ctx, value: [] };
      return {
        context: ctx,
        value: [
          {
            pubkey: fakeAddress(mulberry32(hashStr(owner + 'ata')), 44),
            account: {
              executable: false,
              lamports: 2039280,
              owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
              rentEpoch: 0,
              space: 165,
              data: { program: 'spl-token', space: 165, parsed: { type: 'account', info: { isNative: false, mint: String((params[1] as { mint?: string })?.mint ?? ''), owner, state: 'initialized', tokenAmount: { amount: bal.toString(), decimals: 6, uiAmount: Number(bal) / 1e6, uiAmountString: (Number(bal) / 1e6).toString() } } } },
            },
          },
        ],
      };
    }
    case 'sendTransaction': {
      const raw = Buffer.from(String(params[0]), 'base64');
      const tx = VersionedTransaction.deserialize(raw);
      const sig0 = tx.signatures[0];
      if (!sig0 || sig0.every((b) => b === 0)) throw rpcErr(-32002, 'Transaction signature verification failure');
      const payer = tx.message.staticAccountKeys[0]!;
      if (!nacl.sign.detached.verify(tx.message.serialize(), sig0, payer.toBytes())) throw rpcErr(-32002, 'Transaction signature verification failure');
      const memoIx = tx.message.compiledInstructions.find((i) => tx.message.staticAccountKeys[i.programIdIndex]!.equals(MEMO_PROGRAM));
      if (!memoIx) throw rpcErr(-32002, 'Transaction simulation failed: missing instruction');
      const memo = JSON.parse(Buffer.from(memoIx.data).toString('utf8')) as Record<string, unknown>;
      const sig = bs58.encode(sig0);
      const delay = state.cfg.rpc === 'slow' ? 15_000 : 900;
      const p: Pending = { sig, wallet: payer.toBase58(), memo, lastValid: state.height() + 150, sentAt: Date.now(), confirmAt: Date.now() + delay, status: 'pending' };
      pending.set(sig, p);
      if (state.cfg.rpc !== 'expire') setTimeout(() => p.status === 'pending' && applyConfirmed(p), delay);
      return sig;
    }
    case 'getSignatureStatuses': {
      const sigs = (params[0] as string[]) ?? [];
      return {
        context: ctx,
        value: sigs.map((s) => {
          const p = pending.get(s);
          if (!p || p.status === 'pending') return null;
          return { slot, confirmations: null, err: p.status === 'failed' ? p.err : null, confirmationStatus: 'confirmed', status: p.status === 'failed' ? { Err: p.err } : { Ok: null } };
        }),
      };
    }
    default:
      throw rpcErr(-32601, `Method not found: ${method}`);
  }
}

function rpcErr(code: number, message: string) {
  return Object.assign(new Error(message), { rpcCode: code });
}

/* ------------------------------ router ------------------------------ */

type Ctx = { req: http.IncomingMessage; res: http.ServerResponse; url: URL; session: Session | null; body: Record<string, unknown>; params: string[] };
type Handler = (c: Ctx) => unknown | Promise<unknown>;
const routes: { method: string; re: RegExp; h: Handler }[] = [];
const route = (method: string, path: string, h: Handler) => routes.push({ method, re: new RegExp(`^${path.replace(/:[a-zA-Z]+/g, '([^/]+)')}$`), h });

const needSession = (c: Ctx): Session => {
  if (!c.session) throw new ApiFail(401, 'unauthorized', 'No session');
  return c.session;
};
const needSign = (c: Ctx): Session => {
  const s = needSession(c);
  if (s.mode !== 'sign') throw new ApiFail(403, 'view_only', 'This is a view-only session');
  return s;
};

function paged<T>(items: T[], c: Ctx, defLimit = 30): Paged<T> {
  const limit = Math.min(100, Math.max(1, Number(c.url.searchParams.get('limit')) || defLimit));
  const start = Number(c.url.searchParams.get('cursor')) || 0;
  const slice = items.slice(start, start + limit);
  return { items: slice, nextCursor: start + limit < items.length ? String(start + limit) : null };
}

/* auth */
route('POST', '/auth/nonce', (c) => {
  const wallet = String(c.body.wallet ?? '');
  if (!isBase58Pubkey(wallet)) throw new ApiFail(400, 'bad_request', 'wallet must be a Solana address');
  const issued = Date.now();
  const n = { nonce: randomBytes(12).toString('hex'), issuedAt: issued, exp: issued + 10 * 60_000 };
  state.nonces.set(wallet, n);
  const out: NonceResp = {
    nonce: n.nonce,
    issuedAt: new Date(issued).toISOString(),
    expirationTime: new Date(n.exp).toISOString(),
    domain: 'localhost:3000',
    uri: 'http://localhost:3000',
    statement: 'Sign in to Groundgraph. This request does not trigger a transaction or cost anything.',
    tosVersion: state.cfg.tosVersion,
    chainId: 'solana:devnet',
  };
  return out;
});

route('POST', '/auth/verify', (c) => {
  const wallet = String(c.body.wallet ?? '');
  const n = state.nonces.get(wallet);
  if (!n || n.exp < Date.now()) throw new ApiFail(400, 'bad_request', 'Nonce missing or expired. Try again.');
  if (c.body.tosAccepted !== true) throw new ApiFail(403, 'tos_required', 'You must accept the Terms to sign in');
  const msg = Buffer.from(String(c.body.signedMessage ?? ''), 'base64');
  const sig = Buffer.from(String(c.body.signature ?? ''), 'base64');
  const text = msg.toString('utf8');
  if (!text.includes(n.nonce) || !text.includes(wallet)) throw new ApiFail(400, 'bad_request', 'Signed message does not match the issued nonce');
  let ok = false;
  try {
    ok = nacl.sign.detached.verify(new Uint8Array(msg), new Uint8Array(sig), bs58.decode(wallet));
  } catch {
    ok = false;
  }
  if (!ok) throw new ApiFail(401, 'unauthorized', 'Signature verification failed');
  state.nonces.delete(wallet);
  const s: Session = { id: randomBytes(16).toString('hex'), wallet, mode: 'sign', walletName: typeof c.body.walletName === 'string' ? c.body.walletName : null, tosVersion: state.cfg.tosVersion, expiresAt: Date.now() + 7 * DAY };
  state.sessions.set(s.id, s);
  state.log(wallet, { type: 'limit', summary: 'Signed in and accepted the Terms' });
  c.res.setHeader('set-cookie', `${COOKIE}=${s.id}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${7 * 86400}`);
  return sessionResp(s);
});

route('POST', '/auth/view', (c) => {
  const address = String(c.body.address ?? '').trim();
  if (/^0x/i.test(address)) throw new ApiFail(400, 'bad_request', 'That is an EVM (0x) address. Groundgraph runs on Solana: switch to your Solana account and copy that address.');
  if (!isBase58Pubkey(address)) throw new ApiFail(400, 'bad_request', 'Not a valid Solana address');
  const s: Session = { id: randomBytes(16).toString('hex'), wallet: address, mode: 'view', walletName: null, tosVersion: null, expiresAt: Date.now() + 2 * DAY };
  state.sessions.set(s.id, s);
  c.res.setHeader('set-cookie', `${COOKIE}=${s.id}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${2 * 86400}`);
  return sessionResp(s);
});

route('POST', '/auth/logout', (c) => {
  const id = parseCookies(c.req.headers.cookie)[COOKIE];
  if (id) state.sessions.delete(id);
  c.res.setHeader('set-cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
  return { ok: true };
});

route('GET', '/auth/session', (c) => sessionResp(needSession(c)));

route('POST', '/auth/tos', (c) => {
  const s = needSign(c);
  s.tosVersion = String(c.body.tosVersion ?? state.cfg.tosVersion);
  return sessionResp(s);
});

/* markets */
const hoursLeft = (ms: number) => (ms - Date.now()) / HOUR;
route('GET', '/markets', (c) => {
  const q = c.url.searchParams;
  const cat = q.get('cat');
  const lean = q.get('lean');
  const ends = q.get('ends');
  const sort = q.get('sort') || 'signal';
  const text = (q.get('q') || '').trim().toLowerCase();
  const status = q.get('status');
  const watchOnly = q.get('watch') === 'true' || q.get('watch') === '1';
  const watched = c.session ? state.watch.get(c.session.wallet) : undefined;
  let list = state.markets.map((m) => ({ m, s: state.summary(m) }));
  if (status === 'open') list = list.filter((x) => x.m.status === 'open');
  if (cat && cat !== 'All') list = list.filter((x) => (cat === 'High signal' ? x.s.radar.state === 'ready' && Math.abs(x.s.radar.edge ?? 0) >= 8 : x.m.category === cat));
  if (lean === 'above') list = list.filter((x) => x.s.radar.state === 'ready' && (x.s.radar.edge ?? 0) > 0);
  if (lean === 'below') list = list.filter((x) => x.s.radar.state === 'ready' && (x.s.radar.edge ?? 0) < 0);
  if (ends === '48h') list = list.filter((x) => hoursLeft(x.m.settleTs) < 48 && hoursLeft(x.m.settleTs) > 0);
  if (ends === '2w') list = list.filter((x) => hoursLeft(x.m.settleTs) < 14 * 24);
  if (ends === 'long') list = list.filter((x) => hoursLeft(x.m.settleTs) >= 14 * 24);
  if (text) list = list.filter((x) => x.s.question.toLowerCase().includes(text) || x.m.asset.toLowerCase().includes(text));
  if (watchOnly) list = list.filter((x) => watched?.has(x.m.id));
  const edgeAbs = (x: (typeof list)[number]) => (x.s.radar.state === 'ready' ? Math.abs(x.s.radar.edge ?? 0) : -1);
  list.sort((a, b) => (sort === 'gap' ? edgeAbs(b) - edgeAbs(a) : sort === 'ending' ? a.m.settleTs - b.m.settleTs : sort === 'volume' ? Number(b.m.volume - a.m.volume) : b.s.radar.n - a.s.radar.n || edgeAbs(b) - edgeAbs(a)));
  return paged(list.map((x) => x.s), c, 24);
});

route('GET', '/markets/:id', (c) => {
  const tf = (c.url.searchParams.get('tf') || '1D') as '1D' | '3D' | '1W' | 'ALL';
  return state.detail(state.market(c.params[0]!), ['1D', '3D', '1W', 'ALL'].includes(tf) ? tf : '1D');
});
route('GET', '/markets/:id/wallets', (c) => marketWalletRows(state.market(c.params[0]!), state.wallets));
route('GET', '/markets/:id/trades', (c) => {
  const m = state.market(c.params[0]!);
  return paged(state.trades.get(m.id) ?? [], c, 30);
});
route('GET', '/markets/:id/quote', (c) => {
  const m = state.market(c.params[0]!);
  const side = c.url.searchParams.get('side');
  const dir = c.url.searchParams.get('dir');
  if ((side !== 'above' && side !== 'below') || (dir !== 'buy' && dir !== 'sell')) throw new ApiFail(400, 'bad_request', 'side must be above|below and dir buy|sell');
  const amount = u64(c.url.searchParams.get('amount'));
  if (amount <= 0n) throw new ApiFail(400, 'bad_request', 'amount must be positive');
  const slip = Math.min(1000, Math.max(1, Number(c.url.searchParams.get('slippageBps')) || 100));
  if (dir === 'buy' && amount < USDC) throw new ApiFail(422, 'below_min_trade', 'Minimum trade is 1 USDC');
  return state.quote(m, side, dir, amount, slip, c.session?.mode === 'sign' ? c.session.wallet : null);
});

route('GET', '/fair-value', (c) => {
  const q = c.url.searchParams;
  const target = Number(q.get('target'));
  const settle = Date.parse(q.get('settleTs') || '');
  if (!(target > 0) || Number.isNaN(settle)) throw new ApiFail(400, 'bad_request', 'target and settleTs are required');
  return state.fairValue(String(q.get('asset') || 'SOL'), target, settle, String(q.get('kind') || 'close'), String(q.get('direction') || 'up'));
});
route('GET', '/assets', () => ASSETS.map((a) => ({ symbol: a.symbol, feedId: a.feedId, price: state.assetPrice(a.symbol), ageSec: 2 + Math.floor((Date.now() / 1000) % 5) })));

/* transactions */
route('POST', '/tx/buy', (c) => {
  const s = guardTx(c.session, 'buy');
  const b = c.body as unknown as BuildBuySellReq;
  const m = state.market(b.marketId);
  const amount = u64(b.amount);
  if (m.status !== 'open' || Date.now() > m.tradingEndsTs) throw new ApiFail(409, 'market_closed', 'Trading has closed for this market');
  if (m.oracleStale) throw new ApiFail(409, 'oracle_stale', 'The price feed is stale, so buys are paused');
  if (amount < USDC) throw new ApiFail(422, 'below_min_trade', 'Minimum trade is 1 USDC');
  checkBuyLimits(s.wallet, amount);
  if (state.balance(s.wallet) < amount) throw new ApiFail(400, 'bad_request', 'Not enough USDC in this wallet. Get test USDC from the faucet.');
  const slip = b.slippageBps ?? 100;
  const q = state.quote(m, b.side, 'buy', amount, slip, s.wallet);
  if (q.warnings.includes('exceeds_slippage')) throw new ApiFail(409, 'slippage_exceeded', 'Price would move beyond your slippage limit', { slippageBps: slip });
  return buildTx(s.wallet, { op: 'buy', marketId: m.id, side: b.side, amount: amount.toString(), minOut: q.minOut }, `Buy ${b.side.toUpperCase()} · ${Number(amount) / 1e6} USDC`, b.priorityFeeMicroLamports, q);
});

route('POST', '/tx/sell', (c) => {
  const s = guardTx(c.session, 'sell');
  const b = c.body as unknown as BuildBuySellReq;
  const m = state.market(b.marketId);
  const shares = u64(b.amount);
  if (m.status !== 'open') throw new ApiFail(409, 'market_closed', 'Trading has closed for this market');
  const have = state.walletPositions(s.wallet).get(`${m.id}|${b.side}`)?.shares ?? 0n;
  if (shares > have) throw new ApiFail(422, 'insufficient_liquidity', 'You hold fewer shares than that');
  const slip = b.slippageBps ?? 100;
  const q = state.quote(m, b.side, 'sell', shares, slip, s.wallet);
  if (q.warnings.includes('exceeds_slippage')) throw new ApiFail(409, 'slippage_exceeded', 'Price would move beyond your slippage limit', { slippageBps: slip });
  return buildTx(s.wallet, { op: 'sell', marketId: m.id, side: b.side, amount: shares.toString(), minOut: q.minOut }, `Sell ${b.side.toUpperCase()} · ${Number(shares) / 1e6} shares`, b.priorityFeeMicroLamports, q);
});

route('POST', '/tx/merge', (c) => {
  const s = guardTx(c.session, 'merge');
  const m = state.market(String(c.body.marketId));
  const amount = u64(c.body.amount);
  const pos = state.walletPositions(s.wallet);
  const a = pos.get(`${m.id}|above`)?.shares ?? 0n;
  const b = pos.get(`${m.id}|below`)?.shares ?? 0n;
  if (amount > a || amount > b) throw new ApiFail(422, 'insufficient_liquidity', 'You need an equal amount of ABOVE and BELOW shares to merge');
  return buildTx(s.wallet, { op: 'merge', marketId: m.id, amount: amount.toString() }, `Merge ${Number(amount) / 1e6} complete sets into USDC`, c.body.priorityFeeMicroLamports as number | undefined);
});

route('POST', '/tx/redeem', (c) => {
  const s = guardTx(c.session, 'redeem');
  const m = state.market(String(c.body.marketId));
  const side = c.body.side as Side;
  if (m.status !== 'settled' && m.status !== 'voided') throw new ApiFail(409, 'market_closed', 'This market has not settled yet');
  if (m.status === 'settled' && m.outcome !== side) throw new ApiFail(422, 'bad_request', 'Only shares on the settled side can be redeemed');
  const amount = u64(c.body.amount);
  const have = state.walletPositions(s.wallet).get(`${m.id}|${side}`)?.shares ?? 0n;
  if (amount > have) throw new ApiFail(422, 'insufficient_liquidity', 'You hold fewer shares than that');
  return buildTx(s.wallet, { op: 'redeem', marketId: m.id, side, amount: amount.toString() }, `Redeem ${Number(amount) / 1e6} USDC`, c.body.priorityFeeMicroLamports as number | undefined);
});

route('POST', '/tx/create', (c) => {
  const s = guardTx(c.session, 'create');
  const b = c.body as unknown as BuildCreateReq;
  const liq = u64(b.liquidityUsdc, 'liquidityUsdc');
  if (!ASSETS.some((a) => a.symbol === b.assetSymbol)) throw new ApiFail(400, 'bad_request', 'Unknown asset');
  if (!(b.targetPrice > 0)) throw new ApiFail(400, 'bad_request', 'targetPrice must be positive');
  const settle = Date.parse(b.settleTs);
  if (Number.isNaN(settle) || settle - Date.now() < 24 * HOUR || settle - Date.now() > 180 * DAY) throw new ApiFail(400, 'bad_request', 'Resolution must be between 24 hours and 180 days away');
  if (liq < 100n * USDC || liq > 100_000n * USDC) throw new ApiFail(400, 'bad_request', 'Liquidity must be between 100 and 100,000 USDC');
  if (![50, 100, 200].includes(b.baseFeeBps)) throw new ApiFail(400, 'bad_request', 'baseFeeBps must be 50, 100 or 200');
  checkBuyLimits(s.wallet, liq);
  if (state.balance(s.wallet) < liq) throw new ApiFail(400, 'bad_request', 'Not enough USDC for this liquidity. Get test USDC from the faucet.');
  const id = fakeAddress(mulberry32(hashStr(`${s.wallet}|${b.assetSymbol}|${b.targetPrice}|${b.settleTs}`)), 44);
  const params = { assetSymbol: b.assetSymbol, kind: b.kind, targetPrice: b.targetPrice, settleTs: b.settleTs, baseFeeBps: b.baseFeeBps, dynamicFee: !!b.dynamicFee, liquidityUsdc: liq.toString(), p0Bps: b.p0Bps, id };
  const tx = buildTx(s.wallet, { op: 'create', marketId: id, params }, `Create market · ${b.assetSymbol} ${b.targetPrice}`, c.body.priorityFeeMicroLamports as number | undefined);
  return { ...tx, marketId: id };
});

/* radar */
route('GET', '/radar/wallets', (c) => {
  const q = c.url.searchParams;
  const minScore = Number(q.get('minScore')) || 0;
  const cluster = q.get('cluster');
  const crowd = q.get('crowd') !== 'false';
  let nodes = nodesFor(state.wallets).filter((n) => n.score >= minScore && (!cluster || String(n.cluster) === cluster) && (crowd || n.smart));
  const ids = new Set(nodes.map((n) => n.id));
  const payload: GraphPayload = {
    nodes,
    edges: state.edges.filter((e) => ids.has(e.a) && ids.has(e.b)),
    asOf: new Date().toISOString(),
    modelVersion: MODEL_VERSION,
    clusters: CLUSTERS.map((cl) => ({ id: cl.id, name: cl.name, size: nodes.filter((n) => n.cluster === cl.id).length })),
    dataSource: DATA_SOURCE,
  };
  nodes = [];
  return payload;
});
route('GET', '/wallets/:addr', (c) => state.walletDetailFor(c.params[0]!));
route('GET', '/track-record/latest', () => trackRecord(Date.now(), state.cfg.trackBuilding));

/* account */
route('GET', '/me', (c) => {
  const s = needSession(c);
  const out: MeResp = { wallet: s.wallet, mode: s.mode, walletScore: state.meScore(s.wallet), settings: state.userSettings(s.wallet) };
  return out;
});
route('GET', '/me/positions', (c) => {
  const s = needSession(c);
  const tab = c.url.searchParams.get('tab');
  if (tab !== 'open' && tab !== 'redeem' && tab !== 'resolved') throw new ApiFail(400, 'bad_request', 'tab must be open|redeem|resolved');
  return state.positionRows(s.wallet, tab);
});
route('GET', '/me/activity', (c) => paged(state.activity.get(needSession(c).wallet) ?? [], c, 30));
route('PUT', '/me/settings', (c) => {
  const s = needSign(c);
  const set = state.setting(s.wallet);
  const lim = c.body.dailyLimitUsdc;
  set.dailyLimit = lim === null ? null : u64(lim, 'dailyLimitUsdc');
  set.sessionReminder = !!c.body.sessionReminder;
  state.log(s.wallet, { type: 'limit', summary: set.dailyLimit === null ? 'Removed the daily limit' : `Set the daily limit to ${Number(set.dailyLimit) / 1e6} USDC` });
  return state.userSettings(s.wallet);
});
route('POST', '/me/break', (c) => {
  const s = needSign(c);
  const days = Number(c.body.days);
  if (![1, 7, 30].includes(days)) throw new ApiFail(400, 'bad_request', 'days must be 1, 7 or 30');
  const set = state.setting(s.wallet);
  const until = Date.now() + days * DAY;
  set.breakUntil = Math.max(set.breakUntil ?? 0, until);
  state.log(s.wallet, { type: 'break', summary: `Started a ${days}-day break` });
  return state.userSettings(s.wallet);
});
route('POST', '/me/watch/:id', (c) => {
  const s = needSession(c);
  const set = state.watch.get(s.wallet) ?? new Set<string>();
  state.market(c.params[0]!);
  const on = !set.has(c.params[0]!);
  if (on) set.add(c.params[0]!);
  else set.delete(c.params[0]!);
  state.watch.set(s.wallet, set);
  return { watching: on };
});
route('POST', '/me/track/:wallet', (c) => {
  const s = needSession(c);
  const set = state.tracked.get(s.wallet) ?? new Set<string>();
  const on = !set.has(c.params[0]!);
  if (on) set.add(c.params[0]!);
  else set.delete(c.params[0]!);
  state.tracked.set(s.wallet, set);
  return { tracking: on };
});
route('POST', '/flags/dispute', (c) => {
  needSign(c);
  if (String(c.body.message ?? '').trim().length < 10) throw new ApiFail(400, 'bad_request', 'Please add a few more details');
  return { id: randomBytes(6).toString('hex') };
});
route('POST', '/faucet/usdc', (c) => {
  const s = needSign(c);
  const last = faucetAt.get(s.wallet) ?? 0;
  if (Date.now() - last < 15_000) throw new ApiFail(429, 'rate_limited', 'The faucet allows one request every 15 seconds');
  faucetAt.set(s.wallet, Date.now());
  state.balances.set(s.wallet, state.balance(s.wallet) + 1000n * USDC);
  return { txSig: fakeAddress(mulberry32(Date.now()), 88), amount: (1000n * USDC).toString() };
});
const faucetAt = new Map<string, number>();
route('GET', '/health', () => ({ ok: true, db: true, redis: true, rpc: true, indexerLagSlots: 0, keeper: { ok: true, ageSec: 4 }, demoMode: true }));

/* test controls */
route('POST', '/__mock/config', (c) => {
  Object.assign(state.cfg, c.body);
  if ('wsPush' in c.body) startTimers();
  return state.cfg;
});
route('POST', '/__mock/reset', () => {
  state.reset();
  pending.clear();
  faucetAt.clear();
  for (const cl of clients) cl.ws.close();
  return { ok: true };
});
/** Settle (outcome 'above' | 'below') or void (no outcome) a market, then push what the real indexer and keeper would. */
route('POST', '/__mock/settle', (c) => {
  const m = state.market(String(c.body.marketId));
  const outcome = c.body.outcome === 'above' || c.body.outcome === 'below' ? (c.body.outcome as Side) : null;
  state.settleMarket(m, outcome);
  emit(`market:${m.id}`, { ...marketDelta(m), status: m.status, outcome: m.outcome });
  emit('markets:summary', { markets: [state.summary(m)] });
  for (const [wallet, pos] of state.positions) {
    const holds = [...pos.entries()].some(([k, v]) => k.startsWith(`${m.id}|`) && v.shares > 0n);
    if (holds) emit('me', outcome ? { kind: 'settled', marketId: m.id, outcome } : { kind: 'voided', marketId: m.id }, (cl) => cl.session?.wallet === wallet);
  }
  return { ok: true, status: m.status, outcome: m.outcome };
});
route('POST', '/__mock/tick', () => {
  tick();
  return { ok: true };
});
route('POST', '/__mock/balance', (c) => {
  state.balances.set(String(c.body.wallet), BigInt(String(c.body.amount)));
  return { ok: true };
});
route('GET', '/__mock/state', () => ({ cfg: state.cfg, markets: state.markets.length, sessions: state.sessions.size, pending: pending.size }));

/* ------------------------------ server ------------------------------ */

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const cors: Record<string, string> = origin ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'access-control-allow-headers': (req.headers['access-control-request-headers'] as string | undefined) || 'content-type,authorization,solana-client', 'access-control-allow-methods': 'GET,POST,PUT,OPTIONS', vary: 'origin' } : {};
  for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url || '/', 'http://localhost');
  try {
    if (state.cfg.latencyMs) await sleep(state.cfg.latencyMs);
    if (url.pathname === '/rpc' && req.method === 'POST') {
      const body = (await readBody(req)) as { id?: unknown; method?: string; params?: unknown[] };
      if (state.cfg.rpc === 'slow') await sleep(400);
      try {
        json(res, 200, { jsonrpc: '2.0', id: body.id, result: rpcCall(String(body.method), body.params ?? []) });
      } catch (e) {
        json(res, 200, { jsonrpc: '2.0', id: body.id, error: { code: (e as { rpcCode?: number }).rpcCode ?? -32000, message: (e as Error).message } });
      }
      return;
    }
    const session = sessionFrom(req.headers.cookie);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const body = req.method === 'GET' ? {} : await readBody(req);
      const out = await r.h({ req, res, url, session, body, params: m.slice(1).map(decodeURIComponent) });
      json(res, 200, out);
      return;
    }
    json(res, 404, { error: { code: 'not_found', message: `No route for ${req.method} ${url.pathname}` } });
  } catch (e) {
    if (e instanceof ApiFail) json(res, e.status, { error: { code: e.code, message: e.message, details: e.details } });
    else {
      console.error(e);
      json(res, 500, { error: { code: 'internal', message: (e as Error).message } });
    }
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const client: Client = { ws, subs: new Set(), session: sessionFrom(req.headers.cookie) };
  clients.add(client);
  ws.on('message', (raw) => {
    let m: { op?: string; channels?: string[] };
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (m.op === 'ping') ws.send(JSON.stringify({ op: 'pong' }));
    else if (m.op === 'subscribe') {
      for (const ch of m.channels ?? []) {
        const snap = snapshotFor(client, ch);
        if (snap === null) {
          ws.send(JSON.stringify({ op: 'error', message: `Cannot subscribe to ${ch}` }));
          continue;
        }
        client.subs.add(ch);
        ws.send(frame(ch, 'snapshot', snap));
      }
    } else if (m.op === 'unsubscribe') for (const ch of m.channels ?? []) client.subs.delete(ch);
  });
  ws.on('close', () => clients.delete(client));
});

server.listen(PORT, () => {
  startTimers();
  console.log(`[mock-api] listening on http://localhost:${PORT} (HTTP, /ws, /rpc). Data source: ${DATA_SOURCE}`);
});

process.on('SIGTERM', () => process.exit(0));
