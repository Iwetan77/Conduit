DROP TABLE IF EXISTS bridge_transfers;
ALTER TABLE settlement_intents DROP COLUMN IF EXISTS source_chain;
