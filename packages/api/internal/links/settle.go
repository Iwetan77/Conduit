// Package links holds the one statement that decides what happens to a payment
// link when a payment against it actually settles.
//
// It lives in its own package because three separate call sites run it -- the
// StableFX confirm path, the direct-settlement record path (both in
// handlers/settlement_intents.go) and the on-chain indexer -- and they had
// drifted into three copies of the same SQL. All three copies shared the same
// bug: they closed the link unconditionally, ignoring reuse_policy, so the
// first customer to pay a multi_use link retired it for everyone after them.
// That silently broke every reusable QR in the product, storefronts included.
package links

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// SettleByIntentSQL closes (or re-arms) the link behind a settled intent,
// selected by settlement_intent id. $1 = intent id.
//
// A single_use link becomes 'paid', which is what makes Pay() reject any
// further attempt -- that is the double-payment guard. A multi_use link is
// instead returned to 'active': it is a standing QR, and being paid is the
// normal case, not the end of its life. Resetting to 'active' rather than
// leaving it at 'viewed' states what is true -- it is live and ready for the
// next customer.
//
// The status guard keeps the transition one-way for terminal states, so a
// replayed webhook or a re-indexed block can't resurrect a voided link.
const SettleByIntentSQL = `UPDATE payment_links
	    SET status = CASE WHEN reuse_policy = 'multi_use' THEN 'active' ELSE 'paid' END,
	        updated_at = now()
	  WHERE id = (SELECT payment_link_id FROM settlement_intents WHERE id = $1)
	    AND status NOT IN ('paid','settled','void')`

// SettleByDeclarationSQL is SettleByIntentSQL keyed by the on-chain declaration
// id instead, which is all the indexer has when it sees a settlement event.
// $1 = declaration id.
const SettleByDeclarationSQL = `UPDATE payment_links
	    SET status = CASE WHEN reuse_policy = 'multi_use' THEN 'active' ELSE 'paid' END,
	        updated_at = now()
	  WHERE id = (SELECT payment_link_id FROM settlement_intents WHERE declaration_id = $1)
	    AND status NOT IN ('paid','settled','void')`

// Querier is the read surface SettledPayload needs — satisfied by both
// *pgxpool.Pool and pgx.Tx, so callers pass whichever they already hold.
type Querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// These read everything a webhook consumer needs to identify WHAT was paid.
// Two constants rather than one interpolated query: the selector is a column
// name, and a column name never belongs in a format string.
const settledContextByIntent = `SELECT payment_link_id, reference, payer_reference, amount::text, settle_currency
	 FROM settlement_intents WHERE id = $1`

const settledContextByDeclaration = `SELECT payment_link_id, reference, payer_reference, amount::text, settle_currency
	 FROM settlement_intents WHERE declaration_id = $1`

// SettledPayload builds the body of a settlement.succeeded webhook.
//
// It carries more than the intent id because the intent id is the one
// identifier the merchant's system has never seen before. A restaurant till
// creates a payment link per bill and knows that link's id and its own bill
// number; the intent is minted later, when the diner opens checkout. A payload
// of only intent_id therefore couldn't be mapped back to a bill without a
// second API call, which is why polling used to be the only workable option
// for a point-of-sale.
//
// payment_link_id and merchant_reference close that gap. amount and
// settle_currency are included so a till can assert the money that arrived
// matches the bill it printed rather than assuming it.
//
// Enrichment never blocks the webhook: if the lookup fails, the caller still
// gets the core fields. A delivered-but-thin event beats a dropped one.
func SettledPayload(ctx context.Context, q Querier, intentID, txHash string) map[string]any {
	return settledPayload(ctx, q, settledContextByIntent, intentID, intentID, txHash)
}

// SettledPayloadByDeclaration is SettledPayload for callers holding only the
// on-chain declaration id — the indexer, which sees a settlement event before
// it has resolved an intent.
func SettledPayloadByDeclaration(ctx context.Context, q Querier, declarationID, intentID, txHash string) map[string]any {
	return settledPayload(ctx, q, settledContextByDeclaration, declarationID, intentID, txHash)
}

func settledPayload(ctx context.Context, q Querier, query, key, intentID, txHash string) map[string]any {
	payload := map[string]any{
		"intent_id": intentID,
		"tx_hash":   txHash,
		"status":    "settled",
	}
	if q == nil {
		return payload
	}

	var linkID, reference, payerReference *string
	var amount, settleCurrency string
	if err := q.QueryRow(ctx, query, key).
		Scan(&linkID, &reference, &payerReference, &amount, &settleCurrency); err != nil {
		return payload
	}

	payload["amount"] = amount
	payload["settle_currency"] = settleCurrency
	if linkID != nil {
		payload["payment_link_id"] = *linkID
	}
	// A link's merchant_reference is copied onto the intent's `reference` when
	// the link is paid, so this is the merchant's own bill number either way.
	if reference != nil {
		payload["merchant_reference"] = *reference
	}
	if payerReference != nil {
		payload["payer_reference"] = *payerReference
	}
	return payload
}
