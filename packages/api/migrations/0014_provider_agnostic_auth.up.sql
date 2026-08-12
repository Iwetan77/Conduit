-- Stop naming a vendor in the schema.
--
-- Merchant login is keyed on accounts.privy_user_id, so the identity provider
-- is baked into the column name, the unique index, the auth middleware and the
-- account-bootstrap handler. Swapping providers means touching all of them, and
-- running two providers at once -- which any safe migration has to do -- is not
-- expressible at all: there is nowhere to record WHICH provider a subject came
-- from, so two providers issuing the same subject string would collide into one
-- account.
--
-- auth_provider + auth_subject says the same thing without the vendor:
--   auth_provider  'privy' today, 'circle' next
--   auth_subject   whatever that provider calls the user (Privy's "sub" DID)
--
-- privy_user_id is deliberately kept and still written, so this migration is
-- reversible and a rollback loses nothing. It gets dropped only once the new
-- columns are proven populated for every row.
ALTER TABLE accounts ADD COLUMN auth_provider TEXT;
ALTER TABLE accounts ADD COLUMN auth_subject  TEXT;

-- Backfill every existing merchant. These are Privy logins by definition:
-- nothing else has ever written privy_user_id.
UPDATE accounts
   SET auth_provider = 'privy',
       auth_subject  = privy_user_id
 WHERE privy_user_id IS NOT NULL;

-- One account per (provider, subject). Scoped by provider on purpose: the same
-- human signing in through Privy and through Circle is two different subjects,
-- and during the cutover both rows may exist. Without the provider in the key,
-- a Circle subject that happened to match a Privy DID would resolve to someone
-- else's account.
CREATE UNIQUE INDEX idx_accounts_auth_identity
    ON accounts(auth_provider, auth_subject)
    WHERE auth_subject IS NOT NULL;
