-- Restores the column, empty. The answers themselves are not recoverable --
-- they were dropped with it -- so every account reads as "never asked", which
-- is the honest state for a question nothing asks any more.
ALTER TABLE accounts ADD COLUMN payout_confirmed_at TIMESTAMPTZ;
