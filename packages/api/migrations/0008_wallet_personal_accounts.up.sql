-- Personal accounts owned by a bare wallet, with no Privy login behind them.
--
-- Direct send (/send) lets a payer convert currencies through Circle StableFX
-- with nothing but a connected wallet. StableFX trades hang off a settlement
-- intent, and settlement_intents.account_id is NOT NULL, so that payer needs
-- an owner row. Requiring a Privy sign-in to mint one turned "send EURC from
-- USDC" into an account-creation flow, which is not what a direct send is.
--
-- These rows are keyed by login_wallet instead of privy_user_id. The partial
-- unique index makes provisioning idempotent -- a returning payer reuses their
-- row rather than accumulating one per send -- while leaving merchant accounts
-- (privy_user_id IS NOT NULL) completely untouched, including the ones that
-- happen to share a login_wallet value.
CREATE UNIQUE INDEX idx_accounts_wallet_personal
    ON accounts (lower(login_wallet))
    WHERE privy_user_id IS NULL AND login_wallet IS NOT NULL;
