import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { scanApp, scanText } from '../scripts/copy-lint.mjs';

const EM = String.fromCharCode(0x2014);

describe('terminology lint (rules)', () => {
  it('flags the banned vocabulary', () => {
    for (const bad of ['Place a bet', 'betting is fun', 'great odds', 'Don\'t gamble', 'win the jackpot', 'win big today', 'claim your winnings', 'your winnings']) {
      expect(scanText(bad, { copy: true }).length, bad).toBeGreaterThan(0);
    }
  });
  it('does not flag lookalike words', () => {
    for (const ok of ['better', 'alphabet', 'between', 'modds', 'Redeem your payout', 'ABOVE or BELOW', 'implied probability']) {
      expect(scanText(ok, { copy: true }), ok).toEqual([]);
    }
  });
  it('flags bare YES / NO outcome labels but not words in prose', () => {
    expect(scanText("label: 'YES'", { copy: true }).length).toBe(1);
    expect(scanText('<span>NO</span>', { copy: true }).length).toBe(1);
    expect(scanText('There is no limit, yes.', { copy: true })).toEqual([]);
  });
  it('flags em dashes everywhere, even outside user-facing files', () => {
    expect(scanText(`a ${EM} b`, { copy: false })).toHaveLength(1);
  });
});

describe('terminology lint (the app)', () => {
  it('src, content, mock-api, tests and e2e are clean', () => {
    const found = scanApp(path.resolve(__dirname, '..'));
    expect(found, JSON.stringify(found.slice(0, 5), null, 2)).toEqual([]);
  });
});
