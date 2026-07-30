-- Mint() needs BOTH the CCTP message bytes and the attestation signature to
-- submit receiveMessage without a live payer session. 0003 only added a
-- column for the attestation half -- an oversight caught while wiring the
-- orphan reconciler, which depends on both being persisted.
ALTER TABLE bridge_transfers ADD COLUMN message_hex TEXT;
