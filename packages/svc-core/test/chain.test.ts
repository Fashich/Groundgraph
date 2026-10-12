import { encodeMarket, encodeEventLogs, type GgEvent } from '@groundgraph/sdk';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  assetByFeedId,
  assetBySymbol,
  categoryFor,
  decodeMarket,
  enumName,
  field,
  listAssetFeeds,
  normalizeConfig,
  normalizeEvent,
  normalizeMarket,
  parseEventsFromLogs,
  pda,
  PROGRAM_ID,
  PYTH_FEEDS,
  toBig,
  toHex,
  toPk,
} from '../src/chain';

const pk = () => Keypair.generate().publicKey;

describe('value readers', () => {
  it('field() accepts camelCase and snake_case', () => {
    expect(field({ settle_ts: 5 }, 'settleTs')).toBe(5);
    expect(field({ settleTs: 6 }, 'settle_ts')).toBe(6);
    expect(field({ a: 1 }, 'b', 'a')).toBe(1);
    expect(field(null, 'a')).toBeUndefined();
  });
  it('toBig converts every numeric representation', () => {
    expect(toBig(5n)).toBe(5n);
    expect(toBig(7.9)).toBe(7n);
    expect(toBig('123')).toBe(123n);
    expect(toBig('')).toBe(0n);
    expect(toBig({ toString: () => '99' })).toBe(99n);
  });
  it('toPk / toHex / enumName', () => {
    const k = pk();
    expect(toPk(k)).toBe(k.toBase58());
    expect(() => toPk(5)).toThrow(TypeError);
    expect(toHex(Uint8Array.from([1, 255]))).toBe('01ff');
    expect(toHex('0xABcd')).toBe('abcd');
    expect(enumName('Close', ['close', 'touch'])).toBe('close');
    expect(enumName({ touch: {} }, ['close', 'touch'])).toBe('touch');
    expect(enumName(1, ['close', 'touch'])).toBe('touch');
  });
});

describe('normalizeMarket against the real SDK decoder', () => {
  const sol = assetBySymbol('SOL')!;
  const account = {
    creator: pk(), nonce: 7, collateralMint: pk(), vault: pk(), aboveMint: pk(), belowMint: pk(), lpMint: pk(),
    kind: 'close' as const, direction: 'none' as const, feedId: Uint8Array.from(Buffer.from(sol.feedIdHex, 'hex')),
    targetPrice: 25_000_000_000n, targetExpo: -8, openTs: 1_800_000_000n, tradingEndTs: 1_800_080_000n, settleTs: 1_800_086_400n,
    baseFeeBps: 100, dynamicFee: true, completeSets: 1_000_000_000n, reserveAbove: 3_000_000_000n, reserveBelow: 1_000_000_000n, feePool: 12_345n,
    emaImpactBps: 11, emaTs: 1_800_000_100n, status: 'settled' as const, outcome: 'above' as const, settlePrice: 25_500_000_000n, settleExpo: -8,
    settlePublishTs: 1_800_086_410n, lpClaimRemaining: 77n, lpSupplyRemaining: 88n, bump: 254,
  };

  it('maps every field', () => {
    const id = pda.market(account.creator, 7n).toBase58();
    const m = normalizeMarket(decodeMarket(encodeMarket(account as never)), id);
    expect(m).toMatchObject({
      id, creator: account.creator.toBase58(), kind: 'close', direction: null, feedIdHex: sol.feedIdHex, targetPrice: 25_000_000_000n, targetExpo: -8,
      settleTs: 1_800_086_400, tradingEndTs: 1_800_080_000, baseFeeBps: 100, dynamicFee: true, completeSets: 1_000_000_000n, reserveAbove: 3_000_000_000n,
      reserveBelow: 1_000_000_000n, feePool: 12_345n, emaImpactBps: 11, status: 'settled', outcome: 'above', settlePrice: 25_500_000_000n,
      settlePublishTs: 1_800_086_410, lpClaimRemaining: 77n, lpSupplyRemaining: 88n,
    });
    expect(m.nonce).toBe(7n);
  });

  it('an open market has no outcome', () => {
    const m = normalizeMarket(decodeMarket(encodeMarket({ ...account, status: 'open', outcome: 'none' } as never)), 'x');
    expect(m).toMatchObject({ status: 'open', outcome: null });
  });
});

