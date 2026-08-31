package handlers

// Where money goes is decided in one place.
//
// settle_address used to arrive in the request body of five different endpoints,
// which meant five different opportunities for a caller — an sk_ key, a
// dashboard bug, anyone who could reach the route — to mint an invoice under a
// merchant's name and brand that paid somewhere else entirely. The address was
// never checked against the account it was being created for.
//
// Now there is exactly one source: the owning account's own settle_address,
// read at creation and snapshotted into the row. That snapshot behaviour is
// unchanged and must stay — an intent records where it was going when it was
// made, so changing an account's address later cannot silently redirect a
// payment somebody already agreed to.

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
	apierrors "github.com/kzn-labs/conduit/api/internal/errors"
)

// deriveSettleAddress reads the address an account settles to.
//
// For a storefront this is the storefront's own row, which inherited its
// parent's address when it was created — so a sub-account is answered here
// without a special case, and a parent that later moves its settlement does not
// silently drag its storefronts along.
func deriveSettleAddress(ctx context.Context, pool *pgxpool.Pool, accountID string) (string, *apierrors.APIError) {
	var addr string
	if err := pool.QueryRow(ctx,
		`SELECT settle_address FROM accounts WHERE id = $1`, accountID,
	).Scan(&addr); err != nil {
		return "", apierrors.E(apierrors.CodeNotFound, "account")
	}
	if addr == "" {
		// Not reachable through any current path — settle_address is NOT NULL
		// and every writer sets it — but an empty one would mean minting an
		// intent payable to nowhere, and failing loudly beats recording that.
		return "", apierrors.E(apierrors.CodeSettlementWalletRequired, "")
	}
	return addr, nil
}

// rejectSuppliedSettleAddress refuses a request that still carries one.
//
// Rejecting rather than ignoring, deliberately. Silently dropping a field that
// says where money goes is worse than breaking the caller: an integration would
// keep sending an address, keep getting 201 back, and be paid somewhere other
// than it asked for with nothing anywhere reporting a problem. A 400 is a bug
// report delivered to the person who can fix it.
//
// A present-but-null value is not an assertion about anything, so it passes.
func rejectSuppliedSettleAddress(v *string) *apierrors.APIError {
	if v == nil {
		return nil
	}
	return apierrors.E(apierrors.CodeSettleAddressDerived, "settle_address")
}
