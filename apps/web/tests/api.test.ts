import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, api, isApiError, qs } from '@/lib/api';

function mockFetch(res: { status?: number; body?: unknown; text?: string } | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (res instanceof Error) throw res;
      const status = res.status ?? 200;
      return { ok: status >= 200 && status < 300, status, text: async () => res.text ?? (res.body === undefined ? '' : JSON.stringify(res.body)) } as Response;
    }),
  );
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe('query strings', () => {
  it('drops empty values and encodes the rest', () => {
    expect(qs({ a: 1, b: '', c: undefined, d: null, e: 'x y', f: false })).toBe('?a=1&e=x+y&f=false');
    expect(qs({})).toBe('');
    expect(qs(undefined)).toBe('');
  });
});

describe('api client', () => {
  it('sends cookies, JSON bodies and goes through /api by default', async () => {
    const calls = mockFetch({ body: { transaction: 't', blockhash: 'b', lastValidBlockHeight: 1, summary: 's' } });
    await api.txRedeem({ marketId: 'm', side: 'above', amount: '5' });
    expect(calls[0]!.url).toBe('/api/tx/redeem');
    expect(calls[0]!.init.credentials).toBe('include');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ marketId: 'm', side: 'above', amount: '5' });
  });

  it('maps the { error: { code, message, details } } shape to ApiRequestError', async () => {
    mockFetch({ status: 403, body: { error: { code: 'break_active', message: 'You are on a break', details: { breakUntil: 'x' } } } });
    const e = await api.txBuy({ marketId: 'm', side: 'above', amount: '1' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiRequestError);
    expect(isApiError(e, 'break_active')).toBe(true);
    expect((e as ApiRequestError).status).toBe(403);
    expect((e as ApiRequestError).details).toEqual({ breakUntil: 'x' });
  });

  it('treats a bare 401 as unauthorized and a non-JSON 500 as internal', async () => {
    mockFetch({ status: 401, text: '' });
    expect(await api.me().catch((x: unknown) => (x as ApiRequestError).code)).toBe('unauthorized');
    mockFetch({ status: 500, text: '<html>oops</html>' });
    expect(await api.me().catch((x: unknown) => (x as ApiRequestError).code)).toBe('internal');
  });

  it('reports a dead network as code "network"', async () => {
    mockFetch(new TypeError('Failed to fetch'));
    const e = (await api.markets({}).catch((x: unknown) => x)) as ApiRequestError;
    expect(e.code).toBe('network');
    expect(e.status).toBe(0);
  });

  it('faucet returns the amount as a base unit string, dispute a string id', async () => {
    mockFetch({ body: { txSig: 's', amount: '1000000000' } });
    expect((await api.faucet('W')).amount).toBe('1000000000');
    mockFetch({ body: { id: 'abc123' } });
    expect(typeof (await api.dispute('long enough message')).id).toBe('string');
  });
});
