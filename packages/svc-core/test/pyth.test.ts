import { encodePriceUpdateV2, pythPushFeedAddress } from '@groundgraph/sdk';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { PYTH_FEEDS } from '../src/chain';
import {
  decodePriceUpdateV2,
  HermesAuthError,
  HermesClient,
  isReadingStale,
  OraclePriceService,
  PushFeedReader,
  pushFeedAddress,
  PYTH_RECEIVER_PROGRAM,
} from '../src/pyth';

const SOL = PYTH_FEEDS['SOL']!.feedIdHex;
const ETH = PYTH_FEEDS['ETH']!.feedIdHex;

function account(feedIdHex: string, o: { price?: bigint; conf?: bigint; expo?: number; publish?: bigint; full?: boolean } = {}): Buffer {
  return encodePriceUpdateV2({
    writeAuthority: Keypair.generate().publicKey,
    verification: o.full === false ? { level: 'partial', numSignatures: 5 } : { level: 'full' },
    feedId: Uint8Array.from(Buffer.from(feedIdHex, 'hex')),
    price: o.price ?? 21_393_000_000n,
    conf: o.conf ?? 8_000_000n,
    exponent: o.expo ?? -8,
    publishTime: o.publish ?? 1_800_000_000n,
    prevPublishTime: 1_799_999_999n,
    emaPrice: 21_000_000_000n,
    emaConf: 9_000_000n,
    postedSlot: 123n,
  });
}

describe('decodePriceUpdateV2 agrees with the SDK encoder', () => {
  it('decodes a fully verified update', () => {
    const d = decodePriceUpdateV2(account(SOL));
    expect(d).toMatchObject({ feedIdHex: SOL, rawPrice: 21_393_000_000n, rawConf: 8_000_000n, expo: -8, publishTs: 1_800_000_000, prevPublishTs: 1_799_999_999, verification: 'full', postedSlot: 123n });
    expect(d.price).toBeCloseTo(213.93, 6);
    expect(d.conf).toBeCloseTo(0.08, 6);
  });

  it('flags a partially verified update (it must never be used to settle)', () => {
    expect(decodePriceUpdateV2(account(SOL, { full: false })).verification).toBe('partial');
  });

  it('handles negative exponents of different sizes and large prices', () => {
    const d = decodePriceUpdateV2(account(ETH, { price: 8_335_285_000_000n, expo: -8 }));
    expect(d.price).toBeCloseTo(83352.85, 4);
    const bonk = decodePriceUpdateV2(account(PYTH_FEEDS['BONK']!.feedIdHex, { price: 2_345_678n, expo: -10 }));
    expect(bonk.price).toBeCloseTo(0.0002345678, 12);
  });
});

describe('push feed addresses', () => {
  it('match the SDK derivation for every allow-listed feed', () => {
    for (const f of Object.values(PYTH_FEEDS)) {
      expect(pushFeedAddress(f.feedIdHex).toBase58()).toBe(pythPushFeedAddress(f.feedIdHex).toBase58());
      expect(pushFeedAddress(`0x${f.feedIdHex}`).toBase58()).toBe(pushFeedAddress(f.feedIdHex).toBase58());
    }
  });
});

describe('PushFeedReader', () => {
  const conn = (infos: ({ data: Buffer; owner: PublicKey } | null)[]) => ({ getMultipleAccountsInfo: async () => infos }) as unknown as Pick<Connection, 'getMultipleAccountsInfo'>;

  it('returns readings with the account address that settle_close needs', async () => {
    const r = new PushFeedReader(conn([{ data: account(SOL), owner: PYTH_RECEIVER_PROGRAM }, { data: account(ETH, { price: 300_000_000_000n }), owner: PYTH_RECEIVER_PROGRAM }]));
    const got = await r.latest([SOL, ETH]);
    expect(got.get(SOL)).toMatchObject({ source: 'push-feed', account: pushFeedAddress(SOL).toBase58(), publishTs: 1_800_000_000 });
    expect(got.get(ETH)!.price).toBe(3000);
  });

  it('skips missing accounts, foreign owners, garbage and accounts holding another feed', async () => {
    const r = new PushFeedReader(
      conn([null, { data: account(SOL), owner: Keypair.generate().publicKey }, { data: Buffer.from('garbage'), owner: PYTH_RECEIVER_PROGRAM }, { data: account(SOL), owner: PYTH_RECEIVER_PROGRAM }]),
    );
    const got = await r.latest([SOL, SOL, SOL, ETH]);
    expect(got.size).toBe(0);
  });
});

