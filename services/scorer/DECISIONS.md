# Scorer decisions

Each entry: what was decided, why, and what it costs. Numbers quoted here come from the synthetic run in
`MODEL_CARD.md` (demo data, not mainnet).

## ADR-001: Hand-written GraphSAGE on torch, no PyG

* Decision: a two layer GraphSAGE with a mean aggregator (hidden size 64, dropout 0.2) written directly on
  `torch.sparse.mm`, trained full batch with Adam and a masked, class weighted binary cross entropy.
* Why: PyTorch Geometric brings compiled extensions (`torch-scatter`, `torch-sparse`) that are awkward to install on a
  CPU only image. A sparse matrix product is all a mean aggregator needs, the graph has a few thousand
  nodes, and the model stays readable and testable (shapes, determinism and isolation of the self vs neighbour paths are
  unit tests).
* Cost: no neighbour sampling. Full batch is fine up to the low hundred thousands of nodes on 8 GB, which is far above
  the planned wallet universe.

## ADR-002: The graph model is folded into the Centrality row, capped at 40%

* Decision: the displayed score is the sum of five rows (Whale overlap, Entry timing, Hit rate, Centrality, Lead time).
  The GraphSAGE output does not get a sixth row. Its cross sectional percentile is added to the Centrality row, which
  the UI labels "Centrality (graph model)".
* Why: the product promise is that every point of the score can be traced to a named, human readable reason. A black box
  row would break that, and centrality is the one concept the graph model really refines.
* Guard rails: the head is a monotone linear model with non negative weights, each heuristic weight is at least 0.08,
  and the graph share of the total weight is capped at 40%. A wallet's score therefore stays mostly explained by the four
  heuristics.
* Cost: the deployed score gives up some accuracy against the raw network. Held out on synthetic data: deployed ROC AUC
  0.849 against 0.878 for the GraphSAGE logit alone. We report both on the model card.

## ADR-003: Wallet behaviour becomes positions on virtual close markets

* Decision: swap trades of six allow-listed assets (SOL, BTC, ETH, JUP, WIF, BONK) are mapped to virtual close markets
  (horizons 21, 30 and 45 days, one opened every 120 h, strike a rounded level within 6% of the spot price at the open). A buy is an ABOVE position and a sell
  a BELOW position. Fair value uses the digital option formula N(d2) with trailing 30 day volatility, clamped to
  [0.02, 0.98].
* Why: real wallets have no positions in Groundgraph markets yet, but they do swap these assets, and a swap is a view on
  the direction of the price. Virtual markets give every feature (entry timing, hit rate, lead time, PnL labels) a
  well defined meaning and an outcome.
* Entry price is the market price at the wallet's first trade in that market. Entries are the last 14 in a 60 day lookback
  whose 24 h look-ahead window has fully elapsed before `as_of`.
* Cost: virtual prices are model prices, so the Track record compares the radar with a volatility model, not with a
  liquid market. The model card and the UI say so.

## ADR-004: Strict point in time features, labels strictly after the cutoff

* Decision: every window edge is `[as_of - 30d, as_of)`. Labels use positions opened in `(T, T + 14d]`. The temporal split
  has an embargo of 14 days between the last training label and the first test cutoff, a label needs
  `label window + longest market` to be final, and cross validation groups wallets by non hub funder.
* Why: the common failure of wallet scoring is look-ahead leakage. `Dataset.truncate(t)` rebuilds the whole dataset
  with only data before `t`, and tests assert features computed on the full dataset equal features computed on the
  truncated one, and that scrambling the future changes nothing.

## ADR-005: Baseline relative inputs for the head, and a weight floor

* Decision: head inputs are measured against the 70th percentile of active wallets, so the "average" wallet contributes
  zero points and only above-baseline behaviour earns points. Hit rate and entry timing are shrunk with
  `(k + 1.5) / (n + 3)`.
