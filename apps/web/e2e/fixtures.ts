import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { createSignInMessageText, bytesToBase64, base64ToBytes } from '../src/lib/siws';
import nacl from 'tweetnacl';

export const MOCK = 'http://localhost:4100';
export { expect };

/* ------------------------------ mock API test controls ------------------------------ */

export async function mockPost(path: string, body: unknown = {}): Promise<unknown> {
  const res = await fetch(`${MOCK}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`mock ${path} -> ${res.status}`);
  return res.json();
}
export const mockConfig = (patch: Record<string, unknown>) => mockPost('/__mock/config', patch);
export const mockReset = () => mockPost('/__mock/reset');
export const mockBalance = (wallet: string, usdc: number) => mockPost('/__mock/balance', { wallet, amount: String(Math.round(usdc * 1e6)) });
export const mockSettle = (marketId: string, outcome?: 'above' | 'below') => mockPost('/__mock/settle', { marketId, outcome });
export async function mockGet<T>(path: string): Promise<T> {
  const res = await fetch(`${MOCK}${path}`);
  if (!res.ok) throw new Error(`mock ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

/* ------------------------------ fake Wallet Standard wallet ------------------------------ */

const keypair = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256));
export const WALLET_ADDRESS = keypair.publicKey.toBase58();
export const WALLET_NAME = 'E2E Wallet';
export const OTHER_ADDRESS = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => (i * 5 + 11) % 256)).publicKey.toBase58();

export interface WalletControl {
  /** The next signTransaction call throws a user rejection. */
  rejectNext(): void;
  signedTx: number;
}

/**
 * Registers a Wallet Standard wallet in the page before the app boots. Keys stay in Node: the page calls back
 * into exposed bindings for solana:signIn and solana:signTransaction. Only signTransaction is offered (no
 * signAndSendTransaction), so the app broadcasts through the stubbed RPC like it does with most wallets.
 */
export async function installWallet(context: BrowserContext): Promise<WalletControl> {
  const control = { reject: false, signedTx: 0 };
  await context.exposeBinding('__ggSignIn', (_src, input: Record<string, unknown>) => {
    const resources = (input.resources as string[] | undefined) ?? [];
    const msg = createSignInMessageText(
      {
        nonce: String(input.nonce),
        issuedAt: String(input.issuedAt),
        expirationTime: String(input.expirationTime),
        domain: String(input.domain),
        uri: String(input.uri),
        statement: String(input.statement ?? ''),
        tosVersion: (resources.find((r) => r.startsWith('tos:')) ?? 'tos:').slice(4),
        chainId: `solana:${String(input.chainId)}`,
      },
      WALLET_ADDRESS,
    );
    const bytes = new TextEncoder().encode(msg);
    return { signedMessage: bytesToBase64(bytes), signature: bytesToBase64(nacl.sign.detached(bytes, keypair.secretKey)) };
  });
  await context.exposeBinding('__ggSignTx', (_src, b64: string) => {
    if (control.reject) {
      control.reject = false;
      throw new Error('User rejected the request.');
    }
    const tx = VersionedTransaction.deserialize(base64ToBytes(b64));
    tx.sign([keypair]);
    control.signedTx++;
    return bytesToBase64(tx.serialize());
  });
  await context.addInitScript(
    ({ address, publicKey, name }) => {
      const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      const bytesToB64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
      const chains = ['solana:devnet', 'solana:mainnet', 'solana:testnet'];
      const account = { address, publicKey: new Uint8Array(publicKey), chains, features: ['solana:signIn', 'solana:signTransaction'], label: name };
      const listeners = new Set<(p: unknown) => void>();
      let connected = false;
      const emit = () => listeners.forEach((l) => l({ accounts: connected ? [account] : [] }));
      const w = window as unknown as Record<string, (...a: unknown[]) => Promise<never>>;
      const wallet = {
        version: '1.0.0',
        name,
        icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iOCIgZmlsbD0iIzlCNkJGRiIvPjwvc3ZnPg==',
        chains,
        get accounts() {
          return connected ? [account] : [];
        },
        features: {
          'standard:connect': {
            version: '1.0.0',
            connect: async () => {
              connected = true;
              emit();
              return { accounts: [account] };
            },
          },
          'standard:disconnect': {
            version: '1.0.0',
            disconnect: async () => {
              connected = false;
              emit();
            },
          },
          'standard:events': {
            version: '1.0.0',
            on: (_e: string, l: (p: unknown) => void) => {
              listeners.add(l);
              return () => listeners.delete(l);
            },
          },
          'solana:signIn': {
            version: '1.0.0',
            signIn: async (...inputs: Record<string, unknown>[]) => {
              const out = [];
              for (const input of inputs) {
                const r = (await (w.__ggSignIn as unknown as (i: unknown) => Promise<{ signedMessage: string; signature: string }>)(input));
                out.push({ account, signedMessage: b64ToBytes(r.signedMessage), signature: b64ToBytes(r.signature) });
              }
              return out;
            },
          },
          'solana:signTransaction': {
            version: '1.0.0',
            supportedTransactionVersions: ['legacy', 0],
            signTransaction: async (...inputs: { account: unknown; transaction: Uint8Array }[]) => {
              const out = [];
              for (const i of inputs) {
                const signed = await (w.__ggSignTx as unknown as (b: string) => Promise<string>)(bytesToB64(i.transaction));
                out.push({ signedTransaction: b64ToBytes(signed) });
              }
              return out;
            },
          },
        },
      };
      const register = ({ register }: { register: (w: unknown) => void }) => register(wallet);
      window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
      window.addEventListener('wallet-standard:app-ready', (e) => register((e as CustomEvent).detail));
    },
    { address: WALLET_ADDRESS, publicKey: Array.from(keypair.publicKey.toBytes()), name: WALLET_NAME },
  );
  return {
    rejectNext: () => {
      control.reject = true;
    },
    get signedTx() {
      return control.signedTx;
    },
  };
}

