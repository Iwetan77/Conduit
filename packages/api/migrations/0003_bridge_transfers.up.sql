-- CCTP V2 cross-chain inbound: a settlement intent can be funded from a
-- non-Arc source chain via Circle CCTP. source_chain = 'arc' (the default)
-- means today's behavior, no bridge. Anything else runs a bridging pre-stage
-- before the existing quote/settle path.
ALTER TABLE settlement_intents
    ADD COLUMN source_chain TEXT NOT NULL DEFAULT 'arc';

CREATE TABLE bridge_transfers (
    id               TEXT PRIMARY KEY,                  -- brg_xxx
    intent_id        TEXT NOT NULL REFERENCES settlement_intents(id),
    source_domain    INTEGER NOT NULL,                  -- CCTP domain id, e.g. Solana = 5
    dest_domain      INTEGER NOT NULL,                  -- always Arc = 26 today
    source_tx_hash   TEXT,                               -- set once the burn is submitted
    burn_amount      NUMERIC(78,0) NOT NULL,             -- USDC minor units requested to burn
    attestation      TEXT,                               -- hex message bytes, set once Iris signs
    attestation_status TEXT,                             -- raw Iris status string, for debugging
    mint_tx_hash     TEXT,                                -- set once receiveMessage lands on Arc
    minted_amount    NUMERIC(78,0),                       -- burn_amount minus the CCTP fee actually
                                                            -- charged; NOT assumed equal to burn_amount
    state            TEXT NOT NULL DEFAULT 'initiated'
                     CHECK (state IN (
                         'initiated', 'burn_submitted', 'burn_confirmed',
                         'attestation_pending', 'attested', 'mint_submitted',
                         'minted', 'handoff_to_settlement', 'failed', 'orphaned'
                     )),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_bridge_transfers_intent ON bridge_transfers(intent_id);
-- Reconciler sweep: find transfers that minted (or are attested/pending) with
-- no forward progress, so a session death after burn never leaves funds
-- unminted. See internal/bridge's README for the orphan-recovery flow.
CREATE INDEX idx_bridge_transfers_reconcile ON bridge_transfers(state, updated_at)
    WHERE state IN ('attestation_pending', 'attested', 'orphaned');
-- Idempotency guard for Mint(): at most one bridge_transfer row may claim a
-- given source tx hash, and mint_tx_hash is unique so two concurrent minters
-- (a live session and the orphan reconciler) can't both record a landed mint.
CREATE UNIQUE INDEX idx_bridge_transfers_source_tx ON bridge_transfers(source_tx_hash)
    WHERE source_tx_hash IS NOT NULL;
CREATE UNIQUE INDEX idx_bridge_transfers_mint_tx ON bridge_transfers(mint_tx_hash)
    WHERE mint_tx_hash IS NOT NULL;
