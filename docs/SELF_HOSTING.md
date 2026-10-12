# Self-hosting Groundgraph

The whole stack runs on one machine with Docker Compose: Postgres 16, Redis, the API, indexer, keeper, scorer, the web app and a Caddy reverse proxy.
No hosting provider, no paid service, no card. The only outside dependencies are the public Solana devnet RPC and the Pyth price feeds on devnet.

## Requirements

- Docker with Compose v2 (Docker Desktop on Windows or macOS, Docker Engine on Linux). About 4 GB of free RAM and 6 GB of disk for the images.
- Node 22 only for the one helper script `scripts/make-env.mjs` (it has no dependencies).
- The devnet keys, delivered separately from the repository: `keeper.json` and `faucet.json` go into a `.keys/` folder at the repo root.
  `.keys/` is git-ignored. Never commit it.

## Steps

```bash
# from the repository root
mkdir -p .keys                       # copy keeper.json and faucet.json in
node scripts/make-env.mjs            # writes .env: program ID, mint, random SESSION_SECRET and POSTGRES_PASSWORD, DEMO_MODE=true
docker compose up -d --build         # first build takes several minutes
docker compose ps                    # every service should become healthy or running
```

Open `http://localhost:8080`. Check the backend:

```bash
curl http://localhost:8080/api/health        # { ok, db, redis, rpc, indexerLagSlots, keeper, demoMode }
docker compose logs -f keeper indexer        # follow settlement and indexing
```

Only the proxy is published, and by default only on `127.0.0.1`. Postgres, Redis and the metrics ports stay on the private compose network.

## Configuration that matters

All values live in `.env` (see `.env.example` for the full list and `services/README.md` for every service variable).

| Variable | Purpose |
|---|---|
| `PUBLIC_URL` | The origin users open in the browser. CORS, the CSRF origin check and the Sign-In With Solana domain are pinned to it. Default `http://localhost:8080`. |
| `COOKIE_SECURE` | Set `true` when `PUBLIC_URL` is https. |
| `PROXY_BIND` / `PROXY_PORT` | Where the proxy listens. Use `0.0.0.0` to reach it from your LAN. |
| `DEMO_MODE` | `true` shows labelled synthetic radar data (flagged wallets, graph, track record). Markets, prices and trades are always real devnet data. |
| `SCORER_SOURCE` | `synthetic` (needs `DEMO_MODE=true`) or `helius` (needs `HELIUS_API_KEY`, free tier, no card, reads real wallets). |
| `PYTH_API_KEY` | Recommended. Pyth Hermes needs a key (free trial at https://pythdata.app/signup, sent as a Bearer token). With it the keeper settles, at the exact settlement time, every asset the key is granted (a trial key may cover only some feeds: the one used for the demo covered SOL, ETH and BTC, and the keeper logs one warning per refused feed and keeps using the push feed for its prices). Without it only the on-chain devnet push feeds are available (SOL and ETH), which update irregularly and must land inside the 60 second window after settlement time, so most markets end up voided one hour later and redeem at $0.50. |
| `HELIUS_API_KEY` | Optional. Faster indexing and historical backfill for the scorer. |
| `BLOCKED_COUNTRIES` | Comma-separated ISO codes refused for buying and creating. The code default is `US`; `scripts/make-env.mjs` writes `CU,IR,KP,SY` for the devnet demo because test USDC has no value. The check reads country headers from a CDN or tunnel (Cloudflare adds `CF-IPCountry`); with none in front it does nothing. |
| `KEEPER_MIN_SOL` | The keeper wallet only pays transaction fees. The default alert threshold is 0.05 SOL in the generated `.env`. |

Changing `PUBLIC_URL`, `PROGRAM_ID` or `USDC_MINT` needs a rebuild of the web image because Next.js inlines `NEXT_PUBLIC_*` values at build time:
`docker compose up -d --build web api`.

## Making it reachable from the internet

Keep Docker running and put any transport in front of port 8080. The tunnel only carries traffic; no data is stored there.

1. **Cloudflare quick tunnel** (free, no account needed for a temporary URL): `cloudflared tunnel --url http://localhost:8080`.
   It prints an `https://<random>.trycloudflare.com` URL. Put that URL in `PUBLIC_URL`, set `COOKIE_SECURE=true`, then run `docker compose up -d --build web api`.
   The URL changes every time you restart the tunnel, so update `PUBLIC_URL` again when it does.
2. **Your own domain**: forward a port on your router, point a DNS record at your IP, and replace `:80` in `infra/Caddyfile` with your domain name.
   Caddy then obtains a Let's Encrypt certificate by itself (remove `auto_https off`, publish ports 80 and 443).
3. **Tailscale Funnel** or any similar free tunnel works the same way as option 1.

Wallets need `https` for some mobile in-app browsers, so prefer an https URL for demos on a phone.

## Operations

```bash
docker compose logs -f api                 # structured JSON logs per service
docker compose restart keeper              # restart one service
docker compose exec postgres pg_dump -U groundgraph groundgraph > backup.sql
docker compose down                        # stop; data stays in the named volumes
docker compose down -v                     # stop and delete all data
```

Health endpoints (inside the compose network): API `/health`, indexer `:9102/healthz`, keeper `:9101/healthz`, Prometheus text on `/metrics` of each.

## Troubleshooting

- **Markets list is empty:** the indexer is still walking program history. Watch `docker compose logs indexer`; the public devnet RPC rate-limits, so a backfill can take a few minutes.
- **A market did not settle:** check the keeper log for `settle-unavailable`. Without `PYTH_API_KEY` the keeper depends on a devnet push feed update landing within 60 seconds after settlement time, and for assets other than SOL and ETH it has no source at all; the market is then voided after one hour and every share redeems at $0.50. Set `PYTH_API_KEY` in `.env` and run `docker compose up -d keeper`.
- **Sign-in fails with an origin error:** `PUBLIC_URL` must match the address in the browser bar exactly, including the scheme and port.
- **Keeper alert about low SOL:** send devnet SOL to the keeper address printed in its log start-up line (https://faucet.solana.com).
- **No Docker?** Run the services directly with pnpm; see the "Develop without Docker" section of the README.
