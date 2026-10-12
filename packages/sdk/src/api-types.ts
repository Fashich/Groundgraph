/**
 * Groundgraph API contract (single source of truth for apps/web, services/api, services/scorer outputs).
 *
 * Conventions
 *  - u64 token amounts (USDC and outcome shares, both 6 decimals) travel as DECIMAL STRINGS in base units,
 *    e.g. "12500000" = 12.5. Never as JS numbers.
 *  - Prices and probabilities are JSON numbers in 0..1 (price of 1 ABOVE share in USDC).
 *  - Timestamps are ISO-8601 strings in UTC.
 *  - Market id = market account pubkey (base58). Wallet = base58 pubkey.
 *  - Outcomes are ABOVE / BELOW (lowercase 'above' | 'below' on the wire). Never YES/NO.
 */

export type Side = 'above' | 'below';
export type TradeDir = 'buy' | 'sell';
export type MarketKind = 'close' | 'touch';
export type MarketStatus = 'open' | 'trading_closed' | 'settled' | 'voided';
export type SessionMode = 'sign' | 'view';

export type U64 = string;
export type IsoTime = string;

/* ----------------------------- Markets ----------------------------- */

export interface RadarSummary {
  /** 'building' when fewer than 3 flagged wallets or fewer than 10 scored trades. Show the Building state. */
  state: 'ready' | 'building';
  /** calibrated P(ABOVE), 0..1 */
  p: number | null;
  /** half-width of the confidence interval in percentage points (e.g. 9 => "26% ±9") */
  ci: number | null;
  /** flagged wallets positioned in this market */
  n: number;
  /** edge in cents = round(100 * (p_radar - p_market)) */
  edge: number | null;
  modelVersion: string | null;
  ts: IsoTime | null;
}

export interface OracleInfo {
  feedId: string; // hex
  symbol: string; // e.g. "SOL/USD"
  price: number | null;
  conf: number | null;
  publishTs: IsoTime | null;
  ageSec: number | null;
  stale: boolean; // age > 60s or missing: buys paused, sell/merge still allowed
}

export interface MarketSummary {
  id: string;
  question: string;
  kind: MarketKind;
  direction: 'up' | 'down' | null;
  assetSymbol: string;
  category: string;
  targetPrice: number;
  status: MarketStatus;
  outcome: Side | null;
  /** price of ABOVE in 0..1 and implied probability (same number; BELOW = 1 - priceAbove) */
  priceAbove: number;
  implied: number;
  ch24: number; // change of priceAbove over 24h in percentage points
  spark: number[]; // up to 48 points of priceAbove
  radar: RadarSummary;
  feeBpsNow: number;
  baseFeeBps: number;
  dynamicFee: boolean;
  endsAt: IsoTime; // settle_ts
  tradingEndsAt: IsoTime;
  volume: U64; // total traded USDC
  liquidity: U64; // pool depth in USDC (min(reserveAbove, reserveBelow) based or complete sets, see docs)
  traders: number;
  creator: string;
  isFeatured?: boolean;
}

export interface FlaggedEntry {
  ts: IsoTime;
  wallet: string;
  side: Side;
  priceAtEntry: number;
  usdc: U64;
  score: number;
}

export interface PoolInfo {
  reserveAbove: U64;
  reserveBelow: U64;
  completeSets: U64;
  feePool: U64;
  vault: string;
  aboveMint: string;
  belowMint: string;
  lpMint: string;
}

export interface FairValueInfo {
  spot: number;
  vol: number; // annualized
  pAbove: number;
  ts: IsoTime;
}

export interface MarketDetail extends MarketSummary {
  history: { tf: '1D' | '3D' | '1W' | 'ALL'; points: { ts: IsoTime; priceAbove: number }[] };
  flaggedEntries: FlaggedEntry[];
  fairValue: FairValueInfo | null;
  oracle: OracleInfo;
  rules: { text: string; settleRule: string; oracleFeedId: string };
  pool: PoolInfo;
  feeBreakdown: { baseBps: number; nearBps: number; flowBps: number; totalBps: number; capBps: number };
  settlePrice: number | null;
  settlePublishTs: IsoTime | null;
}

