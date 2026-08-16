-- Dropping this re-allows one Gateway transfer id to fund several intents.
DROP INDEX IF EXISTS idx_bridge_transfers_attestation_unique;
