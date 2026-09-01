package handlers

// Finishing FX trades whose worker did not.
//
// `Confirm` hands Circle the funding signature, writes `state='submitted'`, and
// returns 202 — then a detached goroutine waits for the maker leg and records
// the settlement. That goroutine is in memory. A deploy, a crash, or an OOM
// kill takes it with them, and the money still moves: Circle's relayer does not
// care that the process that asked is gone.
//
// So the trade would sit at 'submitted' forever, with the merchant never
// credited and no webhook fired, over a payment that succeeded. That is the
// failure this exists to make impossible, and it is why the state transition is
// written BEFORE the wait rather than after it — a durable record that
// something is in flight is what makes the in-flight thing recoverable.
//
// Deliberately does the same writes as the worker, through the same function.
// Two versions of "what a settled trade means" would eventually disagree, and
// the one that drifts is always the reconciler, because it is the one nobody
// watches.

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/kzn-labs/conduit/api/internal/fx"
)

// How long a trade may sit at 'submitted' before it is presumed orphaned.
//
// Comfortably longer than the worker's own 60s deadline, so a trade that is
// simply still settling is never picked up alongside the worker that is already
// waiting on it. Racing itself is survivable — recordFXSettlement is idempotent
// on the state transition — but doing it routinely would mean polling Circle
// twice for every payment.
const fxOrphanAfter = 3 * time.Minute

// ReconcileSubmittedFX finds trades left in flight and finishes them.
func (h *SettlementIntents) ReconcileSubmittedFX(ctx context.Context) {
	rows, err := h.Pool.Query(ctx,
		`SELECT ft.id, ft.intent_id, si.account_id, ft.stablefx_trade_uuid,
		        ft.witness, ft.witness_type_string
		   FROM fx_trades ft
		   JOIN settlement_intents si ON si.id = ft.intent_id
		  WHERE ft.state = 'submitted'
		    AND ft.updated_at < now() - $1::interval
		  ORDER BY ft.updated_at
		  LIMIT 25`,
		fxOrphanAfter.String())
	if err != nil {
		log.Printf("fx reconciler: %v", err)
		return
	}

	type orphan struct {
		tradeID, intentID, accountID, tradeUUID, permit2JSON, witnessMessage string
	}
	var orphans []orphan
	for rows.Next() {
		var o orphan
		if err := rows.Scan(&o.tradeID, &o.intentID, &o.accountID, &o.tradeUUID,
			&o.permit2JSON, &o.witnessMessage); err != nil {
			rows.Close()
			log.Printf("fx reconciler: scan: %v", err)
			return
		}
		orphans = append(orphans, o)
	}
	rows.Close()

	for _, o := range orphans {
		var permit2 struct{ Token, Amount, Spender, Nonce, Deadline string }
		_ = json.Unmarshal([]byte(o.permit2JSON), &permit2)

		prep := fx.Preparation{
			StableFXTradeID: o.tradeUUID, StableFXPermittedToken: permit2.Token,
			StableFXPermittedAmount: permit2.Amount, StableFXSpender: permit2.Spender,
			StableFXNonce: permit2.Nonce, StableFXDeadline: permit2.Deadline,
			StableFXWitnessMessage: []byte(o.witnessMessage),
		}

		// Asked, not re-submitted. The funding signature was already accepted;
		// sending it again would be asking Circle to fund a trade twice.
		txHash, err := h.StableFX.AwaitSettlement(ctx, prep)
		if err != nil {
			log.Printf("fx reconciler: trade=%s intent=%s still unresolved: %v", o.tradeID, o.intentID, err)
			// Left at 'submitted' on purpose. A trade Circle has not finished
			// is not a trade that failed, and marking it failed here would
			// tell a merchant their payment did not happen while it is still
			// happening. The next sweep asks again.
			continue
		}
		log.Printf("fx reconciler: trade=%s intent=%s settled by reconciliation", o.tradeID, o.intentID)
		h.recordFXSettlement(ctx, o.intentID, o.accountID, o.tradeID, txHash)
	}
}