export interface WalletFeatures {
  whaleOverlap: number; // 0..1
  entryTiming: number;
  hitRate: number;
  centrality: number;
  leadTimeMin: number;
  nMarkets: number;
}

/** contributions sum to the displayed score (0..100) */
export interface WalletContributions {
  whaleOverlap: number;
  entryTiming: number;
  hitRate: number;
  centrality: number;
  leadTime: number;
}

export interface MarketWalletRow {
  address: string;
  score: number;
  smart: boolean;
  top: boolean;
  side: Side;
  entryPrice: number;
  usdc: U64;
  features: WalletFeatures;
  sybil: boolean;
}

export interface TradeRow {
  id: string;
  ts: IsoTime;
  wallet: string;
  side: Side;
  dir: TradeDir;
  usdc: U64;
  shares: U64;
  feeUsdc: U64;
  priceAfter: number;
  txSig: string;
  flagged: boolean;
}

export interface Paged<T> {
  items: T[];
  nextCursor: string | null;
}

/* ----------------------------- Quotes and transactions ----------------------------- */

export interface Quote {
  marketId: string;
  side: Side;
  dir: TradeDir;
  /** buy: USDC in. sell: shares in. */
  amountIn: U64;
  /** buy: shares out. sell: USDC out (net of fee). */
  amountOut: U64;
  /** with slippage tolerance applied; pass this as the on-chain min_out */
  minOut: U64;
  slippageBps: number;
  avgPrice: number;
  priceBefore: number;
  priceAfter: number;
  priceImpactBps: number;
  feeBps: number;
  feeUsdc: U64;
  /** buy only: payout if this side settles ($1 per share) */
  settleValue: U64 | null;
  /** UI warnings: 'exceeds_slippage' | 'large_vs_balance' | 'oracle_stale' | 'break_active' | 'daily_limit' */
  warnings: string[];
}

export interface UnsignedTx {
  /** base64 of a serialized, UNSIGNED v0 VersionedTransaction (priority fee + compute budget included) */
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
  summary: string;
  receipt?: Partial<Quote>;
}

export interface BuildTxBase {
  marketId: string;
  slippageBps?: number;
  priorityFeeMicroLamports?: number;
}
export interface BuildBuySellReq extends BuildTxBase {
  side: Side;
  /** buy: usdc base units; sell: shares base units */
  amount: U64;
}
export interface BuildMergeReq extends BuildTxBase {
  amount: U64;
}
export interface BuildRedeemReq extends BuildTxBase {
  side: Side;
  amount: U64;
}
export interface BuildCreateReq {
  assetSymbol: string;
  kind: MarketKind;
  targetPrice: number;
  settleTs: IsoTime;
  baseFeeBps: 50 | 100 | 200;
  dynamicFee: boolean;
  liquidityUsdc: U64;
  /** ABOVE probability in bps (200..9800); omit to seed at the fair value */
  p0Bps?: number;
  question?: string;
}

/* ----------------------------- Auth ----------------------------- */

export interface NonceResp {
  nonce: string;
  issuedAt: IsoTime;
  expirationTime: IsoTime;
  domain: string;
  uri: string;
  statement: string;
  tosVersion: string;
  chainId: string; // e.g. "solana:devnet"
}
export interface VerifyReq {
  wallet: string;
  /** base64 of the signed SIWS message bytes */
  signedMessage: string;
  /** base64 ed25519 signature */
  signature: string;
  walletName?: string;
  tosAccepted: boolean;
}
export interface SessionResp {
  wallet: string;
  mode: SessionMode;
  walletName?: string | null;
  tosVersion: string | null;
  tosAccepted: boolean;
  expiresAt: IsoTime;
}

/* ----------------------------- Radar ----------------------------- */

