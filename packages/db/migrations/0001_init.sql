-- Groundgraph core schema (PostgreSQL 16). Source of truth shared by TS (Drizzle) and Python (scorer).
-- Public market id = the market account pubkey (base58).

CREATE TABLE IF NOT EXISTS markets (
  id              text PRIMARY KEY,                 -- market PDA pubkey
  creator         text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('close','touch')),
  direction       text CHECK (direction IN ('up','down')),
  asset_symbol    text NOT NULL,
  feed_id         text NOT NULL,                    -- hex, 32 bytes
  target_price    numeric NOT NULL,                 -- human units (USD)
  target_expo     integer NOT NULL,
  target_raw      numeric NOT NULL,                 -- raw i64 as stored on chain
  open_ts         timestamptz NOT NULL,
  trading_end_ts  timestamptz NOT NULL,
  settle_ts       timestamptz NOT NULL,
  base_fee_bps    integer NOT NULL,
  dynamic_fee     boolean NOT NULL DEFAULT false,
  question        text NOT NULL,
  category        text NOT NULL DEFAULT 'crypto',
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','trading_closed','settled','voided')),
  outcome         text CHECK (outcome IN ('above','below')),
  settle_price    numeric,
  settle_publish_ts timestamptz,
  above_mint      text NOT NULL,
  below_mint      text NOT NULL,
  lp_mint         text NOT NULL,
  vault           text NOT NULL,
  reserve_above   numeric NOT NULL DEFAULT 0,       -- u64 base units
  reserve_below   numeric NOT NULL DEFAULT 0,
  complete_sets   numeric NOT NULL DEFAULT 0,
  fee_pool        numeric NOT NULL DEFAULT 0,
  hidden          boolean NOT NULL DEFAULT false,   -- off-chain "hide from interface"
  created_tx      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS markets_status_idx ON markets(status, settle_ts);
CREATE INDEX IF NOT EXISTS markets_creator_idx ON markets(creator);
CREATE INDEX IF NOT EXISTS markets_asset_idx ON markets(asset_symbol);

CREATE TABLE IF NOT EXISTS market_ticks (
  market_id     text NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  ts            timestamptz NOT NULL,
  price_above   numeric NOT NULL,                   -- 0..1
  reserve_above numeric NOT NULL,
  reserve_below numeric NOT NULL,
  fee_bps       integer NOT NULL,
  PRIMARY KEY (market_id, ts)
);

CREATE TABLE IF NOT EXISTS trades (
  id          bigserial PRIMARY KEY,
  market_id   text NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  wallet      text NOT NULL,
  side        text NOT NULL CHECK (side IN ('above','below')),
  direction   text NOT NULL CHECK (direction IN ('buy','sell')),
  usdc        numeric NOT NULL,                     -- base units (6 dp)
  shares      numeric NOT NULL,                     -- base units (6 dp)
  fee_usdc    numeric NOT NULL,
  price_after numeric NOT NULL,                     -- ABOVE price 0..1 after the trade
  tx_sig      text NOT NULL,
  ix_index    integer NOT NULL DEFAULT 0,
  slot        bigint NOT NULL,
  ts          timestamptz NOT NULL,
  UNIQUE (tx_sig, ix_index)
);
CREATE INDEX IF NOT EXISTS trades_market_ts_idx ON trades(market_id, ts DESC);
CREATE INDEX IF NOT EXISTS trades_wallet_idx ON trades(wallet, ts DESC);

CREATE TABLE IF NOT EXISTS positions (
  wallet          text NOT NULL,
  market_id       text NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  side            text NOT NULL CHECK (side IN ('above','below')),
  shares          numeric NOT NULL DEFAULT 0,
  cost_basis_usdc numeric NOT NULL DEFAULT 0,
  realized_pnl    numeric NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet, market_id, side)
);
CREATE INDEX IF NOT EXISTS positions_market_idx ON positions(market_id);

CREATE TABLE IF NOT EXISTS lp_positions (
  wallet      text NOT NULL,
  market_id   text NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  lp_tokens   numeric NOT NULL DEFAULT 0,
  fees_earned numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (wallet, market_id)
);

