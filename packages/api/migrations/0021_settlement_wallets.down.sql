-- Reverting loses the record of WHERE each settle_address came from, and with
-- it the link from an account to the Circle wallet backing its address. The
-- addresses themselves are untouched -- settle_address is not written here --
-- so money keeps landing where it lands; what goes is the ability to tell a
-- provisioned address from one someone typed, which re-opens the ambiguity this
-- migration exists to close.
--
-- Any payout destinations a merchant added and proved control of are dropped
-- outright. There is nowhere else to keep them, and they are re-addable.
DROP TABLE IF EXISTS payout_destinations;

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_settle_wallet_complete;
ALTER TABLE accounts DROP COLUMN IF EXISTS settle_address_source;
ALTER TABLE accounts DROP COLUMN IF EXISTS settle_wallet_id;
