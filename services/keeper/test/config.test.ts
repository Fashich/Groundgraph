import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

describe('keeper config', () => {
  it('without a key the settlement oracle is the push feeds, limited to SOL and ETH', () => {
    const c = loadConfig({});
    expect(c.settlementMode).toBe('push-feed');
    expect([...c.pushAssets].sort()).toEqual(['ETH', 'SOL']);
    expect(c).toMatchObject({ KEEPER_ORACLE_INTERVAL_MS: 2000, KEEPER_SETTLE_INTERVAL_SECS: 10, KEEPER_FAIRVALUE_INTERVAL_SECS: 60, KEEPER_METRICS_PORT: 9101, KEEPER_SEND_TRANSACTIONS: true });
  });

  it('with a key, auto mode uses Hermes', () => {
    expect(loadConfig({ PYTH_API_KEY: 'k' }).settlementMode).toBe('hermes');
  });

  it('the switch can force the push feeds even when a key is present', () => {
    expect(loadConfig({ PYTH_API_KEY: 'k', KEEPER_SETTLEMENT_ORACLE: 'push-feed' }).settlementMode).toBe('push-feed');
  });

  it('refuses hermes mode without a key', () => {
    expect(() => loadConfig({ KEEPER_SETTLEMENT_ORACLE: 'hermes' })).toThrow(/PYTH_API_KEY/);
  });

  it('parses the asset list and thresholds', () => {
    const c = loadConfig({ KEEPER_PUSH_FEED_ASSETS: ' sol , btc ', KEEPER_MIN_SOL: '0.5' });
    expect([...c.pushAssets].sort()).toEqual(['BTC', 'SOL']);
    expect(c.minLamports).toBe(500_000_000n);
  });

  it('rejects nonsense values', () => {
    expect(() => loadConfig({ KEEPER_SETTLE_INTERVAL_SECS: '0' })).toThrow(/KEEPER_SETTLE_INTERVAL_SECS/);
    expect(() => loadConfig({ KEEPER_SETTLEMENT_ORACLE: 'magic' })).toThrow();
    expect(() => loadConfig({ ALERT_WEBHOOK_URL: 'not a url' })).toThrow();
  });
});