CREATE TABLE IF NOT EXISTS redemptions (
  id        bigserial PRIMARY KEY,
  wallet    text NOT NULL,
  market_id text NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  side      text NOT NULL CHECK (side IN ('above','below')),
  shares    numeric NOT NULL,
  usdc      numeric NOT NULL,
  tx_sig    text NOT NULL,
  ix_index  integer NOT NULL DEFAULT 0,
  ts        timestamptz NOT NULL,
  UNIQUE (tx_sig, ix_index)
);
CREATE INDEX IF NOT EXISTS redemptions_wallet_idx ON redemptions(wallet);

-- Wallet graph + scoring
CREATE TABLE IF NOT EXISTS wallets (
  address          text PRIMARY KEY,
  first_seen       timestamptz,
  funding_source   text,
  cluster_id       integer,
  cluster_name     text,
  sybil_cluster_id integer,
  label_hidden     boolean NOT NULL DEFAULT false,
  data_source text NOT NULL DEFAULT 'onchain'
);

CREATE TABLE IF NOT EXISTS wallet_edges (
  src        text NOT NULL,
  dst        text NOT NULL,
  mint       text NOT NULL DEFAULT 'SOL',
  amount_usd numeric NOT NULL,
  ts         timestamptz NOT NULL,
  tx_sig     text NOT NULL,
  PRIMARY KEY (tx_sig, src, dst, mint),
  data_source text NOT NULL DEFAULT 'onchain'
);
CREATE INDEX IF NOT EXISTS wallet_edges_src_idx ON wallet_edges(src, ts);
CREATE INDEX IF NOT EXISTS wallet_edges_dst_idx ON wallet_edges(dst, ts);

CREATE TABLE IF NOT EXISTS wallet_features (
  address       text NOT NULL,
  as_of         timestamptz NOT NULL,
  whale_overlap numeric NOT NULL,                   -- 0..1
  entry_timing  numeric NOT NULL,                   -- 0..1
  hit_rate      numeric NOT NULL,                   -- 0..1
  centrality    numeric NOT NULL,                   -- 0..1 percentile
  lead_time_min numeric NOT NULL,
  n_markets     integer NOT NULL,
  PRIMARY KEY (address, as_of)
);

CREATE TABLE IF NOT EXISTS wallet_scores (
  address        text NOT NULL,
  as_of          timestamptz NOT NULL,
  score          smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
  smart          boolean NOT NULL,
  top            boolean NOT NULL,
  contributions  jsonb NOT NULL,                    -- {whale_overlap, entry_timing, hit_rate, centrality, lead_time} sums to score
  reasons        jsonb NOT NULL,                    -- string[] plain-language, top 3
  model_version  text NOT NULL,
  PRIMARY KEY (address, as_of),
  data_source text NOT NULL DEFAULT 'onchain'
);
CREATE INDEX IF NOT EXISTS wallet_scores_latest_idx ON wallet_scores(as_of DESC, score DESC);

CREATE TABLE IF NOT EXISTS graph_layout (
  address  text PRIMARY KEY,
  x        real NOT NULL,
  y        real NOT NULL,
  z        real NOT NULL,
  as_of    timestamptz NOT NULL,
  data_source text NOT NULL DEFAULT 'onchain'
);

CREATE TABLE IF NOT EXISTS market_radar (
  market_id         text NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  ts                timestamptz NOT NULL,
  p_above           numeric NOT NULL,               -- calibrated 0..1
  p_above_raw       numeric,                        -- uncalibrated
  ci_pts            smallint NOT NULL,
  n_flagged         integer NOT NULL,
  edge_cents        smallint NOT NULL,
  flagged_vol_above numeric NOT NULL DEFAULT 0,
  flagged_vol_below numeric NOT NULL DEFAULT 0,
  state             text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','building')),
  model_version     text NOT NULL,
  PRIMARY KEY (market_id, ts),
  data_source text NOT NULL DEFAULT 'onchain'
);

CREATE TABLE IF NOT EXISTS fair_values (
  market_id  text NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  ts         timestamptz NOT NULL,
  spot       numeric NOT NULL,
  vol_annual numeric NOT NULL,
  p_above    numeric NOT NULL,
  PRIMARY KEY (market_id, ts)
);

