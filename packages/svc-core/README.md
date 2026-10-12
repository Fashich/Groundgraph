# @groundgraph/svc-core

Code shared by the API, indexer and keeper. Nothing here starts a process.

| Module | Contents |
|---|---|
| `env.ts` | `parseEnv`, `commonEnv` (the variables every service reads), `boolEnv`, `intEnv`, `optStr`, `optUrl` |
| `log.ts`, `metrics.ts` | pino JSON logger factory; prom-client registry and `startMetricsServer` (`/metrics` with optional bearer token, `/healthz`) |
| `redis.ts` | ioredis factory, `RK` (cache keys) and `CH` (pub/sub channels), heartbeat helpers |
| `chain.ts` | The only place services import `@groundgraph/sdk` through: re-exports quote and simulation math, PDAs, account and event codecs, instruction builders; plus tolerant normalizers (`normalizeMarket`, `normalizeConfig`, `normalizeEvent`) and the asset allow-list (`listAssetFeeds`, `assetBySymbol`, `assetByFeedId`) |
| `chain-reader.ts` | `ChainReader` interface and `RpcChainReader` (market, config, feed and token balance reads, priority fees, transaction simulation); the API never sends transactions, wallets do |
| `pyth.ts` | push feed account decoding and addresses (`pushFeedAddress`, `decodePriceUpdateV2`, `PushFeedReader`), `HermesClient`, `OraclePriceService` (latest price per feed with a verification level), `OracleSnapshot` |
| `vol.ts` | 30-day realized volatility from daily closes (Pyth Benchmarks, Coinbase, Kraken, Binance, CoinGecko in that order) and fair value formulas for close and touch markets |
| `keypair.ts` | load a keypair from a file path or an inline JSON array (never logs the secret) |
| `units.ts` | base-unit helpers (USDC has 6 decimals; shares are base-unit strings or bigint) |

```bash
pnpm --filter @groundgraph/svc-core test     # units, keypair loading, Pyth decoding, SDK adapter, volatility, Redis helpers
```
