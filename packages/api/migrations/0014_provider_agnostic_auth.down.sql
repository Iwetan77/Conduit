DROP INDEX IF EXISTS idx_accounts_auth_identity;
ALTER TABLE accounts DROP COLUMN IF EXISTS auth_subject;
ALTER TABLE accounts DROP COLUMN IF EXISTS auth_provider;
