import { describe, expect, it } from 'vitest';
import { ago, cents, clamp, countdownLabel, fmtD, fmtDT, fromBase, hoursUntil, leftLabel, num, pct, shortAddr, signedCents, signedInt, signedPP, signedUsd, toBase, txShort, usd, usdFromU64 } from '@/lib/format';

describe('fromBase / toBase', () => {
  it('converts u64 strings with 6 decimals', () => {
    expect(fromBase('1000000')).toBe(1);
    expect(fromBase('1')).toBeCloseTo(0.000001, 9);
    expect(fromBase('123456789')).toBeCloseTo(123.456789, 6);
    expect(fromBase(null)).toBe(0);
    expect(fromBase(undefined)).toBe(0);
  });
  it('reads signed strings (PositionRow.pnl is signed)', () => {
    expect(fromBase('-2500000')).toBe(-2.5);
    expect(fromBase('-1')).toBeCloseTo(-0.000001, 9);
  });
  it('handles values beyond 2^53 without throwing', () => {
    expect(fromBase('18446744073709551615')).toBeGreaterThan(1e13);
  });
  it('parses user input into base units and rejects junk', () => {
    expect(toBase('1')).toBe('1000000');
    expect(toBase('12.5')).toBe('12500000');
    expect(toBase('0.000001')).toBe('1');
    expect(toBase('')).toBeNull();
    expect(toBase('abc')).toBeNull();
    expect(toBase('-3')).toBeNull();
    expect(toBase('0')).toBe('0');
  });
  it('truncates beyond 6 decimals instead of rounding up', () => {
    expect(toBase('1.2345678')).toBe('1234567');
  });
});

describe('money and price formatting', () => {
  it('usd scales k and M and keeps the sign', () => {
    expect(usd(0)).toBe('$0.00');
    expect(usd(12.345)).toBe('$12.35');
    expect(usd(1500)).toBe('$1.5k');
    expect(usd(2_500_000)).toBe('$2.50M');
    expect(usd(-4)).toBe('−$4.00');
  });
  it('signedUsd always shows a sign', () => {
    expect(signedUsd(5)).toBe('+$5.00');
    expect(signedUsd(-5)).toBe('−$5.00');
    expect(signedUsd(0)).toBe('+$0.00');
  });
  it('cents and percentages', () => {
    expect(cents(0.54)).toBe('54¢');
    expect(pct(0.256)).toBe('26%');
    expect(signedCents(-3)).toBe('−3¢');
    expect(signedCents(4)).toBe('+4¢');
    expect(signedInt(-2)).toBe('−2');
    expect(signedPP(1.26)).toBe('+1.3');
  });
  it('usdFromU64 chains the two', () => {
    expect(usdFromU64('2500000')).toBe('$2.50');
  });
  it('never emits an em dash', () => {
    const samples = [usd(-1), signedUsd(-1), signedCents(-1), signedInt(-1), signedPP(-1), shortAddr('x'.repeat(44)), txShort('s'.repeat(88)), leftLabel(0), countdownLabel(50)];
    for (const s of samples) expect(s.includes(String.fromCharCode(0x2014))).toBe(false);
  });
});

describe('time and address helpers', () => {
  const now = Date.parse('2026-10-12T12:00:00.000Z');
  it('hoursUntil and labels', () => {
    expect(hoursUntil('2026-10-12T18:00:00.000Z', now)).toBe(6);
    expect(leftLabel(0)).toBe('Resolving');
    expect(leftLabel(50)).toBe('2d 2h');
    expect(leftLabel(5.5)).toMatch(/^5h 30m$/);
  });
  it('ago', () => {
    expect(ago('2026-10-12T11:59:58.000Z', now)).toBe('now');
    expect(ago('2026-10-12T11:59:00.000Z', now)).toBe('1m');
    expect(ago('2026-10-12T09:00:00.000Z', now)).toBe('3h');
  });
  it('dates are UTC', () => {
    expect(fmtD('2026-10-20T23:59:00.000Z')).toBe('Oct 20');
    expect(fmtDT('2026-10-20T23:59:00.000Z')).toBe('Oct 20 · 23:59 UTC');
  });
  it('shortAddr and txShort', () => {
    expect(shortAddr('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU')).toBe('7xKX…sgAsU'.replace('sgAsU', 'gAsU'));
    expect(shortAddr(null)).toBe('');
    expect(txShort(undefined)).toBeTypeOf('string');
  });
  it('clamp and num', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(num('12.5')).toBe(12.5);
    expect(Number.isNaN(num('x'))).toBe(false);
  });
});
