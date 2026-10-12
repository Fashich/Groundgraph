import { HermesClient } from './pyth';

export interface VolSnapshot {
  feedId: string;
  vol: number; // annualized
  source: string;
  nCloses: number;
  asOf: number; // unix ms
}

const MIN_VOL = 0.05;
const MAX_VOL = 6;

/** Annualized realized volatility from consecutive daily closes (stdev of log returns * sqrt(365)). */
export function realizedVolAnnual(closes: number[]): number {
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1]!;
    const b = closes[i]!;
    if (a > 0 && b > 0) rets.push(Math.log(b / a));
  }
  if (rets.length < 5) throw new Error('not enough daily closes to estimate volatility');
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.min(MAX_VOL, Math.max(MIN_VOL, Math.sqrt(variance) * Math.sqrt(365)));
}

type FetchLike = typeof fetch;
export interface CloseSeries {
  closes: number[];
  source: string;
}

const COINGECKO_IDS: Record<string, string> = {
  SOL: 'solana',
  BTC: 'bitcoin',
  ETH: 'ethereum',
  JUP: 'jupiter-exchange-solana',
  WIF: 'dogwifcoin',
  BONK: 'bonk',
};
const KRAKEN_PAIRS: Record<string, string> = { BTC: 'XBTUSD' };

async function getJson<T>(f: FetchLike, url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await f(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}`);
  return (await res.json()) as T;
}

const DAY = 86_400;

/** Daily closes (oldest first, excluding today's incomplete candle) for the last ~31 days. */
export const closeProviders: Record<string, (asset: string, f: FetchLike, nowSec: number) => Promise<number[]>> = {
  coinbase: async (asset, f, nowSec) => {
    const rows = await getJson<number[][]>(f, `https://api.exchange.coinbase.com/products/${asset}-USD/candles?granularity=86400`);
    const today = nowSec - (nowSec % DAY);
    return rows
      .filter((r) => r[0]! < today)
      .sort((a, b) => a[0]! - b[0]!)
      .slice(-31)
      .map((r) => r[4]!);
  },
  kraken: async (asset, f, nowSec) => {
    const pair = KRAKEN_PAIRS[asset] ?? `${asset}USD`;
    const j = await getJson<{ error: string[]; result: Record<string, unknown> }>(f, `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=1440`);
    const key = Object.keys(j.result).find((k) => k !== 'last');
    if (!key) throw new Error('kraken: no series');
    const rows = j.result[key] as [number, string, string, string, string][];
    const today = nowSec - (nowSec % DAY);
    return rows.filter((r) => r[0] < today).slice(-31).map((r) => Number(r[4]));
  },
  binance: async (asset, f, nowSec) => {
    const rows = await getJson<(string | number)[][]>(f, `https://data-api.binance.vision/api/v3/klines?symbol=${asset}USDT&interval=1d&limit=33`);
    const today = (nowSec - (nowSec % DAY)) * 1000;
    return rows.filter((r) => Number(r[0]) < today).slice(-31).map((r) => Number(r[4]));
  },
  coingecko: async (asset, f, nowSec) => {
    const id = COINGECKO_IDS[asset];
    if (!id) throw new Error('coingecko: unknown asset');
    const j = await getJson<{ prices: [number, number][] }>(f, `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=32&interval=daily`);
    const today = (nowSec - (nowSec % DAY)) * 1000;
    return j.prices.filter((p) => p[0] < today).slice(-31).map((p) => p[1]);
  },
};

export interface VolOptions {
  fetchImpl?: FetchLike;
  nowSec?: number;
  /** when set, Pyth Benchmarks (daily 00:00 UTC prices) is tried first */
  benchmarks?: HermesClient;
}

/** Pyth Benchmarks daily prices (needs an API key). One request per day, 31 days. */
async function benchmarkCloses(feedIdHex: string, client: HermesClient, nowSec: number): Promise<number[]> {
  const today = nowSec - (nowSec % DAY);
  const days = Array.from({ length: 31 }, (_, i) => today - (31 - i) * DAY);
  const out: number[] = [];
  for (const ts of days) {
    const { readings } = await client.atTime(ts, [feedIdHex]);
    const r = readings.get(feedIdHex);
    if (r) out.push(r.price);
  }
  return out;
}

/** Fetch 30 daily closes for `asset` from the first provider that answers (Pyth Benchmarks, Coinbase, Kraken, Binance, CoinGecko). */
export async function fetchDailyCloses(asset: string, feedIdHex: string, opts: VolOptions = {}): Promise<CloseSeries> {
  const f = opts.fetchImpl ?? fetch;
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const errors: string[] = [];
  const attempts: [string, () => Promise<number[]>][] = [];
  if (opts.benchmarks) attempts.push(['pyth-benchmarks', () => benchmarkCloses(feedIdHex, opts.benchmarks!, nowSec)]);
  for (const [name, fn] of Object.entries(closeProviders)) attempts.push([name, () => fn(asset.toUpperCase(), f, nowSec)]);
  for (const [name, run] of attempts) {
    try {
      const closes = (await run()).filter((c) => Number.isFinite(c) && c > 0);
      if (closes.length >= 20) return { closes, source: name };
      errors.push(`${name}: only ${closes.length} closes`);
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`);
    }
  }
  throw new Error(`no volatility source available (${errors.join('; ')})`);
}

export async function computeVol(asset: string, feedIdHex: string, opts: VolOptions = {}): Promise<VolSnapshot> {
  const { closes, source } = await fetchDailyCloses(asset, feedIdHex, opts);
  return { feedId: feedIdHex, vol: realizedVolAnnual(closes), source, nCloses: closes.length, asOf: Date.now() };
}
