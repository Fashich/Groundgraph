# @groundgraph/web

The Groundgraph web app: ABOVE / BELOW price markets and the smart money radar on Solana devnet.
Next.js 16 (App Router) + React 19 + TypeScript (strict) + Tailwind v4, TanStack Query, Zustand, wallet-adapter
(Wallet Standard auto-detect, Sign-In With Solana), `@solana/web3.js` v1. Design tokens and shared components live in
`packages/ui`; request and response types come from `@groundgraph/sdk/api-types`.

Phase 1 screens: landing, markets list, market detail with quote and trade, create (Close kind, Touch is shown as
"coming soon"), positions (open, to redeem, resolved; redeem and merge), radar (explorer and track record), legal
pages, region-blocked page. Authentication is wallet only: a signed SIWS message creates a signing session, a pasted
address creates a read-only view session. The app is non-custodial: it builds nothing itself, the API returns an
unsigned transaction, the wallet signs, the browser broadcasts and polls for confirmation.

## Run it

From the repository root (`pnpm install` once, installs go through `flock /tmp/gg-pnpm.lock` on the shared build box).

```bash
# 1. Against the mock API (no database, no chain). Mock on :4000, web on :3000.
pnpm --filter @groundgraph/web dev:mock

# 2. Against the real API on :8787 (start it first, see services/README.md and scripts/dev-db.sh)
cp apps/web/.env.example apps/web/.env.local   # then edit
pnpm --filter @groundgraph/web dev

# 3. Production build and server
pnpm --filter @groundgraph/web build
pnpm --filter @groundgraph/web start            # next start --port 3000
```

Browser calls go to `NEXT_PUBLIC_API_URL` (default `/api`, a same-origin Next rewrite to `API_ORIGIN`). Prices and
oracle data reach the browser only through the Groundgraph API and its WebSocket; the app never calls Pyth Hermes
directly.

## Environment variables

Everything `NEXT_PUBLIC_*` is inlined at build time. `API_ORIGIN` is also read at build time (the rewrites are
resolved by `next build`). `BLOCKED_COUNTRIES` is read at run time. No secret belongs in this app.

| Variable | Default | Meaning |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | `/api` | Base path of the API as the browser sees it |
| `NEXT_PUBLIC_WS_URL` | derived | WebSocket URL. Empty: `ws://localhost:8787/ws` in dev, `wss://<host>/ws` in production. Rewrites do not proxy upgrades, so the reverse proxy must forward `/ws` |
| `NEXT_PUBLIC_SOLANA_CLUSTER` | `devnet` | Cluster label and explorer links |
| `NEXT_PUBLIC_RPC_URL` | `https://api.devnet.solana.com` | RPC used to broadcast signed transactions and poll their status |
| `NEXT_PUBLIC_USDC_MINT` | empty | Test USDC mint (6 decimals) used to read the wallet balance |
| `NEXT_PUBLIC_PROGRAM_ID` | empty | Program id, for display and links |
| `NEXT_PUBLIC_TOS_VERSION` | `2026-10-01` | Terms version the app expects the API session to have accepted |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3000` | Public origin for absolute Open Graph URLs |
| `API_ORIGIN` | `http://localhost:8787` | Origin that `/api/*` and `/og/*` are proxied to (build time) |
| `BLOCKED_COUNTRIES` | `US,CU,IR,KP,SY` | ISO codes blocked by `src/proxy.ts` (run time). Read from `cf-ipcountry` or `x-vercel-ip-country`; allowed when no header is present |
| `NEXT_DIST_DIR` | `.next` | Build output folder (the e2e build uses `.next-e2e` so it never clobbers a dev build) |

## Tests

| Command | What it runs |
| --- | --- |
| `pnpm --filter @groundgraph/web typecheck` | `tsc --noEmit` over src, tests, e2e and the mock API |
| `pnpm --filter @groundgraph/web lint` | Terminology and copy lint (`scripts/copy-lint.mjs`): no em dashes, no banned words |
| `pnpm --filter @groundgraph/web test` | Vitest: math, formatting, validation, SIWS message bytes, transaction building against the real `@groundgraph/sdk`, live-data reducers, position logic, legal docs, the copy lint |
| `pnpm --filter @groundgraph/web test:e2e` | Builds `.next-e2e`, then Playwright at desktop (1440), mobile (390) and tablet (834) |
| `pnpm --filter @groundgraph/web screenshots` | Builds, then writes every screen at the three widths to `e2e-screenshots/` |
| `pnpm --filter @groundgraph/web e2e:real` | Smoke against a running real stack (`REAL_WEB_URL`, default `http://localhost:3000`) |

The machine has 2 CPUs: never run `next build` and Playwright at the same time. Playwright uses the browser already
installed at `/opt/pw-browsers` (override with `PW_CHROMIUM`); nothing is downloaded. Playwright starts the mock API
on `:4100` and `next start` on `:3100` itself, so build first (`pnpm run build:e2e`) and then `pnpm run e2e`.

The e2e suite drives a fake Wallet Standard wallet (`solana:signIn` and `solana:signTransaction`; keys stay in the
Node process) against a stubbed RPC served by the mock API. Covered: connect with Terms and SIWS, paste a view-only
address, markets filters and live count, detail quote and trade (buy, sell, wallet rejection, slippage with a one
click retry, stale oracle, region block, daily limit, break), create (three steps, publish, rejection, view-only),
positions (redeem, merge, live settle, void at $0.50, view-only), geofence, share dialog, legal and not-found pages,
and a mobile and tablet smoke (no horizontal scroll, navigation, trade flow).

## Mock API

`mock-api/server.ts` implements the contract in `packages/sdk/src/api-types.ts` with deterministic synthetic data,
the same error envelope, a WebSocket hub and a stub JSON-RPC at `/rpc`. Test controls (never present in the real API):

- `POST /__mock/config` `{ wsPush, wsLagMs, rpc: 'normal'|'slow'|'expire', failNext, trackBuilding, tosVersion, geoBlockTx, latencyMs }`
- `POST /__mock/reset`, `POST /__mock/tick`, `POST /__mock/balance { wallet, amount }`
- `POST /__mock/settle { marketId, outcome? }` settles ABOVE or BELOW, or voids when no outcome is given, and pushes the `me` event
- `GET /__mock/state`

Honesty rule: the "Demo data" label appears only where the API reports `dataSource === 'demo-synthetic'`.

## Layout

```
src/app/            routes: (app)/markets, markets/[id], create, positions, radar; legal/[doc]; blocked; not-found
src/proxy.ts        geofence (closes /markets, /create, /radar for blocked countries; positions, single market pages and legal stay reachable so holders can exit)
src/components/     shell, markets, market, create, positions, radar, wallet, common
src/lib/            api client, tx runner, ws client and live reducers, SIWS, formatting, math, validation
content/legal/      terms.md, privacy.md, risk.md (rendered at /legal/[doc], shown in the Terms modal)
mock-api/           mock API for development and e2e
tests/  e2e/        Vitest and Playwright
```

App routes are gated client side by `RequireSession`: without a session the visitor is sent to `/?connect=1&next=...`.
The landing page, legal pages, the blocked page and not-found are public.

## Docker

`infra/docker/Dockerfile.web` builds the standalone server from the repository root. See the comments at its top for
the build arguments (public configuration and `API_ORIGIN`) and the one run-time variable.

```bash
docker build -f infra/docker/Dockerfile.web -t groundgraph-web --build-arg API_ORIGIN=http://api:8787 .
docker run -p 3000:3000 -e BLOCKED_COUNTRIES=US,CU,IR,KP,SY groundgraph-web
```
