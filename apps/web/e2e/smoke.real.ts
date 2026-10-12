import { expect, test } from '@playwright/test';

/**
 * Cheap smoke against the REAL stack: the web app (REAL_WEB_URL, default http://localhost:3000, started with API_ORIGIN
 * pointing at the real API) and the API behind its /api proxy. No wallet is involved, so nothing is signed or written.
 *   pnpm --filter @groundgraph/web e2e:real
 */
test.describe('real stack smoke', () => {
  test('the API answers through the same-origin proxy: health and the markets list', async ({ request }) => {
    const health = await request.get('/api/health');
    expect(health.ok()).toBeTruthy();
    const h = (await health.json()) as { ok: boolean; keeper?: { ok: boolean; ageSec: number | null } };
    expect(typeof h.ok).toBe('boolean'); // false when a dependency (for example the RPC) is down; the shape is what matters here
    expect(typeof h.keeper?.ok).toBe('boolean');

    const list = await request.get('/api/markets?status=open&limit=5');
    expect(list.ok()).toBeTruthy();
    const body = (await list.json()) as { items: { id: string; question: string; priceAbove: number; dataSource?: string }[] };
    expect(Array.isArray(body.items)).toBe(true);
    for (const m of body.items) {
      expect(typeof m.id).toBe('string');
      expect(m.priceAbove).toBeGreaterThanOrEqual(0);
      expect(m.priceAbove).toBeLessThanOrEqual(1);
    }
  });

  test('errors use the documented envelope', async ({ request }) => {
    const res = await request.get('/api/markets/does-not-exist');
    expect(res.status()).toBeGreaterThanOrEqual(400);
    const j = (await res.json()) as { error?: { code: string; message: string } };
    expect(typeof j.error?.code).toBe('string');
  });

  test('public pages render and protected pages ask for a wallet', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.goto('/legal/terms');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.goto('/markets');
    await expect(page.getByRole('dialog', { name: 'Connect a wallet' })).toBeVisible({ timeout: 20_000 });
  });
});
