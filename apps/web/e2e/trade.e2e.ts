import { connectWallet, expect, mockBalance, mockConfig, openTradePanel, staleMarket, test, tradableMarket, viewOnly, WALLET_ADDRESS } from './fixtures';

test.describe('market page: quote and trade', () => {
  test.beforeEach(async ({ wallet }) => {
    void wallet;
    await mockBalance(WALLET_ADDRESS, 5000);
  });

  test('shows the radar and the detail sections, then quotes as you type', async ({ page }) => {
    const m = await tradableMarket();
    await connectWallet(page, `/markets/${m.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(m.question.split(' ')[0]!);
    await expect(page.getByText(/Radar P\(ABOVE\)/i).first()).toBeVisible();
    await openTradePanel(page);
    await page.getByLabel('Amount in USDC').fill('25');
    const rows = page.getByTestId('trade-rows');
    await expect(rows).toContainText(/Est\. shares/i);
    await expect(rows).not.toContainText(/^\s*-\s*$/);
    await expect(page.getByTestId('trade-cta')).toHaveText(/Buy ABOVE · \$25\.00/);
  });

  test('buys ABOVE: the wallet signs once, the receipt appears, the position shows up', async ({ page, wallet }) => {
    const m = await tradableMarket();
    await connectWallet(page, `/markets/${m.id}`);
    await openTradePanel(page);
    await page.getByLabel('Amount in USDC').fill('25');
    await page.getByTestId('trade-cta').click();
    await expect(page.getByText(/Confirmed|Bought|receipt|You bought/i).first()).toBeVisible({ timeout: 20_000 });
    expect(wallet.signedTx).toBe(1);
    await page.goto('/positions');
    await expect(page.locator(`[data-component="PositionRow"][data-market="${m.id}"]`).first()).toBeVisible();
  });

  test('sell tab is reachable from a position link and sells', async ({ page, wallet }) => {
    const m = await tradableMarket();
    await connectWallet(page, '/positions');
    const row = page.locator('[data-component="PositionRow"][data-status="open"]').first();
    await expect(row).toBeVisible();
    await row.getByTestId('sell').click();
    await expect(page).toHaveURL(/tab=sell/);
    await page.getByLabel('Amount in shares').fill('5');
    await page.getByTestId('trade-cta').click();
    await expect(page.getByText(/Confirmed|Sold|receipt/i).first()).toBeVisible({ timeout: 20_000 });
    expect(wallet.signedTx).toBe(1);
    void m;
  });

  test('error: the wallet rejects the request', async ({ page, wallet }) => {
    const m = await tradableMarket();
    await connectWallet(page, `/markets/${m.id}`);
    await openTradePanel(page);
    await page.getByLabel('Amount in USDC').fill('10');
    wallet.rejectNext();
    await page.getByTestId('trade-cta').click();
    await expect(page.getByText('Request rejected in your wallet')).toBeVisible();
    await expect(page.getByText(/no funds moved/i)).toBeVisible();
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByText(/Confirmed|Bought|receipt/i).first()).toBeVisible({ timeout: 20_000 });
  });

  test('error: slippage, with a one click retry at 2%', async ({ page }) => {
    const m = await tradableMarket();
    await connectWallet(page, `/markets/${m.id}`);
    await openTradePanel(page);
    await page.getByLabel('Amount in USDC').fill('10');
    await mockConfig({ failNext: 'slippage_exceeded' });
    await page.getByTestId('trade-cta').click();
    await expect(page.getByText('Price moved beyond your slippage limit')).toBeVisible();
    await page.getByRole('button', { name: /Retry at 2% slippage/ }).click();
    await expect(page.getByText(/Confirmed|Bought|receipt/i).first()).toBeVisible({ timeout: 20_000 });
  });

  test('error: oracle stale pauses buys and says selling still works', async ({ page }) => {
    const m = await staleMarket();
    test.skip(!m, 'the mock has no stale market in this build');
    await connectWallet(page, `/markets/${m!.id}`);
    await openTradePanel(page);
    await expect(page.getByText(/oracle stale|price feed is stale/i).first()).toBeVisible();
    await page.getByLabel('Amount in USDC').fill('10');
    await expect(page.getByTestId('trade-cta')).toBeDisabled();
    await expect(page.getByTestId('trade-cta')).toHaveText(/oracle stale/i);
  });

  test('error: region block stops buying and says exits still work', async ({ page, wallet }) => {
    const m = await tradableMarket();
    await connectWallet(page, `/markets/${m.id}`);
    await openTradePanel(page);
    await page.getByLabel('Amount in USDC').fill('10');
    await mockConfig({ geoBlockTx: true });
    await page.getByTestId('trade-cta').click();
    await expect(page.getByText('Not available in your region')).toBeVisible();
    await expect(page.getByText(/Selling, merging and redeeming always work/)).toBeVisible();
    expect(wallet.signedTx).toBe(0);
  });

  test('error: daily limit', async ({ page }) => {
    const m = await tradableMarket();
    await connectWallet(page, '/positions');
    await page.locator('#limits').getByRole('button', { name: '$100' }).click();
    await expect(page.getByText(/Daily limit set/i).first()).toBeVisible();
    await page.goto(`/markets/${m.id}`);
    await openTradePanel(page);
    await page.getByLabel('Amount in USDC').fill('150');
    await page.getByTestId('trade-cta').click();
    await expect(page.getByText('Daily trading limit reached')).toBeVisible();
  });

  test('a break blocks buying but never selling', async ({ page }) => {
    const m = await tradableMarket();
    await connectWallet(page, '/positions');
    await page.locator('#limits').getByRole('button', { name: '24 hours' }).click();
    await page.locator('#limits').getByRole('button', { name: /start|confirm|yes/i }).first().click();
    await expect(page.getByText(/break/i).first()).toBeVisible();
    await page.goto(`/markets/${m.id}`);
    await openTradePanel(page);
    await page.getByLabel('Amount in USDC').fill('10');
    await expect(page.getByTestId('trade-cta')).toHaveText(/On a break/);
    await expect(page.getByTestId('trade-cta')).toBeDisabled();
    // selling is still offered
    await page.goto('/positions');
    await expect(page.getByTestId('sell').first()).toBeVisible();
  });

  test('view-only sessions can read but not trade', async ({ page }) => {
    const m = await tradableMarket();
    await viewOnly(page, WALLET_ADDRESS, `/markets/${m.id}`);
    await openTradePanel(page);
    await expect(page.getByTestId('trade-cta')).toHaveText(/View-only/);
  });
});
