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
// recent forward progress and completes them without a payer present. Once
// a burn intent is submitted to Gateway, it's irreversible -- not just once
// attested -- so this covers every state from burn_submitted onward, not
// only the formally-"orphaned"-eligible attestation_pending/attested states.
//
// Call on an interval from cmd/api; safe to call concurrently with a live
// session driving the same row (every write re-checks state first).
func (h *Bridge) ReconcileOrphanedBridges(ctx context.Context) {
	staleAfter := h.StaleAfter
	if staleAfter <= 0 {
		staleAfter = 45 * time.Second
	}
	rows, err := h.Pool.Query(ctx,
		`SELECT id, intent_id, state, source_tx_hash, attestation, mint_tx_hash, minted_amount::text
		 FROM bridge_transfers
		 WHERE state IN ('burn_submitted', 'burn_confirmed', 'attestation_pending', 'attested', 'orphaned', 'minted')
		 AND updated_at < $1`,
		time.Now().Add(-staleAfter),
	)
	if err != nil {
		log.Printf("bridge reconciler: query failed: %v", err)
		return
	}
	type stuck struct {
		id, intentID, state             string
		sourceTxHash, gatewayTransferID *string
		mintTxHash, mintedAmount        *string
	}
	var stuckRows []stuck
	for rows.Next() {
		var s stuck
		if err := rows.Scan(&s.id, &s.intentID, &s.state, &s.sourceTxHash, &s.gatewayTransferID, &s.mintTxHash, &s.mintedAmount); err != nil {
			log.Printf("bridge reconciler: scan failed: %v", err)
			continue
		}
		stuckRows = append(stuckRows, s)
	}
	rows.Close()

	for _, s := range stuckRows {
		switch bridgepkg.State(s.state) {
		case bridgepkg.StateBurnSubmitted, bridgepkg.StateBurnConfirmed:
			// A row stuck this early means the burn-intent signature was
			// reported but the background goroutine that calls Fund() died
			// before submitting it. Nothing to resume without the payer's
			// signature bytes, which aren't persisted at this stage (only
			// the message they signed is) -- this is a real, honest gap:
			// see docs/ubk-capability.md's "what breaks" notes. Mark failed
			// rather than silently stalling forever.
			log.Printf("bridge reconciler: transfer %s stuck before Fund() with no recoverable signature, marking failed", s.id)
			h.setState(ctx, s.id, bridgepkg.StateFailed)

		case bridgepkg.StateAttestationPending, bridgepkg.StateAttested, bridgepkg.StateOrphaned:
			if s.state != string(bridgepkg.StateOrphaned) {
				h.setState(ctx, s.id, bridgepkg.StateOrphaned)
			}
			if s.gatewayTransferID == nil || *s.gatewayTransferID == "" {
				log.Printf("bridge reconciler: transfer %s has no gateway transfer id yet, cannot poll", s.id)
				continue
			}
			log.Printf("bridge reconciler: resuming poll for orphaned transfer %s", s.id)
			h.setState(ctx, s.id, bridgepkg.StateMintSubmitted)
			h.pollAndCompleteFunding(ctx, s.intentID, s.id, *s.gatewayTransferID)

		case bridgepkg.StateMinted:
			// Minting itself already succeeded -- only the settlement leg
			// failed. Call settleBridgedIntent directly, not
			// pollAndCompleteFunding, whose own "already minted" guard would
			// just no-op here.
			log.Printf("bridge reconciler: retrying settlement handoff for transfer %s (already minted)", s.id)

			// The verified funding amount, on the same terms as the live path.
			// This runs with no payer present and pays out of the relayer, so
			// it must not be the one place that settles an unverified figure.
			// Rows minted before minted_amount was recorded carry NULL, so the
			// chain is re-read for them rather than assuming the intent amount.
			minted, merr := h.mintedAmountFor(ctx, s.mintedAmount, s.mintTxHash)
			if merr != nil {
				log.Printf("bridge reconciler: cannot establish funded amount for transfer %s: %v", s.id, merr)
				h.setState(ctx, s.id, bridgepkg.StateFailed)
				continue
			}
			if err := h.settleBridgedIntent(ctx, s.intentID, minted); err != nil {
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
