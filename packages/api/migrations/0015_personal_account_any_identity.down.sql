DROP INDEX IF EXISTS idx_accounts_wallet_personal;

CREATE UNIQUE INDEX idx_accounts_wallet_personal
    ON accounts (lower(login_wallet))
    WHERE privy_user_id IS NULL AND login_wallet IS NOT NULL;