/* ------------------------------ test fixture ------------------------------ */

export const test = base.extend<{ wallet: WalletControl }>({
  wallet: async ({ context }, use) => {
    await mockReset();
    await mockConfig({ rpc: 'normal', failNext: null, geoBlockTx: false, trackBuilding: false, latencyMs: 0, wsLagMs: 0 });
    const w = await installWallet(context);
    await use(w);
  },
});

/** Connect the fake wallet through the real UI: wallet list, Terms, SIWS. Lands wherever the app sends a fresh session. */
export async function connectWallet(page: Page, next = '/') {
  await page.goto(`/?connect=1&next=${encodeURIComponent(next)}`);
  const dialog = page.getByRole('dialog', { name: 'Connect a wallet' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: new RegExp(WALLET_NAME) }).click();
  await acceptTerms(page);
}

export async function acceptTerms(page: Page) {
  const legal = page.getByRole('dialog').filter({ has: page.getByRole('checkbox') });
  await expect(legal).toBeVisible();
  await legal.getByText(/I am 18 or older/).click();
  await legal.getByRole('button', { name: /accept/i }).click();
}

export async function viewOnly(page: Page, address = OTHER_ADDRESS, next = '/') {
  await page.goto(`/?connect=1&next=${encodeURIComponent(next)}`);
  const dialog = page.getByRole('dialog', { name: 'Connect a wallet' });
  await dialog.getByLabel('Solana wallet address').fill(address);
  await dialog.getByRole('button', { name: /continue in view-only/i }).click();
}

export const UI_ERRORS: string[] = [];
export function watchConsole(page: Page) {
  page.on('pageerror', (e) => UI_ERRORS.push(`pageerror: ${e.message}`));
}

/* ------------------------------ data helpers ------------------------------ */

import type { MarketDetail, MarketSummary, Paged } from '@groundgraph/sdk/api-types';

export async function listMarkets(status = 'open'): Promise<MarketSummary[]> {
  return (await mockGet<Paged<MarketSummary>>(`/markets?status=${status}&limit=100`)).items;
}
export const marketDetail = (id: string) => mockGet<MarketDetail>(`/markets/${id}`);

/** First open market with a fresh oracle and a ready radar. */
export async function tradableMarket(): Promise<MarketSummary> {
  for (const m of await listMarkets('open')) {
    const d = await marketDetail(m.id);
    if (!d.oracle.stale && m.radar.state === 'ready') return m;
  }
  throw new Error('no tradable market in the mock');
}

export async function staleMarket(): Promise<MarketSummary | null> {
  for (const m of await listMarkets('open')) if ((await marketDetail(m.id)).oracle.stale) return m;
  return null;
}

/** Wide screens show the trade panel inline, phones open it as a sheet from the bottom bar. */
export async function openTradePanel(page: Page, side: 'above' | 'below' = 'above') {
  if ((page.viewportSize()?.width ?? 1440) < 760) await page.getByRole('button', { name: new RegExp(`^Buy ${side.toUpperCase()}`) }).first().click();
}

export async function noHorizontalScroll(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over, 'page scrolls sideways').toBeLessThanOrEqual(1);
}
