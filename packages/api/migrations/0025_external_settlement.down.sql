-- Reverting restores the stricter pairing, which cannot hold for an account
-- that has switched to an external address while keeping its provisioned wallet
-- id. Those rows are put back to the shape 0021 expects: the wallet id is
-- dropped, so the account keeps settling exactly where it settles now and
-- simply forgets which wallet it could switch back to.
UPDATE accounts
   SET settle_wallet_id = NULL
 WHERE settle_address_source IS DISTINCT FROM 'provisioned' AND settle_wallet_id IS NOT NULL;

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_settle_wallet_complete;

ALTER TABLE accounts
    ADD CONSTRAINT accounts_settle_wallet_complete
    CHECK ((settle_wallet_id IS NOT NULL) = (settle_address_source IS NOT DISTINCT FROM 'provisioned'));

ALTER TABLE accounts DROP COLUMN IF EXISTS provisioned_address;
