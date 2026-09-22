-- Single-use payment-link reservation.
--
-- Pay() used to read a link's status and insert a settlement_intent as two
-- separate statements. Two concurrent checkouts on a single_use link both saw
-- 'active'/'viewed' and each minted an intent, so one invoice could start two
-- irreversible payment paths. The link only flips to 'paid' once a settlement
-- actually lands, so "re-check after settling" cannot close that window: the
-- second path is racing toward that same settlement.
--
-- These two columns let Pay() reserve the link for exactly one in-flight
-- intent. reserved_until is the expiry: a payer who opens checkout and walks
-- away must not permanently lock the invoice, so the reservation lapses with
-- the intent it created. reserved_intent_id names the holder so a cancelled
-- intent can release its own reservation immediately rather than waiting for
-- the lapse.
--
-- Deliberately no foreign key: reserved_intent_id is a hint used for release,
-- never a source of truth, and a dangling reference is harmless.
ALTER TABLE payment_links
    ADD COLUMN reserved_intent_id TEXT,
    ADD COLUMN reserved_until TIMESTAMPTZ;
