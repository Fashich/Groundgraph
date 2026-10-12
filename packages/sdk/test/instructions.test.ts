import { createHash } from 'node:crypto';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  IDL,
  PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ata,
  buildAllowFeedIx,
  buildBuyIx,
  buildCreateMarketIx,
  buildDisallowFeedIx,
  buildInitializeConfigIx,
  buildInstruction,
  buildMergeIx,
  buildRedeemIx,
  buildRemoveLiquidityIx,
  buildSellIx,
  buildSettleCloseIx,
  buildUpdateConfigIx,
  buildVoidMarketIx,
  decodeMarket,
  feedIdFromHex,
  pda,
  toUnsignedV0Tx,
  PYTH_FEEDS,
  type MarketAccount,
} from '../src/index';
import samples from './account-samples.json';

const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
const i64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(v); return b; };

const user = Keypair.generate().publicKey;
const creator = Keypair.generate().publicKey;
const usdcMint = Keypair.generate().publicKey;
const feedId = feedIdFromHex(PYTH_FEEDS.SOL!.feedIdHex);

function sampleMarket(): { m: MarketAccount; pk: PublicKey } {
  const base = decodeMarket(Buffer.from(samples.marketOpen.hex, 'hex'));
  const marketPk = pda.market(creator, 7n);
  const m: MarketAccount = {
    ...base,
    creator,
    nonce: 7n,
    collateralMint: usdcMint,
    vault: pda.vault(marketPk),
    aboveMint: pda.aboveMint(marketPk),
    belowMint: pda.belowMint(marketPk),
    lpMint: pda.lpMint(marketPk),
  };
  return { m, pk: marketPk };
}
const { m: market, pk: marketPk } = sampleMarket();

const keyList = (ix: { keys: { pubkey: PublicKey }[] }) => ix.keys.map((k) => k.pubkey.toBase58());
const flags = (ix: { keys: { isSigner: boolean; isWritable: boolean }[] }) => ix.keys.map((k) => `${k.isSigner ? 'S' : '-'}${k.isWritable ? 'W' : '-'}`).join(',');

describe('IDL integrity', () => {
  it('discriminators follow the Anchor convention', () => {
    for (const ix of IDL.instructions) expect(Buffer.from(ix.discriminator).toString('hex'), ix.name).toBe(disc(ix.name).toString('hex'));
  });
  it('exposes the Phase 1 instruction set only', () => {
    expect(IDL.instructions.map((i) => i.name).sort()).toEqual(
      ['allow_feed', 'buy', 'create_market', 'disallow_feed', 'initialize_config', 'merge', 'redeem', 'remove_liquidity', 'sell', 'settle_close', 'update_config', 'void_market'],
    );
  });
  it('program id matches the IDL address', () => {
    expect(PROGRAM_ID.toBase58()).toBe(IDL.address);
  });
});

