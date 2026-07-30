package handlers

import (
	"context"
	"encoding/hex"
	"log"
	"strings"
	"time"

	bridgepkg "github.com/kzn-labs/conduit/api/internal/bridge"
)

// ReconcileOrphanedBridges is the server-side completion path
// internal/bridge/README.md promises: it finds bridge_transfers rows with no
// recent forward progress and completes them without a payer present. A
// burn is irreversible from the moment it's submitted -- not just once
// attested -- so this covers every state from burn_submitted onward, not
// only the formally-"orphaned"-eligible attestation_pending/attested states.
// Found the hard way running scripts/e2e-crosschain.sh for real: a crash
// between burn_confirmed and attestation_pending left a row this function's
// first version couldn't see at all (its WHERE clause started at
// attestation_pending), stuck forever with a live, un-minted burn behind it.
//
// Call on an interval from cmd/api; safe to call concurrently with a live
// session driving the same row (every write re-checks state first).
func (h *Bridge) ReconcileOrphanedBridges(ctx context.Context) {
	staleAfter := h.StaleAfter
	if staleAfter <= 0 {
		staleAfter = 45 * time.Second
	}
	rows, err := h.Pool.Query(ctx,
		`SELECT id, intent_id, state, source_tx_hash, attestation, message_hex
		 FROM bridge_transfers
		 WHERE state IN ('burn_submitted', 'burn_confirmed', 'attestation_pending', 'attested', 'orphaned', 'minted')
		 AND source_tx_hash IS NOT NULL
		 AND updated_at < $1`,
		time.Now().Add(-staleAfter),
	)
	if err != nil {
		log.Printf("bridge reconciler: query failed: %v", err)
		return
	}
	type stuck struct {
		id, intentID, state            string
		sourceTxHash, attestation, msg *string
	}
	var stuckRows []stuck
	for rows.Next() {
		var s stuck
		if err := rows.Scan(&s.id, &s.intentID, &s.state, &s.sourceTxHash, &s.attestation, &s.msg); err != nil {
			log.Printf("bridge reconciler: scan failed: %v", err)
			continue
		}
		stuckRows = append(stuckRows, s)
	}
	rows.Close()

	for _, s := range stuckRows {
		switch bridgepkg.State(s.state) {
		case bridgepkg.StateBurnSubmitted, bridgepkg.StateBurnConfirmed:
			// The burn already happened (source_tx_hash is set) -- resume the
			// normal pipeline from wherever it actually is. runBridgeToSettlement's
			// setState calls no-op harmlessly on an illegal self-transition (e.g.
			// if already in burn_confirmed), so this is safe regardless of which
			// of the two states it's currently in.
			log.Printf("bridge reconciler: resuming stale transfer %s from state %s", s.id, s.state)
			h.runBridgeToSettlement(ctx, s.intentID, s.id, *s.sourceTxHash)

		case bridgepkg.StateAttestationPending, bridgepkg.StateAttested, bridgepkg.StateOrphaned:
			if s.state != string(bridgepkg.StateOrphaned) {
				h.setState(ctx, s.id, bridgepkg.StateOrphaned)
			}
			if s.attestation != nil && s.msg != nil {
				att := bridgepkg.Attestation{
					SourceTxHash:     derefOr(s.sourceTxHash, ""),
					AttestationBytes: mustDecodeHex(*s.attestation),
					Message:          mustDecodeHex(*s.msg),
					Status:           "complete",
				}
				log.Printf("bridge reconciler: completing orphaned transfer %s from persisted attestation", s.id)
				h.completeMintAndSettle(ctx, s.intentID, s.id, att)
				continue
			}
			log.Printf("bridge reconciler: re-polling attestation for orphaned transfer %s", s.id)
			att, err := h.Provider.PollAttestation(ctx, *s.sourceTxHash)
			if err != nil {
				log.Printf("bridge reconciler: PollAttestation failed for transfer %s: %v", s.id, err)
				continue
			}
			h.setState(ctx, s.id, bridgepkg.StateMintSubmitted) // orphaned -> mint_submitted is the one legal move
			h.completeMintAndSettle(ctx, s.intentID, s.id, att)

		case bridgepkg.StateMinted:
			// Minting itself already succeeded and must never be retried (CCTP's
			// nonce-consumption makes a second attempt actively wrong, not just
			// redundant) -- only the settlement leg failed. Call
			// settleBridgedIntent directly, NOT completeMintAndSettle -- that
			// function's own "already minted" guard would just no-op here.
			log.Printf("bridge reconciler: retrying settlement handoff for transfer %s (already minted)", s.id)
			if err := h.settleBridgedIntent(ctx, s.intentID); err != nil {
				log.Printf("bridge reconciler: settlement retry failed for intent %s: %v", s.intentID, err)
				continue
			}
			h.setState(ctx, s.id, bridgepkg.StateHandoffToSettlement)
		}
	}
}

func derefOr(s *string, fallback string) string {
	if s == nil {
		return fallback
	}
	return *s
}

func mustDecodeHex(s string) []byte {
	b, err := hex.DecodeString(strings.TrimPrefix(s, "0x"))
	if err != nil {
		return nil
	}
	return b
}
