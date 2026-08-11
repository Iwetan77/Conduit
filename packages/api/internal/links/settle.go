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