export interface GraphNode {
  id: number;
  addr: string;
  score: number;
  smart: boolean;
  top: boolean;
  cluster: number;
  pos: [number, number, number];
}
export interface GraphEdge {
  a: number;
  b: number;
  flag: boolean; // true when the link is between flagged wallets
}
export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  asOf: IsoTime | null;
  modelVersion: string | null;
  clusters: { id: number; name: string; size: number }[];
  dataSource: string; // e.g. 'helius-mainnet-backfill', 'demo-synthetic'
}

export interface WalletDetail {
  address: string;
  score: number;
  smart: boolean;
  top: boolean;
  sybil: boolean;
  cluster: { id: number; name: string } | null;
  features: WalletFeatures;
  contributions: WalletContributions;
  reasons: string[];
  tags: string[];
  stats: { markets: number; hitRate: number; medianLeadMin: number; volumeUsd: number };
  openPositions: { marketId: string; question: string; side: Side; shares: U64; entryPrice: number }[];
  asOf: IsoTime;
  modelVersion: string;
  labelHidden: boolean;
}

export interface TrackRecord {
  window: { start: IsoTime; end: IsoTime };
  runAt: IsoTime;
  dataSource: string;
  nMarkets: number;
  brier: { radar: number | null; market: number | null };
  hitRate: { radar: number | null; market: number | null };
  medianLeadMin: number | null;
  edgeRealizedCents: number | null;
  calibration: { bin: number; predicted: number; observed: number; n: number }[];
  leadHistogram: { bucketMin: number; count: number }[];
  rows: { marketId: string; question: string | null; radarT24: number | null; marketT24: number | null; outcome: Side | null; closer: 'radar' | 'market' | 'tie' | null }[];
  modelVersion: string;
  /** honest empty state when no run exists yet */
  state: 'ready' | 'building';
}

/* ----------------------------- Account ----------------------------- */

export interface PositionRow {
  marketId: string;
  question: string;
  side: Side;
  shares: U64;
  avgPrice: number;
  costBasis: U64;
  markPrice: number;
  value: U64;
  pnl: U64;
  status: MarketStatus;
  outcome: Side | null;
  redeemable: U64; // USDC redeemable now
  radar: RadarSummary;
  endsAt: IsoTime;
}
export interface MeResp {
  wallet: string;
  mode: SessionMode;
  walletScore: { score: number; smart: boolean; reasons: string[] } | null;
  settings: UserSettings;
}
export interface UserSettings {
  dailyLimitUsdc: U64 | null;
  breakUntil: IsoTime | null;
  sessionReminder: boolean;
  spentToday: U64;
}
export interface ActivityRow {
  ts: IsoTime;
  type: 'buy' | 'sell' | 'merge' | 'redeem' | 'create' | 'break' | 'limit';
  marketId?: string;
  summary: string;
  txSig?: string;
}

/* ----------------------------- WebSocket ----------------------------- */

/** client -> server */
export type WsClientMsg =
  | { op: 'subscribe'; channels: string[] }
  | { op: 'unsubscribe'; channels: string[] }
  | { op: 'ping' };

/** server -> client. Channels: market:{id}, markets:summary, radar:{id}, oracle:{feed}, me */
export type WsServerMsg =
  | { ch: string; type: 'snapshot' | 'delta'; seq: number; ts: IsoTime; data: unknown }
  | { op: 'pong' }
  | { op: 'error'; message: string };

export interface WsMarketDelta {
  priceAbove: number;
  reserveAbove: U64;
  reserveBelow: U64;
  feeBps: number;
  trade?: TradeRow;
}

/* ----------------------------- Error shape ----------------------------- */

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

/* ----------------------------- Error codes ----------------------------- */

