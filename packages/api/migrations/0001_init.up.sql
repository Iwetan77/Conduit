-- Conduit B2B API schema. Amounts are always NUMERIC(78,0) -- big enough for a
-- 78-digit uint256 in raw minor units, never floats, never BIGINT (which caps
-- at ~9.2e18 and silently truncates an 18-decimal token's larger raw values).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE accounts (
    id              TEXT PRIMARY KEY,                 -- acct_xxx
    parent_id       TEXT REFERENCES accounts(id),
    name            TEXT NOT NULL,
    settle_currency TEXT NOT NULL,                    -- token symbol, e.g. USDC
    settle_address  TEXT NOT NULL,
    livemode        BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
    id          TEXT PRIMARY KEY,                     -- key_xxx (internal id, not the secret)
    account_id  TEXT NOT NULL REFERENCES accounts(id),
    key_hash    TEXT NOT NULL UNIQUE,                 -- sha256(full key), hex
    prefix      TEXT NOT NULL,                         -- sk_test_ / sk_live_ / pk_test_ / pk_live_
    suffix      TEXT NOT NULL,                         -- last 4 chars, display only
    type        TEXT NOT NULL CHECK (type IN ('pk', 'sk')),
    livemode    BOOLEAN NOT NULL,
    revoked_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_api_keys_account ON api_keys(account_id);

CREATE TABLE settlement_intents (
    id                TEXT PRIMARY KEY,                -- si_xxx
    account_id        TEXT NOT NULL REFERENCES accounts(id),
    amount            NUMERIC(78,0) NOT NULL,
    settle_currency   TEXT NOT NULL,
    settle_address    TEXT NOT NULL,
    accept_currencies TEXT[] NOT NULL DEFAULT '{}',    -- empty = every routable currency
    status            TEXT NOT NULL DEFAULT 'created'
                      CHECK (status IN ('created','quoted','funding','settling','settled','expired','canceled','failed')),
    reference         TEXT,
    metadata          JSONB NOT NULL DEFAULT '{}',
    expires_at        TIMESTAMPTZ NOT NULL,
    declaration_id    TEXT,                            -- bytes32 hex, set once registered on-chain
    livemode          BOOLEAN NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_settlement_intents_account ON settlement_intents(account_id, created_at DESC);
CREATE INDEX idx_settlement_intents_status ON settlement_intents(status) WHERE status IN ('created','quoted','funding','settling');

CREATE TABLE fx_trades (
    id                    TEXT PRIMARY KEY,            -- fxt_xxx
    intent_id             TEXT NOT NULL REFERENCES settlement_intents(id),
    provider              TEXT NOT NULL CHECK (provider IN ('stablefx','amm','direct')),
    state                 TEXT NOT NULL DEFAULT 'quoted'
                          CHECK (state IN ('quoted','trade_created','presigned','awaiting_signature','submitted','settled','expired','failed')),
    pay_currency          TEXT NOT NULL,
    pay_amount            NUMERIC(78,0) NOT NULL,
    rate                  NUMERIC,
    quote_id              TEXT,                        -- StableFX quote UUID
    quote_expires_at      TIMESTAMPTZ,
    contract_trade_id     TEXT,                         -- StableFX contractTradeId
    witness               TEXT,                         -- keccak256(SingleTradeWitness) hex
    witness_type_string   TEXT,
    funding_typed_data    JSONB,
    funding_signature     TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_fx_trades_intent ON fx_trades(intent_id);
CREATE INDEX idx_fx_trades_sweepable ON fx_trades(state, quote_expires_at)
    WHERE state IN ('trade_created','presigned','awaiting_signature');

CREATE TABLE settlements (
    id             TEXT PRIMARY KEY,                   -- stl_xxx
    intent_id      TEXT NOT NULL REFERENCES settlement_intents(id),
    fx_trade_id    TEXT REFERENCES fx_trades(id),
    tx_hash        TEXT NOT NULL,
    receipt_id     TEXT NOT NULL,                        -- ConduitRouter receiptId (bytes32 hex)
    pay_currency   TEXT NOT NULL,
    pay_amount     NUMERIC(78,0) NOT NULL,
    settle_amount  NUMERIC(78,0) NOT NULL,
    rate_applied   NUMERIC,
    fee            NUMERIC(78,0) NOT NULL DEFAULT 0,
    block_number   BIGINT NOT NULL,
    log_index      INTEGER NOT NULL,
    settled_at     TIMESTAMPTZ NOT NULL,
    UNIQUE (tx_hash, log_index)
);
CREATE INDEX idx_settlements_intent ON settlements(intent_id);

CREATE TABLE balance_transactions (
    id             TEXT PRIMARY KEY,                   -- btx_xxx
    account_id     TEXT NOT NULL REFERENCES accounts(id),
    settlement_id  TEXT REFERENCES settlements(id),
    type           TEXT NOT NULL,                        -- settlement, fee, adjustment
    gross          NUMERIC(78,0) NOT NULL,
    fee            NUMERIC(78,0) NOT NULL DEFAULT 0,
    net            NUMERIC(78,0) NOT NULL,
    currency       TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_balance_transactions_account ON balance_transactions(account_id, created_at DESC);

CREATE TABLE webhook_endpoints (
    id              TEXT PRIMARY KEY,                   -- we_xxx
    account_id      TEXT NOT NULL REFERENCES accounts(id),
    url             TEXT NOT NULL,
    secret          TEXT NOT NULL,                       -- HMAC signing secret
    enabled_events  TEXT[] NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_webhook_endpoints_account ON webhook_endpoints(account_id);

CREATE TABLE webhook_deliveries (
    id             TEXT PRIMARY KEY,                    -- whd_xxx
    endpoint_id    TEXT NOT NULL REFERENCES webhook_endpoints(id),
    event_type     TEXT NOT NULL,
    payload        JSONB NOT NULL,
    attempt        INTEGER NOT NULL DEFAULT 0,
    response_code  INTEGER,
    response_body  TEXT,
    next_retry_at  TIMESTAMPTZ,
    delivered_at   TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id, created_at DESC);
CREATE INDEX idx_webhook_deliveries_pending ON webhook_deliveries(next_retry_at) WHERE delivered_at IS NULL;

CREATE TABLE idempotency_keys (
    key            TEXT NOT NULL,
    account_id     TEXT NOT NULL REFERENCES accounts(id),
    request_hash   TEXT NOT NULL,
    response_body  BYTEA,                              -- raw bytes, NOT jsonb: jsonb
                                                          -- reorders/reformats keys on
                                                          -- storage, breaking byte-exact replay
    status_code    INTEGER,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, key)
);

CREATE TABLE indexer_checkpoint (
    id                  INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- singleton row
    last_processed_block BIGINT NOT NULL DEFAULT 0
);
INSERT INTO indexer_checkpoint (id, last_processed_block) VALUES (1, 0);
