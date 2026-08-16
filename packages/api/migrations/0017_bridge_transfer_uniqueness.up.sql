-- One Gateway transfer can fund one intent, and only one.
--
-- `attestation` holds the Gateway transfer id reported by the payer. Idempotency
-- was keyed on (intent_id, attestation), which made a repeated report against
-- the SAME intent safe and said nothing about the same id being reported against
-- a DIFFERENT one. Since the report route needs no credential, one genuine,
-- already-minted transfer id could be attached to any number of intents, and
-- each would pay out from the relayer.
--
-- Global uniqueness is the invariant that was actually meant. Partial, because
-- rows are created before the id is known and NULLs must not collide.
--
-- If this fails to apply, the table already contains a reused transfer id --
-- that is the bug, and the duplicates need looking at rather than the index
-- weakening.
CREATE UNIQUE INDEX idx_bridge_transfers_attestation_unique
    ON bridge_transfers(attestation)
    WHERE attestation IS NOT NULL;
