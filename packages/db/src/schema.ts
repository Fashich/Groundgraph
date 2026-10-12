/**
 * Drizzle schema. Mirrors packages/db/migrations/*.sql 1:1 (0001_init.sql + 0002_services.sql + 0002_services_indexer.sql).
 * The SQL files are the source of truth; update this file whenever a migration changes a table.
 * numeric columns are strings in JS (never lose precision), timestamptz are Date.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/* ------------------------------ markets and trading ------------------------------ */

export const markets = pgTable(
  'markets',
  {
    id: text('id').primaryKey(),
    creator: text('creator').notNull(),
    kind: text('kind').notNull(),
    direction: text('direction'),
    assetSymbol: text('asset_symbol').notNull(),
    feedId: text('feed_id').notNull(),
    targetPrice: numeric('target_price').notNull(),
    targetExpo: integer('target_expo').notNull(),
    targetRaw: numeric('target_raw').notNull(),
    openTs: tstz('open_ts').notNull(),
    tradingEndTs: tstz('trading_end_ts').notNull(),
    settleTs: tstz('settle_ts').notNull(),
    baseFeeBps: integer('base_fee_bps').notNull(),
    dynamicFee: boolean('dynamic_fee').notNull().default(false),
    question: text('question').notNull(),
    category: text('category').notNull().default('crypto'),
    status: text('status').notNull().default('open'),
    outcome: text('outcome'),
    settlePrice: numeric('settle_price'),
    settlePublishTs: tstz('settle_publish_ts'),
    aboveMint: text('above_mint').notNull(),
    belowMint: text('below_mint').notNull(),
    lpMint: text('lp_mint').notNull(),
    vault: text('vault').notNull(),
    reserveAbove: numeric('reserve_above').notNull().default('0'),
    reserveBelow: numeric('reserve_below').notNull().default('0'),
    completeSets: numeric('complete_sets').notNull().default('0'),
    feePool: numeric('fee_pool').notNull().default('0'),
    hidden: boolean('hidden').notNull().default(false),
    createdTx: text('created_tx'),
    createdAt: tstz('created_at').notNull().default(sql`now()`),
    updatedAt: tstz('updated_at').notNull().default(sql`now()`),
    // 0002
    emaImpactBps: integer('ema_impact_bps').notNull().default(0),
    emaTs: bigint('ema_ts', { mode: 'number' }).notNull().default(0),
    settleExpo: integer('settle_expo'),
    lpClaimRemaining: numeric('lp_claim_remaining'),
    lpSupplyRemaining: numeric('lp_supply_remaining'),
    lastSlot: bigint('last_slot', { mode: 'number' }).notNull().default(0),
    reconciledAt: tstz('reconciled_at'),
    createdSlot: bigint('created_slot', { mode: 'number' }).notNull().default(0),
    createdFinalized: boolean('created_finalized').notNull().default(false),
  },
  (t) => [
    index('markets_status_idx').on(t.status, t.settleTs),
    index('markets_creator_idx').on(t.creator),
    index('markets_asset_idx').on(t.assetSymbol),
  ],
);

export const marketTicks = pgTable(
  'market_ticks',
  {
    marketId: text('market_id')
      .notNull()
      .references(() => markets.id, { onDelete: 'cascade' }),
    ts: tstz('ts').notNull(),
    priceAbove: numeric('price_above').notNull(),
    reserveAbove: numeric('reserve_above').notNull(),
    reserveBelow: numeric('reserve_below').notNull(),
    feeBps: integer('fee_bps').notNull(),
  },
  (t) => [primaryKey({ columns: [t.marketId, t.ts] })],
);

export const trades = pgTable(
  'trades',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    marketId: text('market_id')
      .notNull()
      .references(() => markets.id, { onDelete: 'cascade' }),
    wallet: text('wallet').notNull(),
    side: text('side').notNull(),
    direction: text('direction').notNull(),
    usdc: numeric('usdc').notNull(),
    shares: numeric('shares').notNull(),
    feeUsdc: numeric('fee_usdc').notNull(),
    priceAfter: numeric('price_after').notNull(),
    txSig: text('tx_sig').notNull(),
    ixIndex: integer('ix_index').notNull().default(0),
    slot: bigint('slot', { mode: 'number' }).notNull(),
    ts: tstz('ts').notNull(),
    // 0002
    finalized: boolean('finalized').notNull().default(false),
  },
  (t) => [
    unique('trades_tx_sig_ix_index_key').on(t.txSig, t.ixIndex),
    index('trades_market_ts_idx').on(t.marketId, t.ts),
    index('trades_wallet_idx').on(t.wallet, t.ts),
    index('trades_market_wallet_idx').on(t.marketId, t.wallet),
  ],
);

