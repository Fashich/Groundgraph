import { connectWallet, expect, test, viewOnly, WALLET_ADDRESS, OTHER_ADDRESS } from './fixtures';

test.describe('wallet connection', () => {
  test('connect, accept the Terms, sign in with the wallet, land in the app', async ({ page, wallet }) => {
    await connectWallet(page, '/positions');
    await expect(page).toHaveURL(/\/positions/);
    await expect(page.getByRole('heading', { name: 'Positions' })).toBeVisible();
    await expect(page.getByText(`${WALLET_ADDRESS.slice(0, 4)}`).first()).toBeVisible();
    expect(wallet.signedTx).toBe(0);
  });

  test('the Terms gate cannot be skipped: the accept button stays disabled until the box is ticked', async ({ page, wallet }) => {
    void wallet;
    await page.goto('/?connect=1&next=%2Fmarkets');
    await page.getByRole('dialog', { name: 'Connect a wallet' }).getByRole('button', { name: /E2E Wallet/ }).click();
    const legal = page.getByRole('dialog').filter({ has: page.getByRole('checkbox') });
    await expect(legal.getByRole('button', { name: /accept/i })).toBeDisabled();
    await legal.getByText(/I am 18 or older/).click();
    await expect(legal.getByRole('button', { name: /accept/i })).toBeEnabled();
  });

  test('pasting an address opens a read-only session', async ({ page }) => {
    await viewOnly(page, OTHER_ADDRESS, '/positions');
    await expect(page).toHaveURL(/\/positions/);
    await expect(page.getByText(/read only/i).first()).toBeVisible();
    // no action buttons that need a signature
    await expect(page.getByTestId('redeem')).toHaveCount(0);
  });

  test('an EVM address gets its own helpful message', async ({ page }) => {
    await page.goto('/?connect=1');
    const dialog = page.getByRole('dialog', { name: 'Connect a wallet' });
    await dialog.getByLabel('Solana wallet address').fill('0x71C7656EC7ab88b098defB751B7401B5f6d8976F');
    await dialog.getByLabel('Solana wallet address').blur();
    await expect(dialog.getByRole('alert')).toContainText(/EVM/);
    await expect(dialog.getByRole('button', { name: /continue in view-only/i })).toBeDisabled();
  });

  test('app routes send visitors without a session to the connect dialog', async ({ page }) => {
    await page.goto('/markets');
    await expect(page.getByRole('dialog', { name: 'Connect a wallet' })).toBeVisible();
  });
});
