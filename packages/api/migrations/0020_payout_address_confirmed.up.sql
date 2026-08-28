-- When a business last CHOSE where its money lands.
--
-- settle_address has always been per-account and editable, so nothing about
-- separating business income from personal was ever blocked by the schema. What
-- was missing is the difference between an address someone picked and one they
-- were given: CreateFromCircle defaults settle_address to the login wallet and
-- never asks, so every merchant's income has been landing in the personal
-- wallet they happened to sign in with, and nothing recorded whether that was a
-- decision or an accident.
--
-- NULL means never asked. That is deliberately the state every existing row
-- starts in, so the one-time prompt reaches merchants who are already signed up
-- rather than only new ones. Setting it to the login wallet on purpose is a
-- perfectly good answer -- a business that is one person has one wallet -- and
-- this column exists to tell that apart from never having been offered.
ALTER TABLE accounts ADD COLUMN payout_confirmed_at TIMESTAMPTZ;

-- Only businesses are asked. A personal account's settle address IS the wallet
-- that signed in, by definition, so there is nothing to choose and nothing to
-- interrupt a payer with.
COMMENT ON COLUMN accounts.payout_confirmed_at IS
    'When the account owner explicitly confirmed settle_address. NULL = never asked; the dashboard gates on it for accounts with a login identity.';