export type ApiErrorCode =
  | 'bad_request'
  | 'unauthorized' // no session
  | 'view_only' // pasted-address session cannot build transactions
  | 'tos_required' // ToS not accepted for the current TOS_VERSION
  | 'break_active' // responsible trading: break blocks buy/create
  | 'daily_limit_exceeded'
  | 'oracle_stale' // buys paused
  | 'market_closed'
  | 'slippage_exceeded' // pre-simulation says min_out cannot be met
  | 'below_min_trade' // < 1 USDC
  | 'insufficient_liquidity'
  | 'not_found'
  | 'rate_limited'
  | 'geo_blocked'
  | 'faucet_unavailable'
  | 'internal';

/* ----------------------------- Route table -----------------------------
 * Base path: /api (reverse proxy) or the API origin directly. JSON in/out. Auth = httpOnly session cookie.
 *
 * Auth
 *   POST /auth/nonce        {wallet}                                -> NonceResp
 *   POST /auth/verify       VerifyReq                               -> SessionResp  (sets cookie, mode=sign)
 *   POST /auth/view         {address}                               -> SessionResp  (mode=view; rejects 0x addresses with a helpful error)
 *   POST /auth/logout                                               -> {ok:true}
 *   GET  /auth/session                                              -> SessionResp | 401
 *   POST /auth/tos          {tosVersion}                            -> SessionResp  (records acceptance for an existing sign session)
 * Markets
 *   GET  /markets?cat&lean&ends&sort&q&watch&status&limit&cursor    -> Paged<MarketSummary>
 *   GET  /markets/:id?tf=1D|3D|1W|ALL                               -> MarketDetail
 *   GET  /markets/:id/wallets                                       -> MarketWalletRow[]
 *   GET  /markets/:id/trades?cursor&limit                           -> Paged<TradeRow>
 *   GET  /markets/:id/quote?side&dir&amount&slippageBps             -> Quote   (math imported from @groundgraph/sdk, identical to the program)
 *   GET  /fair-value?asset&target&settleTs&kind&direction           -> FairValueInfo
 *   GET  /assets                                                    -> {symbol, feedId, price, ageSec}[]   (allow-listed feeds)
 * Transactions (require session mode=sign, ToS accepted; build UNSIGNED v0 txs)
 *   POST /tx/buy | /tx/sell BuildBuySellReq                         -> UnsignedTx
 *   POST /tx/merge          BuildMergeReq                           -> UnsignedTx
 *   POST /tx/redeem         BuildRedeemReq                          -> UnsignedTx
 *   POST /tx/create         BuildCreateReq                          -> UnsignedTx
 * Radar
 *   GET  /radar/wallets?minScore&cluster&crowd                      -> GraphPayload
 *   GET  /wallets/:addr                                             -> WalletDetail | 404
 *   GET  /track-record/latest                                       -> TrackRecord
 * Account (session required)
 *   GET  /me                                                        -> MeResp
 *   GET  /me/positions?tab=open|redeem|resolved                     -> PositionRow[]
 *   GET  /me/activity?cursor                                        -> Paged<ActivityRow>
 *   PUT  /me/settings       {dailyLimitUsdc: U64|null, sessionReminder: boolean} -> UserSettings
 *   POST /me/break          {days: 1|7|30}                          -> UserSettings (a break can only be extended, never shortened)
 *   POST /me/watch/:marketId   (toggle)                             -> {watching: boolean}
 *   POST /me/track/:wallet     (toggle)                             -> {tracking: boolean}
 *   POST /flags/dispute     {message}                               -> {id}
 * Devnet only
 *   POST /faucet/usdc       {wallet}                                -> {txSig, amount}   (mints test USDC, rate limited)
 * Ops
 *   GET  /health                                                    -> {ok, db, redis, rpc, indexerLagSlots, keeper}
 *   POST /webhooks/helius   (optional, header auth)                 -> 204
 * WebSocket  GET /ws   (client sends WsClientMsg, server sends WsServerMsg)
 *   channels: market:{id}, markets:summary, radar:{id}, oracle:{feedId}, me (requires cookie)
 * -------------------------------------------------------------------- */