describe('HermesClient', () => {
  const body = {
    binary: { encoding: 'base64', data: ['QUJD'] },
    parsed: [{ id: SOL, price: { price: '21393000000', conf: '8000000', expo: -8, publish_time: 1_800_000_001 } }],
  };
  function fetchStub(status = 200, seen: { url?: string; headers?: Record<string, string> } = {}) {
    return (async (url: string, init: RequestInit) => {
      seen.url = String(url);
      seen.headers = init.headers as Record<string, string>;
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
  }

  it('sends the API key as a Bearer token and parses latest prices', async () => {
    const seen: { url?: string; headers?: Record<string, string> } = {};
    const c = new HermesClient({ baseUrl: 'https://hermes.example/', apiKey: 'k3y', fetchImpl: fetchStub(200, seen) });
    const got = await c.latest([`0x${SOL}`]);
    expect(seen.headers!['authorization']).toBe('Bearer k3y');
    expect(seen.url).toContain('/v2/updates/price/latest');
    expect(seen.url).toContain(`ids%5B%5D=${SOL}`);
    expect(got.get(SOL)).toMatchObject({ source: 'hermes', publishTs: 1_800_000_001, rawPrice: 21_393_000_000n });
  });

  it('atTime returns the update payloads to post on chain', async () => {
    const seen: { url?: string } = {};
    const c = new HermesClient({ baseUrl: 'https://hermes.example', apiKey: 'k', fetchImpl: fetchStub(200, seen) });
    const r = await c.atTime(1_800_000_000, [SOL]);
    expect(seen.url).toContain('/v2/updates/price/1800000000');
    expect(r.updates).toEqual(['QUJD']);
    expect(r.readings.get(SOL)!.publishTs).toBe(1_800_000_001);
  });

  it('turns 401 and 403 into a descriptive auth error', async () => {
    for (const status of [401, 403]) {
      const c = new HermesClient({ baseUrl: 'https://hermes.example', fetchImpl: fetchStub(status) });
      await expect(c.latest([SOL])).rejects.toBeInstanceOf(HermesAuthError);
    }
    await expect(new HermesClient({ baseUrl: 'https://hermes.example', fetchImpl: fetchStub(401) }).latest([SOL])).rejects.toThrow(/PYTH_API_KEY/);
  });

  it('reports other HTTP failures', async () => {
    await expect(new HermesClient({ baseUrl: 'https://hermes.example', fetchImpl: fetchStub(503) }).latest([SOL])).rejects.toThrow(/HTTP 503/);
  });
});

describe('OraclePriceService', () => {
  const pushWith = (ids: string[]) => ({ latest: async () => new Map(ids.map((i) => [i, { feedIdHex: i, price: 1, conf: 0, expo: -8, rawPrice: 1n, rawConf: 0n, publishTs: 1, source: 'push-feed' as const }])) }) as unknown as PushFeedReader;

  it('uses the push feeds when there is no Hermes client', async () => {
    const s = new OraclePriceService(pushWith([SOL]));
    expect(s.primary).toBe('push-feed');
    expect((await s.latest([SOL])).get(SOL)!.source).toBe('push-feed');
  });

  it('falls back to the push feeds when Hermes fails, and says so', async () => {
    const failing = { latest: async () => { throw new HermesAuthError(401); } } as unknown as HermesClient;
    let note: unknown;
    const s = new OraclePriceService(pushWith([SOL]), failing, (e) => (note = e));
    expect(s.primary).toBe('hermes');
    expect((await s.latest([SOL])).size).toBe(1);
    expect(note).toBeInstanceOf(HermesAuthError);
  });
});

describe('isReadingStale', () => {
  it('compares against the clock', () => {
    expect(isReadingStale(100, 150_000, 60)).toBe(false);
    expect(isReadingStale(100, 170_000, 60)).toBe(true);
    expect(isReadingStale(null, 0)).toBe(true);
  });
});
