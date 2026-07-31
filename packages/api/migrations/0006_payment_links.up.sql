-- Payment links are the policy layer Phase 3 adds on top of settlement_intents:
-- amount mode + bounds, expiry, reuse policy, void, and the two-sided
-- reference/description fields. A link does not itself move money -- each
-- successful payment against it creates a settlement_intent (unchanged FX
-- quote/prepare/confirm flow) via payment_link_id below. single_use links
-- have exactly one settlement_intent and the link dies with it; multi_use
-- links can generate many and stay active/viewed indefinitely (never reach
-- paid/settled themselves -- that terminal pair only applies to single_use).
CREATE TABLE payment_links (
    id                 TEXT PRIMARY KEY,                 -- pl_xxx
    account_id         TEXT NOT NULL REFERENCES accounts(id),
    amount_mode        TEXT NOT NULL
                       CHECK (amount_mode IN ('fixed','open','open_with_suggested')),
    amount             NUMERIC(78,0),                     -- required for fixed/open_with_suggested; null for open
    min_amount         NUMERIC(78,0),                     -- open/open_with_suggested only
    max_amount         NUMERIC(78,0),                     -- open/open_with_suggested only
    settle_currency    TEXT NOT NULL,
    settle_address     TEXT NOT NULL,
    accept_currencies  TEXT[] NOT NULL DEFAULT '{}',
    description        TEXT,
    merchant_reference TEXT,
    reuse_policy       TEXT NOT NULL DEFAULT 'single_use'
                       CHECK (reuse_policy IN ('single_use','multi_use')),
    status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('draft','active','viewed','paid','settled','expired','void')),
    expires_at         TIMESTAMPTZ,
    livemode           BOOLEAN NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payment_links_account ON payment_links(account_id, created_at DESC);

ALTER TABLE settlement_intents ADD COLUMN payment_link_id TEXT REFERENCES payment_links(id);
-- The payer's own reference (their PO number etc.) -- distinct from the
-- existing `reference` column, which is the merchant's. Two-sided
-- reconciliation per Phase 3 spec 3.1.
ALTER TABLE settlement_intents ADD COLUMN payer_reference TEXT;
CREATE INDEX idx_settlement_intents_payment_link ON settlement_intents(payment_link_id) WHERE payment_link_id IS NOT NULL;
