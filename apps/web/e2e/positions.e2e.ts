import { connectWallet, expect, mockBalance, mockSettle, test, viewOnly, WALLET_ADDRESS } from './fixtures';

const rows = (page: import('@playwright/test').Page) => page.locator('[data-component="PositionRow"]');

test.describe('positions', () => {
  test.beforeEach(async ({ wallet }) => {
    void wallet;
    await mockBalance(WALLET_ADDRESS, 5000);
  });

  test('open positions list with radar context, and the three tabs', async ({ page }) => {
    await connectWallet(page, '/positions');
    await expect(rows(page).first()).toBeVisible();
    await expect(rows(page).first()).toHaveAttribute('data-status', /open|trading_closed/);
    await expect(page.getByTestId('stat-open')).toBeVisible();
    await expect(page.getByRole('tab', { name: /To redeem/ })).toBeVisible();
    await page.getByRole('tab', { name: /Resolved/ }).click();
    await expect(rows(page).first()).toBeVisible();
    await expect(rows(page).first()).toHaveAttribute('data-status', /settled|voided/);
  });

  test('redeeming a settled winner signs once and shows the receipt', async ({ page, wallet }) => {
    await connectWallet(page, '/positions');
    await page.getByRole('tab', { name: /To redeem/ }).click();
    const row = rows(page).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText(/settled at \$1 per share/i);
    await row.getByTestId('redeem').click();
    await expect(page.getByText(/USDC was returned to your wallet/i)).toBeVisible({ timeout: 20_000 });
    expect(wallet.signedTx).toBe(1);
  });

  test('a position settling while the page is open moves to To redeem without a reload', async ({ page }) => {
    await connectWallet(page, '/positions');
    const open = page.locator('[data-component="PositionRow"][data-status="open"]').first();
    await expect(open).toBeVisible();
    const marketId = (await open.getAttribute('data-market'))!;
    const side = (await open.getAttribute('data-side'))!;
    await mockSettle(marketId, side === 'above' ? 'above' : 'below');
    await page.getByRole('tab', { name: /To redeem/ }).click();
    await expect(page.locator(`[data-component="PositionRow"][data-market="${marketId}"]`).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('redeem').first()).toBeVisible();
  });

  test('a voided market redeems every share at $0.50', async ({ page }) => {
    await connectWallet(page, '/positions');
    const open = page.locator('[data-component="PositionRow"][data-status="open"]').first();
    await expect(open).toBeVisible();
    const marketId = (await open.getAttribute('data-market'))!;
    await mockSettle(marketId);
    await page.getByRole('tab', { name: /To redeem/ }).click();
    const voided = page.locator(`[data-component="PositionRow"][data-market="${marketId}"]`).first();
    await expect(voided).toBeVisible({ timeout: 15_000 });
    await expect(voided).toContainText(/voided/i);
    await expect(voided).toContainText(/\$0\.50/);
  });

  test('holding both sides of a market offers a merge, signed once', async ({ page, wallet }) => {
    await connectWallet(page, '/positions');
    const open = page.locator('[data-component="PositionRow"][data-status="open"]').first();
    await expect(open).toBeVisible();
    const marketId = (await open.getAttribute('data-market'))!;
    const side = (await open.getAttribute('data-side'))!;
    const other = side === 'above' ? 'below' : 'above';
    await page.goto(`/markets/${marketId}?side=${other}`);
    await page.getByLabel('Amount in USDC').fill('20');
    await page.getByTestId('trade-cta').click();
    await expect(page.getByText(/Confirmed|Bought|receipt/i).first()).toBeVisible({ timeout: 20_000 });
    expect(wallet.signedTx).toBe(1);
    await page.goto('/positions');
    const merge = page.locator(`[data-component="PositionRow"][data-market="${marketId}"]`).getByTestId('merge').first();
    await expect(merge).toBeVisible();
    await merge.click();
    await expect(page.getByText(/complete sets were burned/i)).toBeVisible({ timeout: 20_000 });
    expect(wallet.signedTx).toBe(2);
  });

  test('view-only sessions see the positions but cannot redeem, merge or trade', async ({ page }) => {
    await viewOnly(page, WALLET_ADDRESS, '/positions');
    await expect(rows(page).first()).toBeVisible();
    await expect(page.getByTestId('redeem')).toHaveCount(0);
    await expect(page.getByTestId('merge')).toHaveCount(0);
    await expect(page.getByText('View only').first()).toBeVisible();
  });
});
