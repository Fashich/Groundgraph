import path from 'node:path';
import type { Page } from '@playwright/test';
import type { MarketSummary, Paged } from '@groundgraph/sdk/api-types';
import { connectWallet, expect, mockBalance, mockConfig, mockGet, test, WALLET_ADDRESS } from './fixtures';

/**
 * Screenshots of every screen at desktop (1440), tablet (834) and mobile (390) width, written to e2e-screenshots/.
 * Run with: pnpm --filter @groundgraph/web screenshots
 */
const DIR = path.join(__dirname, '..', 'e2e-screenshots');

async function settle(page: Page) {
  // toasts from connecting would cover the page
  for (const b of await page.locator('[data-component="Toaster"] button').all()) await b.click({ timeout: 500 }).catch(() => undefined);
  await page.addStyleTag({ content: '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;scroll-behavior:auto!important}' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
}

async function shot(page: Page, name: string, opts: { full?: boolean } = {}) {
  await settle(page);
  const w = page.viewportSize()?.width ?? 0;
  let hide: Awaited<ReturnType<Page['addStyleTag']>> | null = null;
  // sticky and fixed chrome is drawn at the current scroll offset in full page captures, so capture from the top
  if (opts.full ?? true) {
    await page.evaluate(() => window.scrollTo(0, 0));
    // the bottom bars are viewport-fixed, so in a tall capture they would float mid-page
    hide = await page.addStyleTag({ content: '[data-component="MobileTabBar"],[data-component="MobileTradeBar"]{display:none!important}' });
  }
  await page.screenshot({ path: path.join(DIR, `${name}-${w}.png`), fullPage: opts.full ?? true });
  if (hide) await hide.evaluate((el) => (el as unknown as Element).remove());
}

async function markets() {
  const open = (await mockGet<Paged<MarketSummary>>('/markets?status=open&limit=60')).items;
  const all = (await mockGet<Paged<MarketSummary>>('/markets?status=all&limit=100')).items;
  const settled = all.find((m) => m.status === 'settled');
  const ready = open.find((m) => m.radar.state === 'ready' && m.radar.n >= 3) ?? open[0]!;
  return { open, ready, settled };
}

test.describe('screens', () => {
  test('public: landing, legal, blocked, not found', async ({ page, wallet }) => {
    void wallet;
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.waitForTimeout(1500);
    await shot(page, '01-landing');
    for (const doc of ['terms', 'privacy', 'risk']) {
      await page.goto(`/legal/${doc}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await shot(page, `02-legal-${doc}`);
    }
    await page.setExtraHTTPHeaders({ 'cf-ipcountry': 'US' });
    await page.goto('/markets');
    await expect(page.getByText(/not available where you are/i)).toBeVisible();
    await shot(page, '03-blocked');
    await page.setExtraHTTPHeaders({});
    await page.goto('/this-page-does-not-exist');
    await expect(page.getByText(/does not exist/i)).toBeVisible();
    await shot(page, '04-not-found');
  });

  test('connect and terms dialogs', async ({ page, wallet }) => {
    void wallet;
    await page.goto('/?connect=1');
    await expect(page.getByRole('dialog', { name: 'Connect a wallet' })).toBeVisible();
    await shot(page, '05-connect-modal', { full: false });
    await page.getByRole('dialog', { name: 'Connect a wallet' }).getByRole('button', { name: /E2E Wallet/ }).click();
    await expect(page.getByText(/I am 18 or older/)).toBeVisible();
    await shot(page, '06-terms-modal', { full: false });
  });

  test('markets list, filters, detail, trade, share', async ({ page, wallet }) => {
    void wallet;
    const { ready, settled } = await markets();
    await connectWallet(page, '/markets');
    await expect(page.getByRole('heading', { name: 'Markets', exact: true })).toBeVisible();
    await expect(page.locator('[data-component="MarketCard"]').first()).toBeVisible();
    await shot(page, '10-markets');

    await page.goto(`/markets/${ready.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.locator('[data-component="MiniGraph"]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, '11-market-detail');

    if ((page.viewportSize()?.width ?? 1440) < 760) await page.getByRole('button', { name: /^Buy ABOVE/ }).first().click();
    await page.getByLabel(/Amount in USDC/).fill('25');
    await expect(page.getByTestId('trade-rows')).toContainText(/shares|Avg/i);
    await shot(page, '12-market-detail-quote', { full: false });

    if (settled) {
      await page.goto(`/markets/${settled.id}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await shot(page, '13-market-settled');
    }
  });

  test('create market: three steps', async ({ page, wallet }) => {
    void wallet;
    await mockBalance(WALLET_ADDRESS, 5000);
    await connectWallet(page, '/create');
    await expect(page.getByText(/COMING SOON/i).first()).toBeVisible();
    await page.waitForTimeout(800);
    await shot(page, '20-create-step1');
    await page.locator('#target-price').fill('260');
    await shot(page, '21-create-step1-target');
    await page.getByTestId('create-next').click();
    await expect(page.getByLabel('Resolution date')).toBeVisible();
    await page.locator('#liq').fill('250');
    await shot(page, '22-create-step2');
    await page.getByTestId('create-next').click();
    await page.getByText(/I understand the question, rule and oracle are final/).click();
    await shot(page, '23-create-step3');
    await page.getByTestId('create-next').click();
    await expect(page.getByRole('button', { name: /View market/ })).toBeVisible({ timeout: 20_000 });
    await shot(page, '24-create-published');
  });

  test('mobile navigation bar', async ({ page, wallet }) => {
    void wallet;
    test.skip((page.viewportSize()?.width ?? 1440) >= 760, 'the bottom bar only exists under 760px');
    await connectWallet(page, '/markets');
    await expect(page.locator('[data-component="MarketCard"]').first()).toBeVisible();
    await shot(page, '08-mobile-nav', { full: false });
  });

  test('share dialog and wallet menu', async ({ page, wallet }) => {
    void wallet;
    const { ready } = await markets();
    await connectWallet(page, `/markets/${ready.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.getByRole('button', { name: /share/i }).first().click();
    await expect(page.getByRole('dialog', { name: 'Share as a Blink' })).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, '14-share-dialog', { full: false });
    await page.getByRole('dialog', { name: 'Share as a Blink' }).getByRole('button', { name: 'Close' }).click();
    await page.getByRole('button', { name: 'Wallet menu' }).click();
    await page.waitForTimeout(400);
    await shot(page, '07-wallet-menu', { full: false });
  });

  test('positions', async ({ page, wallet }) => {
    void wallet;
    await connectWallet(page, '/positions');
    await expect(page.locator('[data-component="PositionRow"]').first()).toBeVisible();
    await page.waitForTimeout(800);
    await shot(page, '30-positions-open');
    await page.getByRole('tab', { name: /To redeem/ }).click();
    await shot(page, '31-positions-redeem');
    await page.getByRole('tab', { name: /Resolved/ }).click();
    await shot(page, '32-positions-resolved');
  });

  test('radar explorer and track record', async ({ page, wallet }) => {
    void wallet;
    await connectWallet(page, '/radar');
    await expect(page.getByRole('tab', { name: /Explorer/i }).first()).toBeVisible();
    await page.waitForTimeout(1500);
    await shot(page, '40-radar-explorer');
    await page.goto('/radar?view=record');
    await expect(page.getByText(/track record/i).first()).toBeVisible();
    await page.waitForTimeout(600);
    await shot(page, '41-radar-track-record');
    await mockConfig({ trackBuilding: true });
    await page.goto('/radar?view=record');
    await expect(page.getByText(/building/i).first()).toBeVisible();
    await shot(page, '42-radar-track-record-building');
  });
});
