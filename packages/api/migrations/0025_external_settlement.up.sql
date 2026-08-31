-- Remembering the wallet we provisioned, even while income goes elsewhere.
--
-- A business can choose to settle directly to a treasury or a multisig instead
-- of the wallet Conduit made for it. That choice has to be reversible in one
-- click -- it is a preference, not a demolition -- and reverting means putting
-- back an address the server can no longer look up: a Circle wallet's address
-- is readable only with the owner's own user token, which the server cannot
-- mint for a Google user.
--
-- So the provisioned address is remembered here rather than discarded and
-- fetched again later. Without it, "go back to my own wallet" would require the
-- merchant to be present with a live Circle session, which is exactly the
-- moment they are least likely to be.
ALTER TABLE accounts ADD COLUMN provisioned_address TEXT;

UPDATE accounts
   SET provisioned_address = settle_address
 WHERE settle_address_source = 'provisioned' AND provisioned_address IS NULL;

COMMENT ON COLUMN accounts.provisioned_address IS
    'The address of the wallet Conduit provisioned for this account, kept even while settle_address points somewhere else, so switching back needs nothing from Circle.';

-- The pairing constraint becomes an implication rather than an equivalence.
--
-- 0021 said settle_wallet_id is present EXACTLY when the source is
-- 'provisioned', which was right while those were the only two states that
-- could exist together. It is now too strong: an account settling to an
-- external address still HAS a provisioned wallet, and forgetting its id is
-- what would make the choice one-way.
--
-- What still must hold is the direction that matters: claiming to settle to a
-- wallet we provisioned, without recording which one, is a claim nobody can
-- check and an address nobody can withdraw from.
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_settle_wallet_complete;

ALTER TABLE accounts
    ADD CONSTRAINT accounts_settle_wallet_complete
    CHECK (
        settle_address_source IS DISTINCT FROM 'provisioned'
        OR (settle_wallet_id IS NOT NULL AND provisioned_address IS NOT NULL)
    )
    NOT VALID;

ALTER TABLE accounts VALIDATE CONSTRAINT accounts_settle_wallet_complete;