export const positions = pgTable(
  'positions',
  {
    wallet: text('wallet').notNull(),
    marketId: text('market_id')
      .notNull()
      .references(() => markets.id, { onDelete: 'cascade' }),
    side: text('side').notNull(),
    shares: numeric('shares').notNull().default('0'),
    costBasisUsdc: numeric('cost_basis_usdc').notNull().default('0'),
    realizedPnl: numeric('realized_pnl').notNull().default('0'),
    updatedAt: tstz('updated_at').notNull().default(sql`now()`),
  },
  (t) => [primaryKey({ columns: [t.wallet, t.marketId, t.side] }), index('positions_market_idx').on(t.marketId)],
);

export const lpPositions = pgTable(
  'lp_positions',
  {
    wallet: text('wallet').notNull(),
    marketId: text('market_id')
      .notNull()
      .references(() => markets.id, { onDelete: 'cascade' }),
    lpTokens: numeric('lp_tokens').notNull().default('0'),
    feesEarned: numeric('fees_earned').notNull().default('0'),
  },
  (t) => [primaryKey({ columns: [t.wallet, t.marketId] })],
);

export const redemptions = pgTable(
  'redemptions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    wallet: text('wallet').notNull(),
    marketId: text('market_id')
      .notNull()
      .references(() => markets.id, { onDelete: 'cascade' }),
    side: text('side').notNull(),
    shares: numeric('shares').notNull(),
    usdc: numeric('usdc').notNull(),
    txSig: text('tx_sig').notNull(),
    ixIndex: integer('ix_index').notNull().default(0),
    ts: tstz('ts').notNull(),
    // 0002
    finalized: boolean('finalized').notNull().default(false),
    slot: bigint('slot', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    unique('redemptions_tx_sig_ix_index_key').on(t.txSig, t.ixIndex),
    index('redemptions_wallet_idx').on(t.wallet),
  ],
);

/** 0002 */
export const merges = pgTable(
  'merges',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    wallet: text('wallet').notNull(),
    marketId: text('market_id')
      .notNull()
      .references(() => markets.id, { onDelete: 'cascade' }),
    amount: numeric('amount').notNull(),
    txSig: text('tx_sig').notNull(),
    ixIndex: integer('ix_index').notNull().default(0),
    slot: bigint('slot', { mode: 'number' }).notNull().default(0),
    ts: tstz('ts').notNull(),
    finalized: boolean('finalized').notNull().default(false),
  },
  (t) => [
    unique('merges_tx_sig_ix_index_key').on(t.txSig, t.ixIndex),
    index('merges_wallet_idx').on(t.wallet, t.ts),
    index('merges_market_idx').on(t.marketId),
  ],
);

/** 0002 (indexer) */
export const liquidityEvents = pgTable(
  'liquidity_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    wallet: text('wallet').notNull(),
    marketId: text('market_id')
      .notNull()
      .references(() => markets.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['create', 'add', 'remove'] }).notNull(),
    lpAmount: numeric('lp_amount').notNull(),
    usdc: numeric('usdc').notNull(),
    seedAbove: numeric('seed_above').notNull().default('0'),
    seedBelow: numeric('seed_below').notNull().default('0'),
    p0Bps: integer('p0_bps'),
    txSig: text('tx_sig').notNull(),
    ixIndex: integer('ix_index').notNull().default(0),
    slot: bigint('slot', { mode: 'number' }).notNull().default(0),
    ts: tstz('ts').notNull(),
    finalized: boolean('finalized').notNull().default(false),
  },
  (t) => [
    unique('liquidity_events_tx_sig_ix_index_key').on(t.txSig, t.ixIndex),
    index('liquidity_events_wallet_idx').on(t.wallet, t.marketId),
    index('liquidity_events_market_idx').on(t.marketId),
  ],
);

/* ------------------------------ wallet graph and scoring ------------------------------ */

export const wallets = pgTable('wallets', {
  address: text('address').primaryKey(),
  firstSeen: tstz('first_seen'),
  fundingSource: text('funding_source'),
  clusterId: integer('cluster_id'),
  clusterName: text('cluster_name'),
  sybilClusterId: integer('sybil_cluster_id'),
  labelHidden: boolean('label_hidden').notNull().default(false),
  dataSource: text('data_source').notNull().default('onchain'),
});

export const walletEdges = pgTable(
  'wallet_edges',
  {
    src: text('src').notNull(),
    dst: text('dst').notNull(),
    mint: text('mint').notNull().default('SOL'),
    amountUsd: numeric('amount_usd').notNull(),
    ts: tstz('ts').notNull(),
    txSig: text('tx_sig').notNull(),
    dataSource: text('data_source').notNull().default('onchain'),
  },
  (t) => [
    primaryKey({ columns: [t.txSig, t.src, t.dst, t.mint] }),
    index('wallet_edges_src_idx').on(t.src, t.ts),
    index('wallet_edges_dst_idx').on(t.dst, t.ts),
  ],
);