* Why: without a baseline, a wallet with no evidence gets a mid score from priors. Shrinkage keeps small samples near
  0.5 and the baseline stops that from becoming points.
* Scale: points are scaled by `min(99 / q99, 70 / cut)` and rounded by the largest remainder method so the integer
  contributions sum exactly to the integer score.

## ADR-006: Smart money flag threshold is F1 optimal under a 15% flagged-share cap

* Decision: the flag threshold maximises F1 on out of fold training predictions, searched only among cuts that flag at
  most 15% of active wallets. A wallet also needs at least 5 eligible entries and 3 resolved positions. "Top" is the
  0.85 quantile of flagged training scores, clamped to `[threshold + 3, 98]`.
* Why: plain F1 flagged 82 of 326 synthetic wallets, which is too many to call smart money, and F0.5 flagged 20 and no
  sybil member. The cap is a product choice (a radar needs several flagged wallets per market, but a leaderboard of a
  quarter of all wallets means nothing).
* Result on synthetic data: threshold 55, 47 flagged and 3 top of 326.

## ADR-007: Calibration is adopted only if it demonstrably helps

* Decision: an isotonic calibrator maps raw radar probability to the displayed `p_above`, but only if its five fold
  out of fold Brier score beats the raw radar by more than 1e-4 (and there are at least 60 markets). Otherwise the
  identity map is used. All reported numbers are cross fitted.
* Why: the first synthetic run showed a fitted calibrator that made things worse (0.0540 cross fitted against 0.0488
  raw). Shipping a calibrator because "calibration is good" would hide that.
* Reporting: Brier radar vs market with a paired bootstrap 95% interval of the difference, 10 bin calibration table, ECE
  for both, and the contested subset (market price between 0.05 and 0.95). ECE is flagged as imprecise when most prices
  sit near 0 or 1.

## ADR-008: Realised edge is withheld below 10 hypothetical trades

* Decision: the track record reports the average realised edge (net of an assumed 1% fee) only when at least 10
  hypothetical positions had a radar edge above 3 cents.
* Why: an earlier run printed 43 cents from two trades. It is a true number and a misleading one.

## ADR-009: The radar copies `packages/sdk/src/radar.ts` exactly

* Decision: `scorer/radar.py` follows the SDK term by term:
  `w = sqrt(max(0, usd)) * (0.4 + clamp(hit, 0, 1)) * (0.5 if sybil)`, `sy`, `hr`, `sig = (2sy - 1)(2hr - 1)`,
  `p = sigmoid(logit(clamp(pm, 1e-6, 1 - 1e-6)) + 1.4 * n / (n + 6) * sig)`,
  `ci = max(2, round(164 * sqrt(p(1 - p) / (4n + 10))))`, `edge = round(100 * (p - pm))` against the unclamped market
  price with round half up. Fewer than 3 flagged wallets gives the Building state.
* Verification: 74 golden vectors (`tests/radar_vectors.json`) were also run through the real TypeScript function
  (`tests/radar_ts_check.mts`): 0 mismatches, `state`, `n`, `ci` and `edge` exact, `p` within 2e-16 relative.
* Known limit: not bit-identical. V8 and glibc may differ by one ulp in `exp` and `log`, so a rounding tie could in theory
  differ by one point. The Python side is the pipeline's authority for what gets stored; the SDK is what the UI recomputes.
* Pipeline-only extra: a market is also treated as Building when fewer than 10 scored trades back it. This does not
  change the formula and is documented on the model card.

## ADR-010: Sybil rule and the 0.5 weight cap

* Decision: at least 3 flagged wallets with the same non hub funder (fan out of at most 40) within 2 hops form a sybil
  cluster. `sybil_cluster_id = crc32(funder) & 0x7fffffff`. Members keep their score, but the radar weighs them x0.5.
* Why: several wallets funded by one source that copy one leader are one opinion, not several. A cap is gentler than
  dropping them.
