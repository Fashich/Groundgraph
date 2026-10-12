import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from './helpers';

/** Every route of the route table in packages/sdk/src/api-types.ts must exist in the server and in the OpenAPI document. */
const SRC = readFileSync(resolve(__dirname, '../../../packages/sdk/src/api-types.ts'), 'utf8');
const table = SRC.slice(SRC.indexOf('Route table'));

interface R { method: string; path: string }
function parseRoutes(): R[] {
  const out: R[] = [];
  for (const line of table.split('\n')) {
    const m = /^\s*\*\s+(GET|POST|PUT)\s+(\S.*?)(?:\s{2,}|\s*->|$)/.exec(line);
    if (!m) continue;
    const method = m[1]!;
    // "POST /tx/buy | /tx/sell BuildBuySellReq": alternatives separated by "|"
    const paths = m[2]!.split('|').map((p) => p.trim().split(/\s+/)[0]!);
    for (const p of paths) {
      if (!p.startsWith('/')) continue;
      out.push({ method, path: p.split('?')[0]! });
    }
  }
  return out;
}

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
});
afterAll(async () => {
  await h.close();
});

describe('route table in api-types.ts', () => {
  const routes = parseRoutes();

  it('parses the expected number of routes', () => {
    expect(routes.length).toBeGreaterThanOrEqual(30);
    expect(routes).toContainEqual({ method: 'POST', path: '/tx/sell' });
    expect(routes).toContainEqual({ method: 'GET', path: '/markets/:id/quote' });
    expect(routes).toContainEqual({ method: 'POST', path: '/webhooks/helius' });
  });

  it('every route is registered, with and without the /api prefix', async () => {
    const missing: string[] = [];
    for (const r of routes) {
      if (r.path === '/ws') continue; // WebSocket upgrade, covered by ws.test.ts
      if (!h.app.hasRoute({ method: r.method as 'GET', url: r.path })) missing.push(`${r.method} ${r.path}`);
    }
    expect(missing).toEqual([]);
    const a = await h.app.inject({ url: '/api/assets' });
    const b = await h.app.inject({ url: '/assets' });
    expect(a.statusCode).toBe(200);
    expect(a.body).toBe(b.body);
  });

  it('every route is documented in the generated OpenAPI', async () => {
    const doc = (await h.app.inject({ url: '/docs/json' })).json();
    const paths = Object.keys(doc.paths);
    const missing: string[] = [];
    for (const r of routes) {
      if (r.path === '/ws' || r.path === '/webhooks/helius') continue; // webhook is hidden on purpose
      const oas = r.path.replace(/:(\w+)/g, '{$1}');
      if (!paths.includes(oas) || !doc.paths[oas][r.method.toLowerCase()]) missing.push(`${r.method} ${r.path}`);
    }
    expect(missing).toEqual([]);
    expect(doc.openapi).toMatch(/^3\./);
  });

  it('the ws endpoint answers an upgrade only on /ws', async () => {
    const plain = await h.app.inject({ url: '/ws' });
    expect(plain.statusCode).toBe(404); // a plain GET is not a websocket handshake
  });

  it('error bodies follow {error:{code,message,details?}} with ApiErrorCode values', async () => {
    const codes = new Set(['bad_request', 'unauthorized', 'view_only', 'tos_required', 'break_active', 'daily_limit_exceeded', 'oracle_stale', 'market_closed', 'slippage_exceeded', 'below_min_trade', 'insufficient_liquidity', 'not_found', 'rate_limited', 'geo_blocked', 'faucet_unavailable', 'internal']);
    for (const res of [
      await h.app.inject({ url: '/auth/session' }),
      await h.app.inject({ url: '/markets/short' }),
      await h.app.inject({ url: '/nope' }),
      await h.app.inject({ method: 'POST', url: '/auth/nonce', payload: {} }),
      await h.app.inject({ method: 'POST', url: '/auth/nonce', payload: 'garbage', headers: { 'content-type': 'application/json' } }),
    ]) {
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      const b = res.json();
      expect(Object.keys(b)).toEqual(['error']);
      expect(codes.has(b.error.code)).toBe(true);
      expect(typeof b.error.message).toBe('string');
    }
  });

  it('every ApiErrorCode used by the server is a member of the contract union', () => {
    const union = /export type ApiErrorCode =([\s\S]*?);/.exec(SRC)![1]!;
    const members = [...union.matchAll(/'(\w+)'/g)].map((x) => x[1]!);
    expect(members.length).toBe(16);
    const errors = readFileSync(resolve(__dirname, '../src/errors.ts'), 'utf8');
    for (const m of members) expect(errors).toContain(`${m}:`);
  });

  it('sets security headers and never caches API responses', async () => {
    const r = await h.app.inject({ url: '/assets' });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
  });
});
