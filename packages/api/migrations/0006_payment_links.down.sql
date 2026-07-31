ALTER TABLE settlement_intents DROP COLUMN IF EXISTS payer_reference;
ALTER TABLE settlement_intents DROP COLUMN IF EXISTS payment_link_id;
DROP TABLE IF EXISTS payment_links;