export const walletFeatures = pgTable(
  'wallet_features',
  {
    address: text('address').notNull(),
    asOf: tstz('as_of').notNull(),
    whaleOverlap: numeric('whale_overlap').notNull(),
    entryTiming: numeric('entry_timing').notNull(),
    hitRate: numeric('hit_rate').notNull(),
    centrality: numeric('centrality').notNull(),
    leadTimeMin: numeric('lead_time_min').notNull(),
    nMarkets: integer('n_markets').notNull(),
  },
  (t) => [primaryKey({ columns: [t.address, t.asOf] })],
);

export const walletScores = pgTable(
  'wallet_scores',
  {
    address: text('address').notNull(),
    asOf: tstz('as_of').notNull(),
    score: smallint('score').notNull(),
    smart: boolean('smart').notNull(),
    top: boolean('top').notNull(),
    contributions: jsonb('contributions').notNull(),
    reasons: jsonb('reasons').notNull(),
    modelVersion: text('model_version').notNull(),
    dataSource: text('data_source').notNull().default('onchain'),
  },
  (t) => [primaryKey({ columns: [t.address, t.asOf] }), index('wallet_scores_latest_idx').on(t.asOf, t.score)],
);

export const graphLayout = pgTable('graph_layout', {
  address: text('address').primaryKey(),
  x: real('x').notNull(),
  y: real('y').notNull(),
  z: real('z').notNull(),
  asOf: tstz('as_of').notNull(),
  dataSource: text('data_source').notNull().default('onchain'),
});

export const marketRadar = pgTable(
  'market_radar',
  {
    marketId: text('market_id')
      .notNull()
      .references(() => markets.id, { onDelete: 'cascade' }),
    ts: tstz('ts').notNull(),
    pAbove: numeric('p_above').notNull(),
    pAboveRaw: numeric('p_above_raw'),
    ciPts: smallint('ci_pts').notNull(),
    nFlagged: integer('n_flagged').notNull(),
    edgeCents: smallint('edge_cents').notNull(),
    flaggedVolAbove: numeric('flagged_vol_above').notNull().default('0'),
    flaggedVolBelow: numeric('flagged_vol_below').notNull().default('0'),
    state: text('state').notNull().default('ready'),
    modelVersion: text('model_version').notNull(),
    dataSource: text('data_source').notNull().default('onchain'),
  },
  (t) => [primaryKey({ columns: [t.marketId, t.ts] }), index('market_radar_latest_idx').on(t.marketId, t.ts)],
);

export const fairValues = pgTable(
  'fair_values',
  {
    marketId: text('market_id')
      .notNull()
      .references(() => markets.id, { onDelete: 'cascade' }),
    ts: tstz('ts').notNull(),
    spot: numeric('spot').notNull(),
    volAnnual: numeric('vol_annual').notNull(),
    pAbove: numeric('p_above').notNull(),
  },
  (t) => [primaryKey({ columns: [t.marketId, t.ts] }), index('fair_values_latest_idx').on(t.marketId, t.ts)],
);

export const oracleStatus = pgTable(
  'oracle_status',
  {
    feedId: text('feed_id').notNull(),
    ts: tstz('ts').notNull(),
    price: numeric('price').notNull(),
    conf: numeric('conf').notNull(),
    publishTs: tstz('publish_ts').notNull(),
    stale: boolean('stale').notNull(),
  },
  (t) => [primaryKey({ columns: [t.feedId, t.ts] }), index('oracle_status_feed_idx').on(t.feedId, t.ts)],
);

export const trackRecordRuns = pgTable(
  'track_record_runs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runAt: tstz('run_at').notNull().default(sql`now()`),
    windowStart: tstz('window_start').notNull(),
    windowEnd: tstz('window_end').notNull(),
    dataSource: text('data_source').notNull(),
    nMarkets: integer('n_markets').notNull(),
    brierRadar: numeric('brier_radar'),
    brierMarket: numeric('brier_market'),
    hitRateRadar: numeric('hit_rate_radar'),
    hitRateMarket: numeric('hit_rate_market'),
    medianLeadMin: numeric('median_lead_min'),
    edgeRealizedCents: numeric('edge_realized_cents'),
    calibration: jsonb('calibration'),
    leadHist: jsonb('lead_hist'),
    modelVersion: text('model_version').notNull(),
  },
  (t) => [index('track_record_runs_idx').on(t.runAt)],
);

export const trackRecordRows = pgTable(
  'track_record_rows',
  {
    runId: bigint('run_id', { mode: 'number' })
      .notNull()
      .references(() => trackRecordRuns.id, { onDelete: 'cascade' }),
    marketId: text('market_id').notNull(),
    question: text('question'),
    radarT24: numeric('radar_t24'),
    marketT24: numeric('market_t24'),
    outcome: text('outcome'),
    closer: text('closer'),
  },
  (t) => [primaryKey({ columns: [t.runId, t.marketId] })],
);

