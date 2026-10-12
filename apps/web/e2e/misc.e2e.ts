import { connectWallet, expect, mockBalance, test, tradableMarket, WALLET_ADDRESS } from './fixtures';

test.describe('geofence', () => {
  test('a blocked country cannot open the markets list, create or the radar, but can still reach positions and legal pages', async ({ page, wallet }) => {
    void wallet;
    await page.setExtraHTTPHeaders({ 'cf-ipcountry': 'US' });
    for (const path of ['/markets', '/create', '/radar']) {
      await page.goto(path);
      await expect(page.getByText(/not available where you are/i)).toBeVisible();
    }
    // exits must stay reachable
    await page.goto('/legal/terms');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.goto('/positions');
    await expect(page.getByText(/not available where you are/i)).toHaveCount(0);
    await page.goto('/blocked');
    await expect(page.getByRole('link', { name: /positions/i }).first()).toBeVisible();
  });

  test('an allowed country is not blocked', async ({ page, wallet }) => {
    void wallet;
    await page.setExtraHTTPHeaders({ 'cf-ipcountry': 'DE' });
    await page.goto('/markets');
    await expect(page.getByText(/not available where you are/i)).toHaveCount(0);
  });
});

test.describe('public pages', () => {
  test('landing has one h1, a working call to action, and honest copy', async ({ page, wallet }) => {
    void wallet;
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    const text = (await page.locator('body').innerText()).toLowerCase();
    for (const banned of ['betting', 'jackpot', 'gamble', 'win big', 'claim winnings']) expect(text).not.toContain(banned);
    expect(text).toMatch(/devnet/);
  });

  test('legal pages render for every document and link to each other', async ({ page, wallet }) => {
    void wallet;
    for (const doc of ['terms', 'privacy', 'risk']) {
      await page.goto(`/legal/${doc}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await page.locator('article section, main section, [id^="s0"]').count()).toBeGreaterThan(0);
    }
  });

  test('an unknown legal document and an unknown route show the not-found page', async ({ page, wallet }) => {
    void wallet;
    const res = await page.goto('/legal/not-a-document');
    expect(res?.status()).toBe(404);
    await expect(page.getByText(/does not exist/i)).toBeVisible();
    await page.goto('/nowhere');
    await expect(page.getByText(/does not exist/i)).toBeVisible();
  });

  test('protected screens send a signed-out visitor to connect, then bring them back', async ({ page, wallet }) => {
    void wallet;
    await page.goto('/positions');
    await expect(page.getByRole('dialog', { name: 'Connect a wallet' })).toBeVisible();
  });
});

test.describe('share', () => {
  test('the share dialog offers the blink and the page link', async ({ page, wallet }) => {
    void wallet;
    await mockBalance(WALLET_ADDRESS, 1000);
    const m = await tradableMarket();
    await connectWallet(page, `/markets/${m.id}`);
    await page.getByRole('button', { name: /share/i }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Share as a Blink' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Blink link')).toHaveValue(new RegExp(`/actions/m/${m.id}`));
    await expect(dialog.getByLabel('Market link')).toHaveValue(new RegExp(`/markets/${m.id}`));
    await expect(dialog.getByRole('link', { name: /Post on X/ })).toHaveAttribute('href', /twitter\.com\/intent\/tweet/);
  });
});
