import { PublicKey, type Connection } from '@solana/web3.js';
import { rawToNumber } from './units';

/** Pyth push oracle program: maintains sponsored price feed accounts (shard 0) that anyone can read for free. */
export const PYTH_PUSH_ORACLE_PROGRAM_ID = new PublicKey('pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT');
export const PYTH_RECEIVER_PROGRAM = new PublicKey('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ');

export interface PriceReading {
  feedIdHex: string;
  price: number;
  conf: number;
  expo: number;
  rawPrice: bigint;
  rawConf: bigint;
  /** unix seconds of the Pyth publish time */
  publishTs: number;
  source: 'hermes' | 'push-feed';
  /** price update account (push-feed source only), usable directly as `price_update` in settle_close */
  account?: string;
  verification?: 'full' | 'partial';
}

/** PDA of the sponsored push-oracle price feed account for a feed id. */
export function pushFeedAddress(feedIdHex: string, shardId = 0): PublicKey {
  const shard = Buffer.alloc(2);
  shard.writeUInt16LE(shardId);
  return PublicKey.findProgramAddressSync([shard, Buffer.from(feedIdHex.replace(/^0x/, ''), 'hex')], PYTH_PUSH_ORACLE_PROGRAM_ID)[0];
}

/**
 * Decode an Anchor `PriceUpdateV2` account (Pyth receiver): disc(8) write_authority(32) verification_level(1 or 2)
 * price_message{feed_id(32) price(i64) conf(u64) expo(i32) publish_time(i64) prev_publish_time(i64) ema_price(i64) ema_conf(u64)} posted_slot(u64)
 */
export function decodePriceUpdateV2(data: Uint8Array): PriceReading & { verification: 'full' | 'partial'; postedSlot: bigint; prevPublishTs: number } {
  const b = Buffer.from(data);
  let o = 8 + 32;
  const tag = b[o++]!;
  let verification: 'full' | 'partial' = 'full';
  if (tag === 0) {
    verification = 'partial';
    o += 1; // num_signatures
  }
  const feedIdHex = b.subarray(o, o + 32).toString('hex');
  o += 32;
  const rawPrice = b.readBigInt64LE(o); o += 8;
  const rawConf = b.readBigUInt64LE(o); o += 8;
  const expo = b.readInt32LE(o); o += 4;
  const publishTs = Number(b.readBigInt64LE(o)); o += 8;
  const prevPublishTs = Number(b.readBigInt64LE(o)); o += 8;
  o += 16; // ema price + conf
  const postedSlot = b.readBigUInt64LE(o);
  return {
    feedIdHex,
    price: rawToNumber(rawPrice, expo),
    conf: rawToNumber(rawConf, expo),
    expo,
    rawPrice,
    rawConf,
    publishTs,
    prevPublishTs,
    postedSlot,
    source: 'push-feed',
    verification,
  };
}

/** Keyless oracle source: reads the sponsored push feed accounts over RPC (one getMultipleAccounts call). */
export class PushFeedReader {
  constructor(
    private connection: Pick<Connection, 'getMultipleAccountsInfo'>,
    private shardId = 0,
  ) {}

  async latest(feedIds: string[]): Promise<Map<string, PriceReading>> {
    const keys = feedIds.map((f) => pushFeedAddress(f, this.shardId));
    const infos = await this.connection.getMultipleAccountsInfo(keys, 'confirmed');
    const out = new Map<string, PriceReading>();
    infos.forEach((info, i) => {
      if (!info || !info.owner.equals(PYTH_RECEIVER_PROGRAM)) return;
      try {
        const d = decodePriceUpdateV2(info.data);
        if (d.feedIdHex !== feedIds[i]!.replace(/^0x/, '').toLowerCase()) return;
        out.set(d.feedIdHex, { ...d, account: keys[i]!.toBase58() });
      } catch {
        /* malformed account: skip */
      }
    });
    return out;
  }
}

export class HermesAuthError extends Error {
  constructor(
    public status: number,
    /** response body, kept for the operator: a valid key can still be refused a feed it has no grant for */
    public detail = '',
  ) {
    super(
      `Hermes rejected the request (HTTP ${status}). Since the Pyth Core upgrade Hermes needs PYTH_API_KEY; the push-feed source works without a key.` +
        (detail ? ` Response: ${detail.slice(0, 200)}` : ''),
    );
  }

  /** Feed id named by a "Not entitled: feed <id>" answer (the key is valid but has no grant for that feed), lower case without 0x. */
  get deniedFeedId(): string | undefined {
    return /not entitled: feed (?:0x)?([0-9a-f]{64})/i.exec(this.detail)?.[1]?.toLowerCase();
  }
}

interface HermesParsed {
  id: string;
  price: { price: string; conf: string; expo: number; publish_time: number };
}
interface HermesResponse {
  binary?: { encoding: string; data: string[] };
  parsed?: HermesParsed[];
}

