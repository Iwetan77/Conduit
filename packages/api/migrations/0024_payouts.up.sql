-- Money leaving, recorded as deliberately as money arriving.
--
-- A payout is the merchant moving their own funds out of the settlement wallet
-- to an address they have proven they control. It gets its own row rather than
-- only a balance_transactions entry because the ledger entry is the CONSEQUENCE
-- and this is the INTENT: a payout exists from the moment it is authorised,
-- before any transaction is signed, and the gap between those two is exactly
-- where things go wrong and need to be findable.
CREATE TABLE payouts (
    id             TEXT PRIMARY KEY,                     -- po_xxx
    account_id     TEXT NOT NULL REFERENCES accounts(id),
    destination_id TEXT NOT NULL REFERENCES payout_destinations(id),
    -- Snapshots, for the same reason settlement_intents snapshots its address:
    -- a destination that is later removed, or an account that later moves its
    -- settlement, must not change what a completed payout says it did.
    destination_address TEXT NOT NULL,
    from_address        TEXT NOT NULL,
    currency       TEXT NOT NULL,
    amount         NUMERIC(78,0) NOT NULL CHECK (amount > 0),
    status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','paid','failed')),
    tx_hash        TEXT,
    error          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_at        TIMESTAMPTZ,

    -- Paid means there is a transaction; pending and failed mean there is not
    -- one worth trusting. Present-together-or-absent-together, the same shape
    -- used for every other pair in this schema, because a 'paid' row with no
    -- hash is a payout nobody can find on chain.
    CONSTRAINT payouts_paid_has_tx
        CHECK ((status = 'paid') = (tx_hash IS NOT NULL AND paid_at IS NOT NULL))
);

CREATE INDEX idx_payouts_account ON payouts(account_id, created_at DESC);

-- One row per transaction, so the same transfer cannot be confirmed twice into
-- two payouts and double-count against the ledger.
CREATE UNIQUE INDEX idx_payouts_tx_hash ON payouts(lower(tx_hash)) WHERE tx_hash IS NOT NULL;
