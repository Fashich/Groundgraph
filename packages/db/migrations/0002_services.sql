-- Additive schema used by the API, indexer and keeper services. Idempotent (safe to re-apply).

-- Market fee/settlement state mirrored from the on-chain account by the indexer.
ALTER TABLE markets ADD COLUMN IF NOT EXISTS ema_impact_bps     integer     NOT NULL DEFAULT 0;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS ema_ts             bigint      NOT NULL DEFAULT 0;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS settle_expo        integer;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS lp_claim_remaining numeric;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS lp_supply_remaining numeric;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS last_slot          bigint      NOT NULL DEFAULT 0;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS reconciled_at      timestamptz;

-- Finalization tracking: rows are written at 'confirmed' and flipped to finalized once the tx is finalized.
-- Rows whose transaction never reaches finalized (dropped fork) are deleted and positions are rebuilt.
ALTER TABLE trades      ADD COLUMN IF NOT EXISTS finalized boolean NOT NULL DEFAULT false;
ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS finalized boolean NOT NULL DEFAULT false;
ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS slot      bigint  NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS trades_unfinalized_idx      ON trades(slot)      WHERE NOT finalized;
CREATE INDEX IF NOT EXISTS redemptions_unfinalized_idx ON redemptions(slot) WHERE NOT finalized;

-- Merge events (1 ABOVE + 1 BELOW -> 1 USDC). Needed for activity feeds and exact position accounting.
CREATE TABLE IF NOT EXISTS merges (
  id        bigserial PRIMARY KEY,
  wallet    text NOT NULL,
  market_id text NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  amount    numeric NOT NULL,                       -- base units (6 dp): USDC paid out == shares of each side burned
  tx_sig    text NOT NULL,
  ix_index  integer NOT NULL DEFAULT 0,
  slot      bigint NOT NULL DEFAULT 0,
  ts        timestamptz NOT NULL,
  finalized boolean NOT NULL DEFAULT false,
  UNIQUE (tx_sig, ix_index)
);
CREATE INDEX IF NOT EXISTS merges_wallet_idx ON merges(wallet, ts DESC);
CREATE INDEX IF NOT EXISTS merges_market_idx ON merges(market_id);
CREATE INDEX IF NOT EXISTS merges_unfinalized_idx ON merges(slot) WHERE NOT finalized;

-- Off-chain account activity written by the API (responsible-trading changes).
CREATE TABLE IF NOT EXISTS user_activity (
  id        bigserial PRIMARY KEY,
  wallet    text NOT NULL,
  type      text NOT NULL CHECK (type IN ('break','limit')),
  summary   text NOT NULL,
  market_id text,
  tx_sig    text,
  ts        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_activity_wallet_idx ON user_activity(wallet, ts DESC);

-- Helpful read-path indexes.
CREATE INDEX IF NOT EXISTS trades_market_wallet_idx ON trades(market_id, wallet);
CREATE INDEX IF NOT EXISTS market_radar_latest_idx  ON market_radar(market_id, ts DESC);
CREATE INDEX IF NOT EXISTS fair_values_latest_idx   ON fair_values(market_id, ts DESC);
CREATE INDEX IF NOT EXISTS track_record_runs_idx    ON track_record_runs(run_at DESC);
CREATE INDEX IF NOT EXISTS sessions_expires_idx     ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS auth_nonces_expires_idx  ON auth_nonces(expires_at);