CREATE TABLE IF NOT EXISTS oracle_status (
  feed_id    text NOT NULL,
  ts         timestamptz NOT NULL,
  price      numeric NOT NULL,
  conf       numeric NOT NULL,
  publish_ts timestamptz NOT NULL,
  stale      boolean NOT NULL,
  PRIMARY KEY (feed_id, ts)
);
CREATE INDEX IF NOT EXISTS oracle_status_feed_idx ON oracle_status(feed_id, ts DESC);

CREATE TABLE IF NOT EXISTS track_record_runs (
  id                  bigserial PRIMARY KEY,
  run_at              timestamptz NOT NULL DEFAULT now(),
  window_start        timestamptz NOT NULL,
  window_end          timestamptz NOT NULL,
  data_source         text NOT NULL,                -- e.g. 'helius-mainnet-backfill' | 'demo-synthetic'
  n_markets           integer NOT NULL,
  brier_radar         numeric,
  brier_market        numeric,
  hit_rate_radar      numeric,
  hit_rate_market     numeric,
  median_lead_min     numeric,
  edge_realized_cents numeric,
  calibration         jsonb,
  lead_hist           jsonb,
  model_version       text NOT NULL
);

CREATE TABLE IF NOT EXISTS track_record_rows (
  run_id      bigint NOT NULL REFERENCES track_record_runs(id) ON DELETE CASCADE,
  market_id   text NOT NULL,
  question    text,
  radar_t24   numeric,
  market_t24  numeric,
  outcome     text,
  closer      text,                                 -- 'radar' | 'market' | 'tie'
  PRIMARY KEY (run_id, market_id)
);

-- Auth, sessions, responsible trading
CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce      text PRIMARY KEY,
  wallet     text NOT NULL,
  issued_at  timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used       boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS sessions (
  id          text PRIMARY KEY,
  wallet      text NOT NULL,
  mode        text NOT NULL CHECK (mode IN ('sign','view')),
  wallet_name text,
  tos_version text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_wallet_idx ON sessions(wallet);

CREATE TABLE IF NOT EXISTS tos_acceptances (
  wallet         text NOT NULL,
  tos_version    text NOT NULL,
  signed_message text NOT NULL,
  signature      text,
  accepted_at    timestamptz NOT NULL DEFAULT now(),
  ip_country     text,
  PRIMARY KEY (wallet, tos_version)
);

CREATE TABLE IF NOT EXISTS user_settings (
  wallet            text PRIMARY KEY,
  daily_limit_usdc  numeric,                        -- null = none
  break_until       timestamptz,
  session_reminder  boolean NOT NULL DEFAULT false,
  spent_today       numeric NOT NULL DEFAULT 0,
  day               date NOT NULL DEFAULT current_date,
  locale            text NOT NULL DEFAULT 'en'
);

CREATE TABLE IF NOT EXISTS watchlist (
  wallet    text NOT NULL,
  market_id text NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  PRIMARY KEY (wallet, market_id)
);

CREATE TABLE IF NOT EXISTS tracked_wallets (
  owner_wallet  text NOT NULL,
  target_wallet text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_wallet, target_wallet)
);

CREATE TABLE IF NOT EXISTS flag_disputes (
  id         bigserial PRIMARY KEY,
  wallet     text NOT NULL,
  message    text NOT NULL,
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open','hidden','kept','info_requested')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Service bookkeeping
CREATE TABLE IF NOT EXISTS indexer_state (
  key   text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Positions of scored wallets in a market (scorer input and API output for flagged entries).
-- 'onchain' rows mirror indexer data; 'demo-synthetic' rows exist only when the scorer runs in demo mode and are
-- served by the API only when DEMO_MODE=true.
CREATE TABLE IF NOT EXISTS scored_positions (
  market_id   text NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  wallet      text NOT NULL,
  side        text NOT NULL CHECK (side IN ('above','below')),
  usdc        numeric NOT NULL,                     -- base units (6 dp), position size at cost
  entry_price numeric NOT NULL,                     -- ABOVE price 0..1 at entry (for BELOW positions this is still the ABOVE price)
  ts          timestamptz NOT NULL,
  data_source text NOT NULL DEFAULT 'onchain',
  PRIMARY KEY (market_id, wallet, side)
);
CREATE INDEX IF NOT EXISTS scored_positions_wallet_idx ON scored_positions(wallet);
