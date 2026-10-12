import { describe, expect, it } from 'vitest';
import { buildCreateReq, defaultDraft, durationDate, feeBps, ladder, openingPrice, questionText, ruleText, settleIso } from '@/lib/create';

const now = Date.parse('2026-10-12T12:00:00.000Z');

describe('create market request', () => {
  it('defaults to a Close market 30 days out with the model-fair opening price', () => {
    const d = defaultDraft('SOL', now);
    expect(d.date).toBe('2026-11-11');
    expect(d.seed).toBe('fair');
    expect(d.dyn).toBe(true);
  });
  it('settles at 23:59 UTC on the chosen date', () => {
    expect(settleIso('2026-11-11')).toBe('2026-11-11T23:59:00.000Z');
  });
  it('builds the body the API expects: base units, close kind, no p0 when seeding at fair value', () => {
    const d = { ...defaultDraft('SOL', now), target: '250.5', liq: '500' };
    const req = buildCreateReq(d, 'SOL above or below $250.50 at the Nov 11 close?')!;
    expect(req).toMatchObject({ assetSymbol: 'SOL', kind: 'close', targetPrice: 250.5, liquidityUsdc: '500000000', baseFeeBps: 100, dynamicFee: true, settleTs: '2026-11-11T23:59:00.000Z' });
    expect('p0Bps' in req).toBe(false);
  });
  it('sends p0Bps 5000 only for an even seed', () => {
    const req = buildCreateReq({ ...defaultDraft('SOL', now), target: '100', seed: 'even' }, 'q')!;
    expect(req.p0Bps).toBe(5000);
  });
  it('returns null for an unusable draft', () => {
    expect(buildCreateReq({ ...defaultDraft('SOL', now), target: '' }, 'q')).toBeNull();
    expect(buildCreateReq({ ...defaultDraft('SOL', now), target: '100', liq: 'abc' }, 'q')).toBeNull();
  });
  it('fee options map to the three allowed base fees', () => {
    expect([feeBps('0.5'), feeBps('1'), feeBps('2')]).toEqual([50, 100, 200]);
  });
  it('opening price: even is 50, fair is rounded to cents inside 2..98, unknown is null', () => {
    expect(openingPrice('even', 0.7)).toBe(0.5);
    expect(openingPrice('fair', 0.7149)).toBe(0.71);
    expect(openingPrice('fair', 0.999)).toBe(0.98);
    expect(openingPrice('fair', null)).toBeNull();
  });
});

describe('question and rule text', () => {
  it('question reads like the program wording', () => {
    expect(questionText('SOL', 250, '2026-11-11')).toBe('SOL above or below $250 at the Nov 11 close?');
  });
  it('rule says strictly above, equal settles BELOW in effect, $1 or $0, and the void fallback at $0.50', () => {
    const r = ruleText('SOL', 250, '2026-11-11');
    expect(r).toMatch(/strictly above/);
    expect(r).toMatch(/Otherwise it resolves BELOW/);
    expect(r).toMatch(/\$1 or \$0/);
    expect(r).toMatch(/voided/);
    expect(r).toMatch(/\$0\.50/);
    expect(r).not.toMatch(/at or above/);
  });
});

describe('target ladder', () => {
  it('places spot, target and the ABOVE zone as percentages', () => {
    const l = ladder(100, 120);
    expect(l.spotX).toBeGreaterThanOrEqual(0);
    expect(l.tgtX).toBeGreaterThan(l.spotX);
    expect(l.zoneL + l.zoneW).toBeCloseTo(100, 6);
    expect(l.min).toBeLessThan(100);
    expect(l.max).toBeGreaterThan(120);
  });
  it('falls back to spot when there is no target yet', () => {
    expect(ladder(100, 0).val).toBe(100);
  });
  it('durations are whole days from now', () => {
    expect(durationDate(7, now)).toBe('2026-10-19');
  });
});
