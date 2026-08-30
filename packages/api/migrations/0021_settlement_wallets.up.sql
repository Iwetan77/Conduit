-- Where a business's money lands, and where that address came from.
--
-- settle_address is one column holding three very different things, and until
-- now nothing said which: an address the system provisioned and can withdraw
-- from, the wallet the owner happened to sign in with, or an address a human
-- typed into a form. They need different handling -- only the first can be
-- swept from the dashboard, only the third can be a typo that loses money --
-- and the code could not tell them apart because the schema did not record it.
--
-- settle_wallet_id is the Circle wallet backing the address when we provisioned
-- it. Recorded rather than looked up: Circle's ListWallets order is not stable
-- and a wallet's label is a display string a client could set, so the wallet
-- this account settles to has to be identified by id, by us, once.
ALTER TABLE accounts ADD COLUMN settle_wallet_id TEXT;

ALTER TABLE accounts ADD COLUMN settle_address_source TEXT
    CHECK (settle_address_source IN ('provisioned', 'login_wallet', 'external'));

COMMENT ON COLUMN accounts.settle_wallet_id IS
    'Circle wallet id backing settle_address, when Conduit provisioned it. NULL otherwise.';
COMMENT ON COLUMN accounts.settle_address_source IS
    'How settle_address was arrived at: provisioned (a wallet we created for this account), login_wallet (the wallet used to sign in), external (supplied by the account owner). NULL only on rows written before the writers set it.';

-- The wallet id and the source are one fact, not two.
--
-- Same shape and same reasoning as accounts_auth_identity_complete (0018): two
-- nullable columns that only mean anything together, and a row carrying one
-- without the other is a row no code path can handle. A 'provisioned' source
-- with no wallet id names a wallet we cannot withdraw from; a wallet id under
-- any other source claims we own an address we did not create.
--
-- IS NOT DISTINCT FROM rather than =, so a NULL source yields false rather than
-- NULL. A CHECK passes on NULL, so the plain equality would have let exactly the
-- worst row through -- unclassified source, wallet id set -- which is the one
-- combination that reads as "we own this" to anything scanning for it.
--
-- NOT VALID then VALIDATE, as 0018 does: new writes are constrained immediately
-- without a long lock, existing rows are checked after. A validation failure
-- here means such a row already exists, which is the thing to look at rather
-- than a reason to drop the constraint.
ALTER TABLE accounts
    ADD CONSTRAINT accounts_settle_wallet_complete
    CHECK ((settle_wallet_id IS NOT NULL) = (settle_address_source IS NOT DISTINCT FROM 'provisioned'))
    NOT VALID;

-- Classify what is already there, from the only evidence available: whether the
-- settle address IS the login wallet.
--
-- Everything else is 'external' by elimination, including API-key accounts that
-- have no login wallet at all -- their address was supplied on creation, which
-- is exactly what external means. Nothing is marked 'provisioned', because
-- nothing has been provisioned yet; that is the next phase's job and it writes
-- the wallet id at the same time.
--
-- Personal accounts (no auth identity) fall out as 'login_wallet' by this rule
-- and that is not an accident of the predicate: a personal account's settle
-- address IS the wallet that signed in, by definition. They are classified, not
-- changed -- no personal row's address moves here, and none ever gets
-- provisioned.
UPDATE accounts
   SET settle_address_source = CASE
       WHEN login_wallet IS NOT NULL AND lower(settle_address) = lower(login_wallet)
           THEN 'login_wallet'
       ELSE 'external'
   END
 WHERE settle_address_source IS NULL;

ALTER TABLE accounts VALIDATE CONSTRAINT accounts_settle_wallet_complete;

-- Addresses a business can withdraw TO, which is not the same as an address its
-- income routes to.
--
-- The old model had one address doing both jobs, so "I want to move money to my
-- treasury" and "every future payment should land in my treasury" were the same
-- irreversible edit. Splitting them means an external address can be added,
-- checked, and paid to deliberately, without any payment ever being routed
-- somewhere unproven.
--
-- verified_at NULL means the owner has not proven control of it yet. Nothing may
-- pay to a row with a NULL verified_at -- that is the whole point of the column,
-- and it is why verification is a timestamp rather than a boolean: when it was
-- proven is worth having when a payout is disputed.
CREATE TABLE payout_destinations (
    id          TEXT PRIMARY KEY,                      -- pd_xxx
    account_id  TEXT NOT NULL REFERENCES accounts(id),
    address     TEXT NOT NULL,
    label       TEXT,
    verified_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per address per account, case-insensitively.
--
-- Hex addresses are case-insensitive on chain (the mixed case in a checksummed
-- address is a checksum, not an identity), so two rows differing only in case
-- are the same destination -- and would let an unverified copy sit beside a
-- verified one, which is a way to pay an unproven address through a check that
-- looked at the wrong row.
CREATE UNIQUE INDEX idx_payout_destinations_account_address
    ON payout_destinations (account_id, lower(address));

CREATE INDEX idx_payout_destinations_account
    ON payout_destinations (account_id, created_at DESC);

-- payout_confirmed_at (0020) is deliberately left in place. The gate that reads
-- it is removed a few phases from here, and dropping the column in the same
-- migration as the behaviour change would make that rollback lossy: the answers
-- merchants have already given would be gone and unrecoverable.
