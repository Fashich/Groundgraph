import { describe, expect, it } from 'vitest';
import { numberToRaw, numericToBigInt, parseU64, rawToDecimalString, rawToNumber, sleep, usdcToNumber } from '../src/units';

describe('units', () => {
  it('parseU64 accepts plain integers and rejects everything else', () => {
    expect(parseU64('0')).toBe(0n);
    expect(parseU64('18446744073709551615')).toBe(18446744073709551615n);
    for (const bad of ['', '-1', '1.5', '1e3', ' 1', '18446744073709551616', '0x10', 'abc']) expect(() => parseU64(bad), bad).toThrow(RangeError);
  });

  it('usdcToNumber handles signed base units', () => {
    expect(usdcToNumber(1_500_000n)).toBe(1.5);
    expect(usdcToNumber('-2500000')).toBe(-2.5);
    expect(usdcToNumber(0n)).toBe(0);
  });

  it('numericToBigInt truncates fractions and tolerates null', () => {
    expect(numericToBigInt('123.99')).toBe(123n);
    expect(numericToBigInt('-5.5')).toBe(-5n);
    expect(numericToBigInt(null)).toBe(0n);
    expect(numericToBigInt(42)).toBe(42n);
    expect(numericToBigInt('')).toBe(0n);
  });

  it('rawToDecimalString is exact', () => {
    expect(rawToDecimalString(11279751066n, -8)).toBe('112.79751066');
    expect(rawToDecimalString(25_000_000_000n, -8)).toBe('250');
    expect(rawToDecimalString(5n, -8)).toBe('0.00000005');
    expect(rawToDecimalString(-12345n, -2)).toBe('-123.45');
    expect(rawToDecimalString(7n, 2)).toBe('700');
    expect(rawToDecimalString(0n, -8)).toBe('0');
  });

  it('rawToNumber and numberToRaw round trip', () => {
    expect(rawToNumber(25_050_000_000n, -8)).toBeCloseTo(250.5, 10);
    expect(numberToRaw(250.5, -8)).toBe(25_050_000_000n);
    expect(numberToRaw(0.00001234, -10)).toBe(123_400n);
    expect(() => numberToRaw(-1, -8)).toThrow(RangeError);
    expect(() => numberToRaw(Number.NaN, -8)).toThrow(RangeError);
  });

  it('sleep resolves early on abort', async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 20);
    await sleep(5000, ac.signal);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
