import type {
  ActivityRow,
  ApiError,
  ApiErrorCode,
  BuildBuySellReq,
  BuildCreateReq,
  BuildMergeReq,
  BuildRedeemReq,
  FairValueInfo,
  GraphPayload,
  MarketDetail,
  MarketSummary,
  MarketWalletRow,
  MeResp,
  NonceResp,
  Paged,
  PositionRow,
  Quote,
  SessionResp,
  Side,
  TradeDir,
  TradeRow,
  TrackRecord,
  UnsignedTx,
  UserSettings,
  VerifyReq,
  WalletDetail,
} from '@groundgraph/sdk/api-types';
import { env } from './env';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isApiError(e: unknown, code?: string): e is ApiRequestError {
  return e instanceof ApiRequestError && (code === undefined || e.code === code);
}

type Query = Record<string, string | number | boolean | null | undefined>;

export function qs(params?: Query): string {
  if (!params) return '';
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

async function request<T>(method: string, path: string, opts: { body?: unknown; query?: Query; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${env.apiUrl}${path}${qs(opts.query)}`, {
      method,
      credentials: 'include',
      headers: opts.body !== undefined ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiRequestError(0, 'network', 'Could not reach the Groundgraph API. Check your connection and try again.');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown = undefined;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
  }
  if (!res.ok) {
    const err = (json as ApiError | undefined)?.error;
    throw new ApiRequestError(res.status, err?.code ?? (res.status === 401 ? 'unauthorized' : 'internal'), err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return json as T;
}

export interface AssetRow {
  symbol: string;
  feedId: string;
  price: number | null;
  ageSec: number | null;
}

export interface MarketsQuery {
  cat?: string;
  lean?: string;
  ends?: string;
  sort?: string;
  q?: string;
  watch?: boolean;
  status?: string;
  limit?: number;
  cursor?: string | null;
}

export const api = {
  /* auth */
  nonce: (wallet: string) => request<NonceResp>('POST', '/auth/nonce', { body: { wallet } }),
  verify: (body: VerifyReq) => request<SessionResp>('POST', '/auth/verify', { body }),
  view: (address: string) => request<SessionResp>('POST', '/auth/view', { body: { address } }),
  logout: () => request<{ ok: true }>('POST', '/auth/logout'),
  session: async (): Promise<SessionResp | null> => {
    try {
      return await request<SessionResp>('GET', '/auth/session');
    } catch (e) {
      if (isApiError(e) && e.status === 401) return null;
      throw e;
    }
  },
  acceptTos: (tosVersion: string) => request<SessionResp>('POST', '/auth/tos', { body: { tosVersion } }),

  /* ops */
  health: () => request<{ ok: boolean; demoMode?: boolean }>('GET', '/health'),

  /* markets */
  markets: (q: MarketsQuery = {}) => request<Paged<MarketSummary>>('GET', '/markets', { query: { ...q } }),
  market: (id: string, tf: string) => request<MarketDetail>('GET', `/markets/${encodeURIComponent(id)}`, { query: { tf } }),
  marketWallets: (id: string) => request<MarketWalletRow[]>('GET', `/markets/${encodeURIComponent(id)}/wallets`),
  marketTrades: (id: string, cursor?: string | null, limit = 30) => request<Paged<TradeRow>>('GET', `/markets/${encodeURIComponent(id)}/trades`, { query: { cursor, limit } }),
  quote: (id: string, p: { side: Side; dir: TradeDir; amount: string; slippageBps: number }, signal?: AbortSignal) =>
    request<Quote>('GET', `/markets/${encodeURIComponent(id)}/quote`, { query: { side: p.side, dir: p.dir, amount: p.amount, slippageBps: p.slippageBps }, signal }),
  fairValue: (p: { asset: string; target: number; settleTs: string; kind: string; direction?: string }) =>
    request<FairValueInfo>('GET', '/fair-value', { query: { asset: p.asset, target: p.target, settleTs: p.settleTs, kind: p.kind, direction: p.direction } }),
  assets: () => request<AssetRow[]>('GET', '/assets'),

  /* transactions */
  txBuy: (b: BuildBuySellReq) => request<UnsignedTx>('POST', '/tx/buy', { body: b }),
  txSell: (b: BuildBuySellReq) => request<UnsignedTx>('POST', '/tx/sell', { body: b }),
  txMerge: (b: BuildMergeReq) => request<UnsignedTx>('POST', '/tx/merge', { body: b }),
  txRedeem: (b: BuildRedeemReq) => request<UnsignedTx>('POST', '/tx/redeem', { body: b }),
  txCreate: (b: BuildCreateReq) => request<UnsignedTx>('POST', '/tx/create', { body: b }),

  /* radar */
  radar: (q: { minScore?: number; cluster?: string | number; crowd?: boolean } = {}) => request<GraphPayload>('GET', '/radar/wallets', { query: { minScore: q.minScore, cluster: q.cluster === 'all' ? undefined : q.cluster, crowd: q.crowd } }),
  wallet: (addr: string) => request<WalletDetail>('GET', `/wallets/${encodeURIComponent(addr)}`),
  trackRecord: () => request<TrackRecord>('GET', '/track-record/latest'),

  /* account */
  me: () => request<MeResp>('GET', '/me'),
  positions: (tab: 'open' | 'redeem' | 'resolved') => request<PositionRow[]>('GET', '/me/positions', { query: { tab } }),
  activity: (cursor?: string | null) => request<Paged<ActivityRow>>('GET', '/me/activity', { query: { cursor } }),
  putSettings: (b: { dailyLimitUsdc: string | null; sessionReminder: boolean }) => request<UserSettings>('PUT', '/me/settings', { body: b }),
  startBreak: (days: 1 | 7 | 30) => request<UserSettings>('POST', '/me/break', { body: { days } }),
  watch: (marketId: string) => request<{ watching: boolean }>('POST', `/me/watch/${encodeURIComponent(marketId)}`),
  track: (wallet: string) => request<{ tracking: boolean }>('POST', `/me/track/${encodeURIComponent(wallet)}`),
  dispute: (message: string) => request<{ id: string }>('POST', '/flags/dispute', { body: { message } }),

  /* devnet */
  faucet: (wallet: string) => request<{ txSig: string; amount: string }>('POST', '/faucet/usdc', { body: { wallet } }),
};
