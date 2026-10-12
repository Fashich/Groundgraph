import { connectWallet, expect, mockBalance, noHorizontalScroll, openTradePanel, test, tradableMarket, WALLET_ADDRESS } from './fixtures';

/** Runs in the `mobile` (390x844) and `tablet` (834x1112) projects. */
test.describe('responsive smoke', () => {
  test.beforeEach(async ({ wallet }) => {
    void wallet;
    await mockBalance(WALLET_ADDRESS, 5000);
  });

  test('public pages fit the viewport', async ({ page }) => {
    for (const path of ['/', '/legal/terms', '/legal/privacy', '/legal/risk', '/blocked', '/nope']) {
      await page.goto(path);
      await expect(page.locator('body')).toBeVisible();
      await noHorizontalScroll(page);
    }
  });

  test('signed in: every Phase 1 screen fits, and the primary navigation is reachable', async ({ page }) => {
    const m = await tradableMarket();
    await connectWallet(page, '/markets');
    await expect(page.locator('[data-component="MarketCard"]').first()).toBeVisible();
    await expect(page.locator('nav[aria-label="Primary"]:visible')).toHaveCount(1);
    await noHorizontalScroll(page);

    await page.goto(`/markets/${m.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await noHorizontalScroll(page);

    await page.goto('/create');
    await expect(page.getByTestId('create-next')).toBeVisible();
    await noHorizontalScroll(page);

    await page.goto('/positions');
    await expect(page.locator('[data-component="PositionRow"]').first()).toBeVisible();
    await noHorizontalScroll(page);

    await page.goto('/radar');
    await expect(page.getByRole('tab', { name: /Explorer/i }).first()).toBeVisible();
    await noHorizontalScroll(page);

    await page.goto('/radar?view=record');
    await expect(page.getByText(/track record/i).first()).toBeVisible();
    await noHorizontalScroll(page);
  });

  test('navigating with the primary navigation works', async ({ page }) => {
    await connectWallet(page, '/markets');
    const nav = page.locator('nav[aria-label="Primary"]:visible');
    await nav.getByRole('link', { name: /Positions/ }).click();
    await expect(page).toHaveURL(/\/positions/);
    await nav.getByRole('link', { name: /Radar/ }).click();
    await expect(page).toHaveURL(/\/radar/);
  });

  test('the trade flow works at this width', async ({ page, wallet }) => {
    const m = await tradableMarket();
    await connectWallet(page, `/markets/${m.id}`);
    await openTradePanel(page);
    await page.getByLabel('Amount in USDC').fill('15');
    await expect(page.getByTestId('trade-cta')).toHaveText(/Buy ABOVE · \$15\.00/);
    await page.getByTestId('trade-cta').click();
    await expect(page.getByText(/Confirmed|Bought|receipt/i).first()).toBeVisible({ timeout: 20_000 });
    expect(wallet.signedTx).toBe(1);
  });

  test('interactive targets are at least 40px tall on the main screens', async ({ page }) => {
    const m = await tradableMarket();
    await connectWallet(page, `/markets/${m.id}`);
    await openTradePanel(page);
    const cta = page.getByTestId('trade-cta');
    await expect(cta).toBeVisible();
    const box = (await cta.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(40);
  });
});
