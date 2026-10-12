import { connectWallet, expect, mockBalance, test, viewOnly, WALLET_ADDRESS } from './fixtures';

test.describe('create market (Close kind only)', () => {
  test.beforeEach(async ({ wallet }) => {
    void wallet;
    await mockBalance(WALLET_ADDRESS, 5000);
  });

  test('touch markets are shown as coming soon and cannot be picked', async ({ page }) => {
    await connectWallet(page, '/create');
    await expect(page.getByText(/COMING SOON/i).first()).toBeVisible();
    await expect(page.getByTitle(/Touch markets are not enabled/i)).toHaveAttribute('aria-disabled', 'true');
  });

  test('step 1 asks for a target price, then the question previews in plain words', async ({ page }) => {
    await connectWallet(page, '/create');
    await page.getByTestId('asset-SOL').click();
    await page.locator('#target-price').fill('');
    // the button is aria-disabled (not disabled) so the validation message can show, which Playwright treats as not enabled
    await page.getByTestId('create-next').click({ force: true });
    await expect(page.getByRole('alert').first()).toBeVisible();
    await expect(page.getByLabel('Resolution date')).toHaveCount(0);
    await page.locator('#target-price').fill('260');
    await expect(page.getByTestId('question-preview')).toContainText(/SOL/);
    await expect(page.getByTestId('question-preview')).toContainText(/260/);
    await page.getByTestId('create-next').click();
    await expect(page.getByLabel('Resolution date')).toBeVisible();
  });

  test('walks three steps and publishes: one signature, then a link to the new market', async ({ page, wallet }) => {
    await connectWallet(page, '/create');
    await page.getByTestId('asset-SOL').click();
    await page.locator('#target-price').fill('260');
    await page.getByTestId('create-next').click();

    // step 2: timing and liquidity
    await expect(page.getByLabel('Resolution date')).toBeVisible();
    await page.locator('#liq').fill('250');
    await page.getByTestId('create-next').click();

    // step 3: review. The CTA stays inactive until the acknowledgement is ticked.
    await expect(page.getByTestId('create-next')).toHaveAttribute('aria-disabled', 'true');
    await page.getByText(/I understand the question, rule and oracle are final/).click();
    await expect(page.getByTestId('create-next')).toHaveText(/Publish market/);
    await page.getByTestId('create-next').click();

    await expect(page.getByRole('button', { name: /View market/ })).toBeVisible({ timeout: 20_000 });
    expect(wallet.signedTx).toBe(1);
    await page.getByRole('button', { name: /View market/ }).click();
    await expect(page).toHaveURL(/\/markets\/[^/?]+/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/SOL/);
  });

  test('the wallet rejecting the request leaves the form intact and says no funds moved', async ({ page, wallet }) => {
    await connectWallet(page, '/create');
    await page.getByTestId('asset-SOL').click();
    await page.locator('#target-price').fill('260');
    await page.getByTestId('create-next').click();
    await page.locator('#liq').fill('250');
    await page.getByTestId('create-next').click();
    await page.getByText(/I understand the question, rule and oracle are final/).click();
    wallet.rejectNext();
    await page.getByTestId('create-next').click();
    await expect(page.getByText('Request rejected in your wallet')).toBeVisible();
    await expect(page.getByText(/no funds moved/i)).toBeVisible();
  });

  test('view-only sessions cannot publish', async ({ page }) => {
    await viewOnly(page, WALLET_ADDRESS, '/create');
    await page.getByTestId('asset-SOL').click();
    await page.locator('#target-price').fill('260');
    await page.getByTestId('create-next').click();
    await page.locator('#liq').fill('250');
    await page.getByTestId('create-next').click();
    await page.getByText(/I understand the question, rule and oracle are final/).click();
    await expect(page.getByTestId('create-next')).toHaveText(/Connect a signing wallet to publish/);
  });
});