describe('buy', () => {
  const ixs = buildBuyIx({ market, marketPk, user, side: 'below', usdcIn: 12_345_678n, minSharesOut: 9n });
  const ix = ixs[1]!;
  it('creates the outcome token account idempotently first', () => {
    expect(ixs).toHaveLength(2);
    expect(ixs[0]!.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect(ixs[0]!.data[0]).toBe(1); // CreateIdempotent
    expect(ixs[0]!.keys[1]!.pubkey.equals(ata(market.belowMint, user))).toBe(true);
  });
  it('orders accounts exactly as the program expects', () => {
    expect(keyList(ix)).toEqual(
      [user, pda.config(), marketPk, market.vault, market.belowMint, ata(usdcMint, user), ata(market.belowMint, user), TOKEN_PROGRAM_ID].map((k) => k.toBase58()),
    );
    expect(flags(ix)).toBe('SW,--,-W,-W,-W,-W,-W,--');
    expect(ix.programId.equals(PROGRAM_ID)).toBe(true);
  });
  it('encodes data as discriminator, side, usdc_in, min_shares_out', () => {
    expect(Buffer.from(ix.data).toString('hex')).toBe(Buffer.concat([disc('buy'), Buffer.from([1]), u64(12_345_678n), u64(9n)]).toString('hex'));
  });
  it('uses the ABOVE mint for above', () => {
    const a = buildBuyIx({ market, marketPk, user, side: 'above', usdcIn: 1_000_000n, minSharesOut: 0n })[1]!;
    expect(a.keys[4]!.pubkey.equals(market.aboveMint)).toBe(true);
    expect(a.data[8]).toBe(0);
  });
  it('rejects an invalid side', () => {
    expect(() => buildBuyIx({ market, marketPk, user, side: 'yes' as never, usdcIn: 1n, minSharesOut: 0n })).toThrow();
  });
  it('rejects out-of-range amounts', () => {
    expect(() => buildBuyIx({ market, marketPk, user, side: 'above', usdcIn: 1n << 64n, minSharesOut: 0n })).toThrow(RangeError);
    expect(() => buildBuyIx({ market, marketPk, user, side: 'above', usdcIn: -1n, minSharesOut: 0n })).toThrow(RangeError);
  });
});

describe('sell, merge, redeem, remove_liquidity', () => {
  it('sell', () => {
    const [create, ix] = buildSellIx({ market, marketPk, user, side: 'above', sharesIn: 5n, minUsdcOut: 4n });
    expect(create!.keys[1]!.pubkey.equals(ata(usdcMint, user))).toBe(true);
    expect(keyList(ix!)).toEqual(
      [user, pda.config(), marketPk, market.vault, market.aboveMint, ata(market.aboveMint, user), ata(usdcMint, user), TOKEN_PROGRAM_ID].map((k) => k.toBase58()),
    );
    expect(Buffer.from(ix!.data).toString('hex')).toBe(Buffer.concat([disc('sell'), Buffer.from([0]), u64(5n), u64(4n)]).toString('hex'));
  });
  it('merge', () => {
    const ix = buildMergeIx({ market, marketPk, user, amount: 77n })[1]!;
    expect(keyList(ix)).toEqual(
      [user, marketPk, market.vault, market.aboveMint, market.belowMint, ata(market.aboveMint, user), ata(market.belowMint, user), ata(usdcMint, user), TOKEN_PROGRAM_ID].map((k) => k.toBase58()),
    );
    expect(Buffer.from(ix.data).toString('hex')).toBe(Buffer.concat([disc('merge'), u64(77n)]).toString('hex'));
  });
  it('redeem', () => {
    const ix = buildRedeemIx({ market, marketPk, user, side: 'below', amount: 9n })[1]!;
    expect(keyList(ix)).toEqual(
      [user, marketPk, market.vault, market.belowMint, ata(market.belowMint, user), ata(usdcMint, user), TOKEN_PROGRAM_ID].map((k) => k.toBase58()),
    );
    expect(Buffer.from(ix.data).toString('hex')).toBe(Buffer.concat([disc('redeem'), Buffer.from([1]), u64(9n)]).toString('hex'));
  });
  it('remove_liquidity', () => {
    const ix = buildRemoveLiquidityIx({ market, marketPk, user, lpAmount: 123n })[1]!;
    expect(keyList(ix)).toEqual(
      [user, marketPk, market.vault, market.lpMint, ata(market.lpMint, user), ata(usdcMint, user), TOKEN_PROGRAM_ID].map((k) => k.toBase58()),
    );
    expect(Buffer.from(ix.data).toString('hex')).toBe(Buffer.concat([disc('remove_liquidity'), u64(123n)]).toString('hex'));
  });
});

describe('create_market', () => {
  const args = {
    creator,
    nonce: 7n,
    feedId,
    kind: 'close' as const,
    targetPrice: 25_000_000_000n,
    targetExpo: -8,
    settleTs: 1_800_086_400,
    baseFeeBps: 100 as const,
    dynamicFee: true,
    liquidity: 500_000_000n,
    p0Bps: 2500,
    usdcMint,
  };
  const { instructions, market: mk, accounts } = buildCreateMarketIx(args);
  const ix = instructions[0]!;
  it('derives the market and mint PDAs', () => {
    expect(mk.equals(marketPk)).toBe(true);
    expect(accounts.vault.equals(pda.vault(mk))).toBe(true);
  });
  it('orders accounts exactly as the program expects', () => {
    expect(keyList(ix)).toEqual(
      [
        creator, pda.config(), pda.feed(feedId), usdcMint, mk, pda.vault(mk), pda.aboveMint(mk), pda.belowMint(mk), pda.lpMint(mk),
        ata(usdcMint, creator), ata(pda.aboveMint(mk), creator), ata(pda.belowMint(mk), creator), ata(pda.lpMint(mk), creator),
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId,
      ].map((k) => k.toBase58()),
    );
    expect(flags(ix)).toBe('SW,--,--,--,-W,-W,-W,-W,-W,-W,-W,-W,-W,--,--,--');
  });
  it('encodes params in IDL order', () => {
    const expected = Buffer.concat([
      disc('create_market'),
      u64(7n),
      Buffer.from(feedId),
      Buffer.from([0]), // kind Close
      Buffer.from([0]), // direction None
      i64(25_000_000_000n),
      (() => { const b = Buffer.alloc(4); b.writeInt32LE(-8); return b; })(),
      i64(1_800_086_400n),
      (() => { const b = Buffer.alloc(2); b.writeUInt16LE(100); return b; })(),
      Buffer.from([1]),
      u64(500_000_000n),
      (() => { const b = Buffer.alloc(2); b.writeUInt16LE(2500); return b; })(),
    ]);
    expect(Buffer.from(ix.data).toString('hex')).toBe(expected.toString('hex'));
  });
});

describe('settle, void', () => {
  it('settle_close', () => {
    const feed = Keypair.generate().publicKey;
    const ix = buildSettleCloseIx({ marketPk, market, priceUpdate: feed, payer: user });
    expect(keyList(ix)).toEqual([user, pda.config(), marketPk, market.lpMint, feed].map((k) => k.toBase58()));
    expect(flags(ix)).toBe('S-,--,-W,--,--');
    expect(Buffer.from(ix.data).toString('hex')).toBe(disc('settle_close').toString('hex'));
  });
  it('void_market', () => {
    const ix = buildVoidMarketIx({ marketPk, market, payer: user });
    expect(keyList(ix)).toEqual([user, marketPk, market.lpMint].map((k) => k.toBase58()));
    expect(flags(ix)).toBe('S-,-W,--');
    expect(Buffer.from(ix.data).toString('hex')).toBe(disc('void_market').toString('hex'));
  });
});

describe('admin instructions', () => {
  it('initialize_config', () => {
    const ix = buildInitializeConfigIx({ authority: user, usdcMint, minDurationSecs: 1800n, minLiquidity: 100_000_000n, tradingCloseSecs: 300 });
    expect(keyList(ix)).toEqual([user, pda.config(), usdcMint, pda.programData(), SystemProgram.programId].map((k) => k.toBase58()));
    expect(pda.programData().equals(PublicKey.findProgramAddressSync([PROGRAM_ID.toBytes()], BPF_LOADER_UPGRADEABLE_PROGRAM_ID)[0])).toBe(true);
    // 8 disc + 32 admin + 32 treasury + 2 + 2 + 8 + 8 + 8 + 4 + 2 + 4
    expect(ix.data.length).toBe(8 + 32 + 32 + 2 + 2 + 8 + 8 + 8 + 4 + 2 + 4);
    // defaults the admin and treasury to the authority
    expect(Buffer.from(ix.data).subarray(8, 40).equals(Buffer.from(user.toBytes()))).toBe(true);
    expect(Buffer.from(ix.data).subarray(40, 72).equals(Buffer.from(user.toBytes()))).toBe(true);
  });
  it('update_config encodes options', () => {
    const ix = buildUpdateConfigIx({ admin: user, params: { paused: true, maxFeeBps: 400 } });
    expect(keyList(ix)).toEqual([user, pda.config()].map((k) => k.toBase58()));
    const d = Buffer.from(ix.data);
    // new_admin None, treasury None, protocol_fee_share None, max_fee Some(400)
    expect(d.subarray(8, 8 + 1 + 1 + 1 + 3).toString('hex')).toBe('000000' + '01' + '9001');
    // paused is the last option: Some(true)
    expect(d.subarray(d.length - 2).toString('hex')).toBe('0101');
  });
  it('allow_feed and disallow_feed', () => {
    const a = buildAllowFeedIx({ admin: user, feedId, symbol: 'SOL/USD', expo: -8 });
    expect(keyList(a)).toEqual([user, pda.config(), pda.feed(feedId), SystemProgram.programId].map((k) => k.toBase58()));
    expect(a.data.length).toBe(8 + 32 + 4 + 7 + 4);
    const d = buildDisallowFeedIx({ admin: user, feedId });
    expect(keyList(d)).toEqual([user, pda.config(), pda.feed(feedId)].map((k) => k.toBase58()));
    expect(flags(d)).toBe('S-,--,-W');
  });
});

describe('buildInstruction', () => {
  it('rejects missing accounts and wrong fixed addresses', () => {
    expect(() => buildInstruction('merge', { amount: 1n }, { user })).toThrow(/missing account/);
    expect(() =>
      buildInstruction('disallow_feed', { feedId }, { admin: user, config: pda.config(), feed: pda.feed(feedId) }),
    ).not.toThrow();
    expect(() => buildInstruction('allow_feed', { feedId, symbol: 'X', expo: 0 }, { admin: user, config: pda.config(), feed: pda.feed(feedId), systemProgram: user })).toThrow(/must be/);
  });
  it('rejects wrong argument shapes', () => {
    expect(() => buildInstruction('disallow_feed', { feedId: new Uint8Array(31) }, { admin: user, config: pda.config(), feed: pda.feed(feedId) })).toThrow();
  });
});

describe('toUnsignedV0Tx', () => {
  it('prepends compute budget instructions and serializes', () => {
    const ixs = buildMergeIx({ market, marketPk, user, amount: 1n });
    const tx = toUnsignedV0Tx({ payer: user, instructions: ixs, blockhash: Keypair.generate().publicKey.toBase58(), computeUnitLimit: 200_000, priorityFeeMicroLamports: 1000 });
    expect(tx.message.compiledInstructions.length).toBe(ixs.length + 2);
    expect(tx.serialize().length).toBeGreaterThan(100);
    const plain = toUnsignedV0Tx({ payer: user, instructions: ixs, blockhash: Keypair.generate().publicKey.toBase58() });
    expect(plain.message.compiledInstructions.length).toBe(ixs.length);
  });
});

describe('pda', () => {
  it('config PDA is stable for the program id', () => {
    expect(pda.config().equals(PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID)[0])).toBe(true);
  });
  it('market PDA uses a little-endian nonce', () => {
    const expected = PublicKey.findProgramAddressSync([Buffer.from('market'), creator.toBuffer(), u64(258n)], PROGRAM_ID)[0];
    expect(pda.market(creator, 258n).equals(expected)).toBe(true);
    expect(() => pda.market(creator, -1n)).toThrow(RangeError);
    expect(() => pda.feed(new Uint8Array(5))).toThrow(RangeError);
  });
});
