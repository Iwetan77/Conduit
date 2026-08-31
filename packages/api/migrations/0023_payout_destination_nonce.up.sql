-- Proving you control an address you want to be paid at.
--
-- A destination is somewhere a business withdraws its own money to, and getting
-- it wrong is unrecoverable: the transfer is on-chain and final, and an address
-- that is well-formed but not yours is indistinguishable from one that is until
-- the money has gone. So a destination is added unverified and stays unpayable
-- until its owner signs a challenge with it.
--
-- The nonce is issued by the server and lives here rather than in a separate
-- table because it belongs to exactly one destination and dies with it. A row
-- deleted takes its challenge with it, which is the behaviour wanted.
ALTER TABLE payout_destinations ADD COLUMN verification_nonce TEXT;
ALTER TABLE payout_destinations ADD COLUMN nonce_expires_at TIMESTAMPTZ;

COMMENT ON COLUMN payout_destinations.verification_nonce IS
    'Server-issued single-use challenge. Cleared on successful verification and on re-issue, so a captured signature cannot be replayed.';

-- Single-use is enforced by clearing the column, not by a flag: a used nonce
-- that still exists is a signature somebody can replay, and "used" as a boolean
-- leaves the value sitting there to be replayed against.
--
-- Present-together-or-absent-together, same shape as the other paired columns
-- here. A nonce with no expiry never dies; an expiry with no nonce is a
-- challenge nobody can answer.
ALTER TABLE payout_destinations
    ADD CONSTRAINT payout_destinations_nonce_complete
    CHECK ((verification_nonce IS NULL) = (nonce_expires_at IS NULL));
