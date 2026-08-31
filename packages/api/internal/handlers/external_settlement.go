package handlers

// Settling directly to an address the business already owns.
//
// For a treasury or a multisig: income lands there rather than in the wallet
// Conduit provisioned, with no withdrawal step in between. A real thing real
// businesses want, and deliberately not the onboarding question -- it is the
// answer for a company with a finance function, not for someone signing up.
//
// Three properties hold this together, and none of them is decoration:
//
//   - The address can only come from an ALREADY-VERIFIED payout destination.
//     There is no free-text field anywhere in this flow, because a typed
//     settlement address is the exact hole this whole body of work closed.
//   - It is reversible in one click. The provisioned wallet is remembered, not
//     discarded, so going back needs nothing from Circle -- which matters,
//     since the server cannot mint a user token for a Google account and could
//     not look the address up again.
//   - Switching does not touch a single existing intent or link. Those
//     snapshotted their address when they were made; a payment somebody has
//     already agreed to cannot be redirected by a setting changed afterwards.

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kzn-labs/conduit/api/internal/auth"
	apierrors "github.com/kzn-labs/conduit/api/internal/errors"
)

type ExternalSettlement struct {
	Pool *pgxpool.Pool
}

// SetExternal is POST /v1/accounts/me/settlement_address/external.
//
// Takes a destination id and the account's own name typed back. The name is not
// security -- anyone who can call this can read the name -- it is friction, and
// friction is the right tool here: this is the one setting that sends future
// income somewhere Conduit cannot withdraw it from, and it should not be
// possible to do by mis-clicking.
func (h *ExternalSettlement) SetExternal(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}
	var req struct {
		DestinationID string `json:"destination_id"`
		ConfirmName   string `json:"confirm_name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "body"))
		return
	}

	var accountName string
	if err := h.Pool.QueryRow(r.Context(),
		`SELECT name FROM accounts WHERE id = $1`, principal.AccountID,
	).Scan(&accountName); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	if !strings.EqualFold(strings.TrimSpace(req.ConfirmName), strings.TrimSpace(accountName)) {
		writeErr(w, apierrors.E(apierrors.CodeConfirmationMismatch, "confirm_name"))
		return
	}

	// Verified, and this account's. The whole flow rests on it: an address
	// nobody proved control of is indistinguishable from a typo, and here the
	// consequence is not one wrong withdrawal but every future payment.
	var address string
	var verifiedAt *time.Time
	err := h.Pool.QueryRow(r.Context(),
		`SELECT address, verified_at FROM payout_destinations WHERE id = $1 AND account_id = $2`,
		strings.TrimSpace(req.DestinationID), principal.AccountID,
	).Scan(&address, &verifiedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, apierrors.E(apierrors.CodeNotFound, "destination_id"))
		return
	}
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	if verifiedAt == nil {
		writeErr(w, apierrors.E(apierrors.CodePayoutUnverified, "destination_id"))
		return
	}

	// settle_wallet_id and provisioned_address are deliberately left alone. The
	// wallet still exists and is still this account's; it simply stops being
	// where income lands. Forgetting it is what would make this one-way.
	if _, err := h.Pool.Exec(r.Context(),
		`UPDATE accounts
		    SET settle_address = $1, settle_address_source = 'external'
		  WHERE id = $2`,
		address, principal.AccountID,
	); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	h.write(w, r, principal.AccountID)
}

// Revert is POST /v1/accounts/me/settlement_address/revert — back to the wallet
// Conduit provisioned, in one call and with nothing to type.
//
// Asymmetric on purpose. Sending income somewhere Conduit cannot reach is the
// decision worth slowing down; bringing it back to the account's own wallet is
// not, and making both equally awkward would leave people stuck in the state
// they wanted to leave.
func (h *ExternalSettlement) Revert(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}
	tag, err := h.Pool.Exec(r.Context(),
		`UPDATE accounts
		    SET settle_address = provisioned_address, settle_address_source = 'provisioned'
		  WHERE id = $1 AND settle_wallet_id IS NOT NULL AND provisioned_address IS NOT NULL`,
		principal.AccountID,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	if tag.RowsAffected() == 0 {
		// No wallet to go back to. An account that was never provisioned has
		// nowhere to revert TO, and saying so beats silently doing nothing.
		writeErr(w, apierrors.E(apierrors.CodeSettlementWalletRequired, ""))
		return
	}
	h.write(w, r, principal.AccountID)
}

func (h *ExternalSettlement) write(w http.ResponseWriter, r *http.Request, accountID string) {
	var address string
	var source *string
	if err := h.Pool.QueryRow(r.Context(),
		`SELECT settle_address, settle_address_source FROM accounts WHERE id = $1`, accountID,
	).Scan(&address, &source); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"settle_address":        address,
		"settle_address_source": derefOr(source, ""),
	})
}
