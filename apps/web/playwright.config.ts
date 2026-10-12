import { defineConfig, devices } from '@playwright/test';

/**
 * End to end tests run against a production build of the app talking to the mock API (mock-api/server.ts).
 *   pnpm --filter @groundgraph/web build:e2e   (once, never at the same time as the tests: 2 CPUs)
 *   pnpm --filter @groundgraph/web e2e
 * Browsers come from PLAYWRIGHT_BROWSERS_PATH (/opt/pw-browsers); nothing is downloaded.
 */
const WEB = 3100;
const MOCK = 4100;
const REAL = !!process.env.REAL_API;
// The installed browser build (chromium-1194) is older than the one this Playwright release asks for, and browsers
// cannot be downloaded here, so point at the installed binary. Override with PW_CHROMIUM.
const CHROMIUM = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const launchOptions = { executablePath: CHROMIUM, args: ['--no-sandbox', '--disable-dev-shm-usage'] };

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.(e2e|shots|real)\.ts/,
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { baseURL: `http://localhost:${WEB}`, launchOptions, trace: 'retain-on-failure', screenshot: 'only-on-failure', actionTimeout: 12_000, navigationTimeout: 30_000 },
  webServer: REAL
    ? undefined
    : [
        { command: 'npx tsx mock-api/server.ts', url: `http://localhost:${MOCK}/health`, env: { MOCK_PORT: String(MOCK) }, reuseExistingServer: !process.env.CI, timeout: 60_000 },
        {
          command: `npx next start --port ${WEB}`,
          url: `http://localhost:${WEB}`,
          env: { NEXT_DIST_DIR: '.next-e2e', BLOCKED_COUNTRIES: 'US', PORT: String(WEB) },
          reuseExistingServer: !process.env.CI,
          timeout: 90_000,
        },
      ],
  projects: [
    { name: 'e2e', testMatch: /.*\.e2e\.ts/, testIgnore: /responsive\.e2e\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', testMatch: /responsive\.e2e\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
    { name: 'tablet', testMatch: /responsive\.e2e\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 834, height: 1112 }, hasTouch: true } },
    { name: 'screens-desktop', testMatch: /screens\.shots\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'screens-tablet', testMatch: /screens\.shots\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 834, height: 1112 }, hasTouch: true } },
    { name: 'screens-mobile', testMatch: /screens\.shots\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
    { name: 'real', testMatch: /.*\.real\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, baseURL: process.env.REAL_WEB_URL || 'http://localhost:3000' } },
  ],
});
