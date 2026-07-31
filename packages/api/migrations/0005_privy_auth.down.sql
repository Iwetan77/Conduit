DROP INDEX IF EXISTS idx_accounts_privy_user_id;
ALTER TABLE accounts DROP COLUMN IF EXISTS login_wallet;
ALTER TABLE accounts DROP COLUMN IF EXISTS privy_user_id;