describe('normalizeEvent against the SDK event codec', () => {
  const market = pk();
  const wallet = pk();
  const roundTrip = (e: GgEvent) => {
    const events = parseEventsFromLogs(encodeEventLogs([e]));
    expect(events).toHaveLength(1);
    return normalizeEvent(events[0] as never);
  };

  it('Trade', () => {
    const n = roundTrip({ name: 'Trade', data: { market, wallet, side: 'below', isBuy: false, usdc: 5n, shares: 9n, feeUsdc: 1n, feeBps: 100, priceAfterBps: 4321, reserveAbove: 10n, reserveBelow: 20n, ts: 1_800_000_000n } } as GgEvent);
    expect(n).toEqual({ name: 'Trade', market: market.toBase58(), wallet: wallet.toBase58(), side: 'below', isBuy: false, usdc: 5n, shares: 9n, feeUsdc: 1n, feeBps: 100, priceAfterBps: 4321, reserveAbove: 10n, reserveBelow: 20n, ts: 1_800_000_000 });
  });

  it('Settled, Voided, Redeemed, Merged, LiquidityChanged', () => {
    expect(roundTrip({ name: 'Settled', data: { market, outcome: 'below', price: 123n, expo: -8, publishTs: 9n, lpClaim: 4n } } as GgEvent)).toEqual({ name: 'Settled', market: market.toBase58(), outcome: 'below', price: 123n, expo: -8, publishTs: 9, lpClaim: 4n });
    expect(roundTrip({ name: 'Voided', data: { market, lpClaim: 4n } } as GgEvent)).toEqual({ name: 'Voided', market: market.toBase58(), lpClaim: 4n });
    expect(roundTrip({ name: 'Redeemed', data: { market, wallet, side: 'above', shares: 3n, usdc: 3n } } as GgEvent)).toMatchObject({ name: 'Redeemed', side: 'above', shares: 3n });
    expect(roundTrip({ name: 'Merged', data: { market, wallet, amount: 8n } } as GgEvent)).toMatchObject({ name: 'Merged', amount: 8n });
    expect(roundTrip({ name: 'LiquidityChanged', data: { market, wallet, lpAmount: 5n, usdc: 6n, isAdd: false } } as GgEvent)).toMatchObject({ name: 'LiquidityChanged', isAdd: false, lpAmount: 5n });
  });

  it('MarketCreated', () => {
    const n = roundTrip({
      name: 'MarketCreated',
      data: { market, creator: wallet, feedId: Uint8Array.from(Buffer.from(PYTH_FEEDS['ETH']!.feedIdHex, 'hex')), targetPrice: 3_000_00000000n, targetExpo: -8, kind: 'close', settleTs: 5n, tradingEndTs: 4n, baseFeeBps: 50, dynamicFee: true, liquidity: 100n, p0Bps: 2100, aboveMint: pk(), belowMint: pk(), lpMint: pk(), vault: pk() },
    } as GgEvent);
    expect(n).toMatchObject({ name: 'MarketCreated', feedIdHex: PYTH_FEEDS['ETH']!.feedIdHex, kind: 'close', dynamicFee: true, p0Bps: 2100, settleTs: 5, tradingEndTs: 4 });
  });

  it('events the services do not track normalize to null', () => {
    const e = parseEventsFromLogs(encodeEventLogs([{ name: 'FeedUpdated', data: { feedId: new Uint8Array(32), expo: -8, enabled: true } }]));
    expect(normalizeEvent(e[0] as never)).toBeNull();
  });

  it('only decodes events emitted by the program id given', () => {
    const logs = encodeEventLogs([{ name: 'Voided', data: { market, lpClaim: 1n } } as GgEvent]);
    expect(parseEventsFromLogs(logs, PROGRAM_ID)).toHaveLength(1);
    expect(parseEventsFromLogs(logs, new PublicKey('11111111111111111111111111111111'))).toHaveLength(0);
  });
});

describe('normalizeConfig', () => {
  it('fills defaults for fields the SDK build may not expose', () => {
    const c = normalizeConfig({ admin: pk(), usdcMint: pk(), maxFeeBps: 0, minLiquidity: 5n, paused: false });
    expect(c).toMatchObject({ maxFeeBps: 300, maxStalenessSecs: 60, maxConfBps: 50, tradingCloseSecs: 3600, paused: false, minLiquidity: 5n });
  });
});

describe('asset helpers', () => {
  it('maps feed ids and symbols both ways', () => {
    for (const f of listAssetFeeds()) {
      expect(assetByFeedId(f.feedIdHex)?.symbol).toBe(f.symbol);
      expect(assetByFeedId(`0x${f.feedIdHex.toUpperCase()}`)?.symbol).toBe(f.symbol);
      expect(assetBySymbol(`${f.symbol}/USD`)?.feedIdHex).toBe(f.feedIdHex);
    }
    expect(assetByFeedId('00'.repeat(32))).toBeUndefined();
    expect(listAssetFeeds().map((f) => f.symbol).sort()).toEqual(['BONK', 'BTC', 'ETH', 'JUP', 'SOL', 'WIF']);
  });
  it('categories', () => {
    expect(categoryFor('sol')).toBe('Majors');
    expect(categoryFor('BONK')).toBe('Solana ecosystem');
  });
});
