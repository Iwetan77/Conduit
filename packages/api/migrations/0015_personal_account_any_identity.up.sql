-- The index that keeps one personal account per wallet has to agree with the
-- lookup in personalAccountForWallet, and after migration 0014 it no longer
-- did.
--
-- 0008 wrote "a personal account is one with no login identity" as
-- "privy_user_id IS NULL", because at the time that was the only column an
-- identity could live in. 0014 moved identity to auth_provider/auth_subject, so
-- a merchant signed in with Circle has privy_user_id NULL and fell inside this
-- partial index -- occupying the slot for their own wallet. The payer-created
-- link then resolved to the MERCHANT account: shown under the business name,
-- and recorded against the merchant's books.
--
-- Say what was always meant: no identity in ANY identity column.
DROP INDEX IF EXISTS idx_accounts_wallet_personal;

CREATE UNIQUE INDEX idx_accounts_wallet_personal
    ON accounts (lower(login_wallet))
    WHERE privy_user_id IS NULL AND auth_subject IS NULL AND login_wallet IS NOT NULL;
