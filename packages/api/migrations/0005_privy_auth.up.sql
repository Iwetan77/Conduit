-- Merchant auth via Privy email login. privy_user_id identifies the human
-- account (Privy's "sub" DID claim); login_wallet is their Privy embedded
-- wallet address (their identity, not necessarily where funds settle).
-- settle_address already exists and stays separately editable -- it
-- defaults to login_wallet at first login but a business may want funds
-- going to a treasury/multisig, not the login wallet. Both nullable: the
-- existing sk_/pk_ API-key-only account creation path (Accounts.Create)
-- doesn't go through Privy at all and never sets these.
ALTER TABLE accounts ADD COLUMN privy_user_id TEXT;
ALTER TABLE accounts ADD COLUMN login_wallet TEXT;
CREATE UNIQUE INDEX idx_accounts_privy_user_id ON accounts(privy_user_id) WHERE privy_user_id IS NOT NULL;
