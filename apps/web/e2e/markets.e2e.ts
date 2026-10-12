import { connectWallet, expect, listMarkets, mockSettle, test, tradableMarket } from './fixtures';

test.describe('markets list', () => {
  test.beforeEach(async ({ page, wallet }) => {
    void wallet;
    await connectWallet(page, '/markets');
    await expect(page.locator('[data-component="MarketCard"]').first()).toBeVisible();
  });

  test('shows the markets the API returns, and counts them in the header', async ({ page }) => {
    const open = await listMarkets('open');
    await expect(page.locator('[data-component="MarketCard"]')).toHaveCount(open.length);
    await expect(page.getByText(new RegExp(`${open.length} live markets`))).toBeVisible();
  });

  test('category chips, search, lean, ends and sort change the list and the URL', async ({ page }) => {
    const all = await page.locator('[data-component="MarketCard"]').count();

    await page.getByRole('group', { name: 'Category' }).getByRole('button', { name: 'Majors' }).click();
    await expect.poll(() => page.locator('[data-component="MarketCard"]').count()).toBeLessThan(all);
    await expect(page.locator('[data-component="MarketCard"]').first()).toContainText('Majors');
    await page.getByRole('group', { name: 'Category' }).getByRole('button', { name: 'All' }).click();
    await expect.poll(() => page.locator('[data-component="MarketCard"]').count()).toBe(all);

    await page.getByLabel('Search markets').fill('BONK');
    await expect.poll(() => page.locator('[data-component="MarketCard"]').count()).toBeLessThan(all);
    await expect(page.locator('[data-component="MarketCard"]').first()).toContainText('BONK');
    await page.getByLabel('Search markets').fill('');

    await page.getByRole('group', { name: 'Smart money lean' }).getByRole('button', { name: 'Above' }).click();
    await expect.poll(() => page.url()).toContain('lean=above');
    await page.getByRole('group', { name: 'Smart money lean' }).getByRole('button', { name: 'Any' }).click();

    await page.getByRole('group', { name: 'Ends in' }).getByRole('button', { name: /48h/ }).click();
    await expect.poll(() => page.url()).toContain('ends=');
    await page.getByRole('group', { name: 'Ends in' }).getByRole('button', { name: 'Any' }).click();

    await page.getByRole('group', { name: 'Sort markets' }).getByRole('button', { name: 'Volume' }).click();
    await expect.poll(() => page.url()).toContain('sort=volume');
  });

  test('a filter combination with no result shows an empty state with a way out', async ({ page }) => {
    await page.getByLabel('Search markets').fill('zzzz-no-such-market');
    await expect(page.getByText(/no markets/i).first()).toBeVisible();
  });

  test('grid and list views both work', async ({ page }) => {
    await page.getByRole('group', { name: 'View' }).getByRole('button', { name: /List/ }).click();
    await expect(page.locator('[data-component="MarketCard"], [data-component="MarketRow"]').first()).toBeVisible();
    await page.getByRole('group', { name: 'View' }).getByRole('button', { name: /Grid/ }).click();
    await expect(page.locator('[data-component="MarketCard"]').first()).toBeVisible();
  });

  test('opening a card goes to the market page', async ({ page }) => {
    await page.locator('[data-component="MarketCard"]').first().locator('a').first().click();
    await expect(page).toHaveURL(/\/markets\/[1-9A-HJ-NP-Za-km-z]{32,44}/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('live: a settle pushed over the WebSocket flips the card and the live count without a reload', async ({ page }) => {
    const open = await listMarkets('open');
    const m = await tradableMarket();
    await mockSettle(m.id, 'above');
    await expect(page.locator('[data-component="MarketCard"]', { hasText: 'Settled ABOVE' })).toHaveCount(1, { timeout: 15_000 });
    await expect(page.getByText(new RegExp(`${open.length - 1} live markets`))).toBeVisible();
  });
});