function toReading(p: HermesParsed): PriceReading {
  const rawPrice = BigInt(p.price.price);
  const rawConf = BigInt(p.price.conf);
  return {
    feedIdHex: p.id.replace(/^0x/, '').toLowerCase(),
    price: rawToNumber(rawPrice, p.price.expo),
    conf: rawToNumber(rawConf, p.price.expo),
    expo: p.price.expo,
    rawPrice,
    rawConf,
    publishTs: p.price.publish_time,
    source: 'hermes',
  };
}

export interface HermesOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Hermes v2 REST client (also used for the Benchmarks `/v1/updates/price/{ts}` endpoint, same response shape). */
export class HermesClient {
  private base: string;
  private f: typeof fetch;
  constructor(private opts: HermesOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.f = opts.fetchImpl ?? fetch;
  }

  private async get(path: string, ids: string[], extra: Record<string, string> = {}): Promise<HermesResponse> {
    const qs = new URLSearchParams();
    for (const id of ids) qs.append('ids[]', id.replace(/^0x/, ''));
    for (const [k, v] of Object.entries(extra)) qs.set(k, v);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    const res = await this.f(`${this.base}${path}?${qs.toString()}`, { headers, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8000) });
    if (res.status === 401 || res.status === 403) {
      const detail = await Promise.resolve()
        .then(() => res.text())
        .catch(() => '');
      throw new HermesAuthError(res.status, detail);
    }
    if (!res.ok) throw new Error(`Hermes ${path} failed: HTTP ${res.status}`);
    return (await res.json()) as HermesResponse;
  }

  async latest(ids: string[]): Promise<Map<string, PriceReading>> {
    const j = await this.get('/v2/updates/price/latest', ids, { parsed: 'true', encoding: 'base64' });
    return new Map((j.parsed ?? []).map((p) => [p.id.replace(/^0x/, '').toLowerCase(), toReading(p)]));
  }

  /** First update with publish_time >= `publishTime`, plus the base64 binary payload to post on chain. */
  async atTime(publishTime: number, ids: string[]): Promise<{ readings: Map<string, PriceReading>; updates: string[] }> {
    const j = await this.get(`/v2/updates/price/${publishTime}`, ids, { parsed: 'true', encoding: 'base64' });
    return {
      readings: new Map((j.parsed ?? []).map((p) => [p.id.replace(/^0x/, '').toLowerCase(), toReading(p)])),
      updates: j.binary?.data ?? [],
    };
  }
}

/** Latest-price source: Hermes when an API key is configured, otherwise the on-chain push feeds; Hermes failures fall back to push. */
export class OraclePriceService {
  /** feeds the Hermes key has no grant for: asked from the on-chain push feeds instead, without retrying Hermes */
  private denied = new Set<string>();

  constructor(
    private push: PushFeedReader,
    private hermes?: HermesClient,
    private onFallback?: (err: unknown) => void,
    private onFeedDenied?: (feedIdHex: string) => void,
  ) {}

  get primary(): 'hermes' | 'push-feed' {
    return this.hermes ? 'hermes' : 'push-feed';
  }

  async latest(feedIds: string[]): Promise<Map<string, PriceReading>> {
    const norm = (id: string) => id.replace(/^0x/, '').toLowerCase();
    const out = new Map<string, PriceReading>();
    if (this.hermes) {
      // A key may be granted only some feeds. When Hermes names a feed it refuses, remember it and ask again for the rest,
      // at most once per refused feed; any other failure falls back to the push feeds for everything.
      for (let attempt = 0; attempt <= feedIds.length; attempt++) {
        const ids = feedIds.filter((id) => !this.denied.has(norm(id)));
        if (ids.length === 0) break;
        try {
          for (const [k, v] of await this.hermes.latest(ids)) out.set(k, v);
          break;
        } catch (err) {
          const bad = err instanceof HermesAuthError ? err.deniedFeedId : undefined;
          if (bad && ids.some((id) => norm(id) === bad)) {
            this.denied.add(bad);
            this.onFeedDenied?.(bad);
            continue;
          }
          this.onFallback?.(err);
          break;
        }
      }
    }
    const missing = feedIds.filter((id) => !out.has(norm(id)));
    if (missing.length > 0) for (const [k, v] of await this.push.latest(missing)) if (!out.has(k)) out.set(k, v);
    return out;
  }
}

/** True when a reading's publish time is older than `maxAgeSec` relative to `nowMs`. */
export function isReadingStale(publishTs: number | null | undefined, nowMs: number, maxAgeSec = 60): boolean {
  if (publishTs === null || publishTs === undefined) return true;
  return nowMs / 1000 - publishTs > maxAgeSec;
}

/** Shape stored in Redis under `oracle:{feedIdHex}`. */
export interface OracleSnapshot {
  feedId: string;
  symbol: string;
  price: number;
  conf: number;
  expo: number;
  publishTs: number; // unix seconds
  fetchedAt: number; // unix ms
  source: 'hermes' | 'push-feed';
  account?: string;
  stale: boolean;
}
