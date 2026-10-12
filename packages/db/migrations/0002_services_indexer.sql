-- Additive schema for the indexer. Idempotent (safe to re-apply). Never edits 0001_init.sql.

-- Liquidity events: market creation (creator receives LP tokens and the seeded outcome shares) and LP withdrawals.
-- kind 'create' rows also carry the seeded share amounts so positions can be rebuilt from events alone.
CREATE TABLE IF NOT EXISTS liquidity_events (
  id         bigserial PRIMARY KEY,
  wallet     text NOT NULL,
  market_id  text NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('create','add','remove')),
  lp_amount  numeric NOT NULL,                      -- LP tokens minted (create/add) or burned (remove)
  usdc       numeric NOT NULL,                      -- USDC paid in (create/add) or paid out (remove), base units
  seed_above numeric NOT NULL DEFAULT 0,            -- create only: ABOVE shares minted to the creator
  seed_below numeric NOT NULL DEFAULT 0,            -- create only: BELOW shares minted to the creator
  p0_bps     integer,                               -- create only: initial ABOVE price in bps
  tx_sig     text NOT NULL,
  ix_index   integer NOT NULL DEFAULT 0,
  slot       bigint NOT NULL DEFAULT 0,
  ts         timestamptz NOT NULL,
  finalized  boolean NOT NULL DEFAULT false,
  UNIQUE (tx_sig, ix_index)
);
CREATE INDEX IF NOT EXISTS liquidity_events_wallet_idx ON liquidity_events(wallet, market_id);
CREATE INDEX IF NOT EXISTS liquidity_events_market_idx ON liquidity_events(market_id);
CREATE INDEX IF NOT EXISTS liquidity_events_unfinalized_idx ON liquidity_events(slot) WHERE NOT finalized;

-- Market creation finalization tracking (markets whose creating tx is dropped are deleted).
ALTER TABLE markets ADD COLUMN IF NOT EXISTS created_slot      bigint  NOT NULL DEFAULT 0;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS created_finalized boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS markets_unfinalized_idx ON markets(created_slot) WHERE NOT created_finalized AND created_tx IS NOT NULL;

-- Position rebuilds read all of a wallet's events in one market.
CREATE INDEX IF NOT EXISTS redemptions_wallet_market_idx ON redemptions(wallet, market_id);
CREATE INDEX IF NOT EXISTS merges_wallet_market_idx ON merges(wallet, market_id);
CREATE INDEX IF NOT EXISTS trades_tx_idx ON trades(tx_sig);