* Cost: purely graph based. A sybil operator who funds through a chain longer than 2 hops, or through an exchange hub,
  is not caught. The model card lists this.

## ADR-011: Louvain with a seed, names from behaviour prototypes, stable ids

* Decision: `python-louvain` with `random_state = seed`, nodes processed in sorted order. Cluster names come from the
  nearest of six behaviour prototypes (ordinal suffixes when two clusters share a name, such as "Treasury rotators II").
  Cluster ids are carried across runs by best Jaccard overlap (at least 0.3) so the UI colours do not flip at every run.
* Why: determinism is tested, including across processes with different `PYTHONHASHSEED`.

## ADR-012: Layout is Fibonacci-sphere centres plus Fruchterman-Reingold per cluster

* Decision: cluster centres are placed on a Fibonacci sphere, nodes inside a cluster by a seeded Fruchterman-Reingold
  layout, all clipped to `[-1.6, 1.6]`. Wallets with a hidden label (`label_hidden`) are excluded from the radar and
  from the layout, and `label_hidden` is never written by the scorer.

## ADR-013: Source specific parameters for a 120 day backfill

* Decision: `Params.for_source('helius' | 'onchain')` uses shorter horizons (7, 10 and 14 days), markets opened every
  48 h with at least 48 h remaining, a 7 day label window, 7 day embargo and 21 day test period. On 120 days this gives a
  valid split with 3 training and 22 test cutoffs.
* Why: the synthetic defaults need about 365 days. Without this the real source could not form a valid split at all.
* Cost: 3 training cutoffs is thin. The model card will show wide intervals on real data. More history is the fix, not
  more tuning.

## ADR-014: Helius design (untested live)

* Decision: Enhanced transactions API (`/v0/addresses/{addr}/transactions`) for swaps and transfers, JSON-RPC for
  holders and balances, Pyth Benchmarks TradingView shim for daily closed price bars. The wallet universe is seeded from
  swaps of each allow-listed mint plus the largest holders.
* Swaps are stored in `wallet_edges` as edges to pseudo nodes `dex:<ASSET>`. SOL transfers (only from non-swap
  transactions) are wallet to wallet edges. Funding source is the first inbound transfer of at least 0.01 SOL inside the
  window. A balance proxy is reconstructed backwards from SOL flows so whales can be ranked without a historical balance
  API.
* Operations: token bucket rate limiter, retry with `Retry-After` on 408/425/429/5xx and network errors, a request budget
  per run (`HELIUS_MAX_REQUESTS_PER_RUN`), per wallet checkpoints in `indexer_state` so a run can stop and resume, and
  secret redaction in every error string. `build_dataset` refuses to run (with a clear message) on out of sync state
  rather than returning an empty dataset.
* Status: tested with hand-written fixtures and mocked HTTP only. Not verified against live Helius or Pyth.

## ADR-015: Persistence and idempotency

* Decision: model weights, calibrator, run metadata and the model card text are JSON in `indexer_state`. Every table write
  is an upsert on the table's primary key. Batch jobs are guarded by `pg_try_advisory_lock`. No schema change was needed.
* History pruning: after 48 h, `market_radar` keeps one row per hour. `wallet_scores` and `wallet_features` keep every
  row for 14 days and afterwards only the midnight row of each day.
* Why: restarts and two replicas must be safe, and the API reads the latest row per market, so thinning old rows does not
  change what it serves.

## ADR-016: Demo data discipline

* Decision: the synthetic source refuses to start unless `DEMO_MODE=true`, writes every row with
  `data_source = 'demo-synthetic'`, and the model card opens with a banner that the numbers are from demo synthetic data.
  The API only serves such rows in demo mode.
* Synthetic addresses are base58 encodings of 32 random bytes, so they pass the same address validation as real ones.
* A lint test fails the build on em dashes, banned product terms, YES/NO outcome labels and anything that looks like a
  secret in the scorer's files.
