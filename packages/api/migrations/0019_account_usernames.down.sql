ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_username_format;
DROP INDEX IF EXISTS idx_accounts_username;
ALTER TABLE accounts DROP COLUMN IF EXISTS username;