/* ------------------------------ auth, sessions, responsible trading ------------------------------ */

export const authNonces = pgTable(
  'auth_nonces',
  {
    nonce: text('nonce').primaryKey(),
    wallet: text('wallet').notNull(),
    issuedAt: tstz('issued_at').notNull().default(sql`now()`),
    expiresAt: tstz('expires_at').notNull(),
    used: boolean('used').notNull().default(false),
  },
  (t) => [index('auth_nonces_expires_idx').on(t.expiresAt)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    wallet: text('wallet').notNull(),
    mode: text('mode').notNull(),
    walletName: text('wallet_name'),
    tosVersion: text('tos_version'),
    createdAt: tstz('created_at').notNull().default(sql`now()`),
    expiresAt: tstz('expires_at').notNull(),
  },
  (t) => [index('sessions_wallet_idx').on(t.wallet), index('sessions_expires_idx').on(t.expiresAt)],
);

export const tosAcceptances = pgTable(
  'tos_acceptances',
  {
    wallet: text('wallet').notNull(),
    tosVersion: text('tos_version').notNull(),
    signedMessage: text('signed_message').notNull(),
    signature: text('signature'),
    acceptedAt: tstz('accepted_at').notNull().default(sql`now()`),
    ipCountry: text('ip_country'),
  },
  (t) => [primaryKey({ columns: [t.wallet, t.tosVersion] })],
);

export const userSettings = pgTable('user_settings', {
  wallet: text('wallet').primaryKey(),
  dailyLimitUsdc: numeric('daily_limit_usdc'),
  breakUntil: tstz('break_until'),
  sessionReminder: boolean('session_reminder').notNull().default(false),
  spentToday: numeric('spent_today').notNull().default('0'),
  day: date('day', { mode: 'string' }).notNull().default(sql`current_date`),
  locale: text('locale').notNull().default('en'),
});

export const watchlist = pgTable(
  'watchlist',
  {
    wallet: text('wallet').notNull(),
    marketId: text('market_id')
      .notNull()
      .references(() => markets.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.wallet, t.marketId] })],
);

export const trackedWallets = pgTable(
  'tracked_wallets',
  {
    ownerWallet: text('owner_wallet').notNull(),
    targetWallet: text('target_wallet').notNull(),
    createdAt: tstz('created_at').notNull().default(sql`now()`),
  },
  (t) => [primaryKey({ columns: [t.ownerWallet, t.targetWallet] })],
);

export const flagDisputes = pgTable('flag_disputes', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  wallet: text('wallet').notNull(),
  message: text('message').notNull(),
  status: text('status').notNull().default('open'),
  createdAt: tstz('created_at').notNull().default(sql`now()`),
});

/** 0002 */
export const userActivity = pgTable(
  'user_activity',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    wallet: text('wallet').notNull(),
    type: text('type').notNull(),
    summary: text('summary').notNull(),
    marketId: text('market_id'),
    txSig: text('tx_sig'),
    ts: tstz('ts').notNull().default(sql`now()`),
  },
  (t) => [index('user_activity_wallet_idx').on(t.wallet, t.ts)],
);

/* ------------------------------ service bookkeeping ------------------------------ */

export const indexerState = pgTable('indexer_state', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: tstz('updated_at').notNull().default(sql`now()`),
});

export const scoredPositions = pgTable(
  'scored_positions',
  {
    marketId: text('market_id')
      .notNull()
      .references(() => markets.id, { onDelete: 'cascade' }),
    wallet: text('wallet').notNull(),
    side: text('side').notNull(),
    usdc: numeric('usdc').notNull(),
    entryPrice: numeric('entry_price').notNull(),
    ts: tstz('ts').notNull(),
    dataSource: text('data_source').notNull().default('onchain'),
  },
  (t) => [primaryKey({ columns: [t.marketId, t.wallet, t.side] }), index('scored_positions_wallet_idx').on(t.wallet)],
);

/** Name of every table defined above, used by the schema mirror test. */
export const TABLE_NAMES_FOR_TEST = [
  'markets',
  'market_ticks',
  'trades',
  'positions',
  'lp_positions',
  'redemptions',
  'merges',
  'liquidity_events',
  'wallets',
  'wallet_edges',
  'wallet_features',
  'wallet_scores',
  'graph_layout',
  'market_radar',
  'fair_values',
  'oracle_status',
  'track_record_runs',
  'track_record_rows',
  'auth_nonces',
  'sessions',
  'tos_acceptances',
  'user_settings',
  'watchlist',
  'tracked_wallets',
  'flag_disputes',
  'user_activity',
  'indexer_state',
  'scored_positions',
] as const;
