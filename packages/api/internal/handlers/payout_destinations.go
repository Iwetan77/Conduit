package handlers

// Addresses a business can withdraw TO.
//
// Not the same thing as where its income routes. The old model had one address
// doing both jobs, so "move some money to my treasury" and "every future
// payment should land in my treasury" were the same irreversible edit. Split
// apart, an external address can be added, proven, and paid to deliberately,
// while nothing is ever ROUTED somewhere unproven.
//
// The proof matters because the mistake is unrecoverable. A withdrawal is an
// on-chain transfer and final, and an address that is well-formed but not yours
// is indistinguishable from one that is right up until the money has gone.
// Twenty bytes of valid hex is not evidence of anything: it covers a wallet on
// another chain, an exchange deposit address that will never credit an Arc
// token, a contract that cannot receive, and every typo that happens to land in
// range. A signature is the only thing that separates them.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kzn-labs/conduit/api/internal/arcrpc"
	"github.com/kzn-labs/conduit/api/internal/auth"
	apierrors "github.com/kzn-labs/conduit/api/internal/errors"
	"github.com/kzn-labs/conduit/api/internal/models"
)

type PayoutDestinations struct {
	Pool *pgxpool.Pool
	// ArcRPC is needed for contract wallets: a Safe or any other smart-contract
	// account cannot produce an ECDSA signature that recovers to its own
	// address, so proving control means asking the contract itself (EIP-1271).
	ArcRPC string
}

// How long a challenge is worth answering.
//
// Long enough to open a wallet, read the message and approve it; short enough
// that a nonce left in a chat log or a screenshot is not a standing key to
// somebody's payout list. It is single-use as well, so this only bounds the
// window in which an unused one is worth stealing.
const payoutNonceTTL = 15 * time.Minute

type payoutDestination struct {
	ID         string     `json:"id"`
	Address    string     `json:"address"`
	Label      *string    `json:"label"`
	VerifiedAt *time.Time `json:"verified_at"`
	CreatedAt  time.Time  `json:"created_at"`
	// Verified is the same fact as VerifiedAt, said in the form the UI actually
	// branches on. Present always, never omitted: absent and false have to mean
	// the same thing to a client, and only one of them does if it is omitted.
	Verified bool `json:"verified"`
}

// challengeMessage is what the owner signs.
//
// Deliberately readable in a wallet's signing dialog, and deliberately specific:
// it names Conduit, names the action, and names the address and the nonce. A
// signature request that reads as opaque hex teaches people to approve opaque
// hex, and the whole value of this step is that somebody looked at it.
//
// The address is included so a signature captured for one destination cannot be
// presented for another, and the nonce so it cannot be presented twice.
func challengeMessage(address, nonce string) string {
	return fmt.Sprintf(
		"Conduit: confirm this payout address\n\nAddress: %s\nNonce: %s",
		strings.ToLower(address), nonce,
	)
}

func newNonce() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// Create is POST /v1/payout_destinations.
//
// Stored unverified, always. There is no path here that adds a destination
// ready to be paid: the address arrives from a human typing or pasting, which
// is precisely the input that cannot be trusted.
func (h *PayoutDestinations) Create(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}
	var req struct {
		Address string `json:"address"`
		Label   string `json:"label"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "body"))
		return
	}
	req.Address = strings.TrimSpace(req.Address)
	if !common.IsHexAddress(req.Address) {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "address"))
		return
	}
	// Refusing the account's own settlement address is not pedantry: a
	// withdrawal to it is a transfer that costs gas and moves nothing, and
	// offering it as a destination invites exactly that.
	var settleAddress string
	if err := h.Pool.QueryRow(r.Context(),
		`SELECT settle_address FROM accounts WHERE id = $1`, principal.AccountID,
	).Scan(&settleAddress); err == nil && strings.EqualFold(settleAddress, req.Address) {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "address is this account's own settlement address"))
		return
	}

	id := models.NewID("pd")
	var out payoutDestination
	err := h.Pool.QueryRow(r.Context(),
		`INSERT INTO payout_destinations (id, account_id, address, label)
		 VALUES ($1,$2,$3,$4)
		 ON CONFLICT (account_id, lower(address)) DO UPDATE
		    SET label = COALESCE(EXCLUDED.label, payout_destinations.label)
		 RETURNING id, address, label, verified_at, created_at`,
		id, principal.AccountID, req.Address, nullIfEmpty(req.Label),
	).Scan(&out.ID, &out.Address, &out.Label, &out.VerifiedAt, &out.CreatedAt)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	// Adding an address that is already there returns the existing row rather
	// than a duplicate or an error. Re-adding is what somebody does when they
	// are not sure it saved, and it must never reset a verification they have
	// already completed.
	out.Verified = out.VerifiedAt != nil
	writeJSON(w, http.StatusCreated, out)
}

// List is GET /v1/payout_destinations.
func (h *PayoutDestinations) List(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}
	rows, err := h.Pool.Query(r.Context(),
		`SELECT id, address, label, verified_at, created_at
		   FROM payout_destinations WHERE account_id = $1
		  ORDER BY created_at DESC`,
		principal.AccountID,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	defer rows.Close()
	out := []payoutDestination{}
	for rows.Next() {
		var d payoutDestination
		if err := rows.Scan(&d.ID, &d.Address, &d.Label, &d.VerifiedAt, &d.CreatedAt); err != nil {
			writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
			return
		}
		d.Verified = d.VerifiedAt != nil
		out = append(out, d)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

// Challenge is POST /v1/payout_destinations/{id}/challenge — issues the nonce
// and returns the exact message to sign.
//
// The server issues it rather than accepting a client-chosen one, because a
// nonce the caller picks proves nothing: the point is that WE decide what has to
// be signed, so a signature can only have been produced after we asked.
func (h *PayoutDestinations) Challenge(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}
	id := pathParam(r, "id")
	nonce, err := newNonce()
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	// Re-issuing replaces any outstanding nonce, so only the newest challenge is
	// answerable. Two live challenges for one address would mean a signature
	// from the older one still worked after the owner had moved on.
	var address string
	err = h.Pool.QueryRow(r.Context(),
		`UPDATE payout_destinations
		    SET verification_nonce = $1, nonce_expires_at = now() + $2::interval
		  WHERE id = $3 AND account_id = $4
		  RETURNING address`,
		nonce, fmt.Sprintf("%d seconds", int(payoutNonceTTL.Seconds())), id, principal.AccountID,
	).Scan(&address)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
		return
	}
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"message":    challengeMessage(address, nonce),
		"expires_in": int(payoutNonceTTL.Seconds()),
	})
}

// Verify is POST /v1/payout_destinations/{id}/verify.
//
// Two kinds of wallet, two kinds of proof, and the second is not optional: a
// Safe or any other smart-contract account holds no private key of its own, so
// it cannot produce a signature that recovers to its own address. Supporting
// only ECDSA would mean a business whose treasury is a multisig -- exactly the
// business most likely to want a separate payout address -- could never verify
// one.
func (h *PayoutDestinations) Verify(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}
	id := pathParam(r, "id")
	var req struct {
		Signature string `json:"signature"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Signature) == "" {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "signature"))
		return
	}

	var address string
	var nonce *string
	var expiresAt *time.Time
	var verifiedAt *time.Time
	err := h.Pool.QueryRow(r.Context(),
		`SELECT address, verification_nonce, nonce_expires_at, verified_at
		   FROM payout_destinations WHERE id = $1 AND account_id = $2`,
		id, principal.AccountID,
	).Scan(&address, &nonce, &expiresAt, &verifiedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
		return
	}
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	if verifiedAt != nil {
		// Already proven. Answering with the current state rather than an error:
		// a client retrying a verification it already completed has nothing to
		// fix, and an error would send it round the loop again.
		writeJSON(w, http.StatusOK, map[string]any{"verified": true})
		return
	}
	if nonce == nil || expiresAt == nil {
		writeErr(w, apierrors.E(apierrors.CodePayoutChallengeRequired, ""))
		return
	}
	if time.Now().After(*expiresAt) {
		writeErr(w, apierrors.E(apierrors.CodePayoutChallengeExpired, ""))
		return
	}

	message := challengeMessage(address, *nonce)
	proven := verifyPersonalSign(address, message, req.Signature)
	if !proven {
		// Not an ECDSA signer, or not this one. Ask the address itself, which is
		// the only way a contract account can answer.
		proven = h.verifyContractSignature(r.Context(), address, message, req.Signature)
	}
	if !proven {
		writeErr(w, apierrors.E(apierrors.CodeSignatureInvalid, "signature"))
		return
	}

	// Clearing the nonce in the same statement is what makes it single-use. A
	// "used" flag would leave the value in place to be replayed against.
	tag, err := h.Pool.Exec(r.Context(),
		`UPDATE payout_destinations
		    SET verified_at = now(), verification_nonce = NULL, nonce_expires_at = NULL
		  WHERE id = $1 AND account_id = $2 AND verification_nonce = $3`,
		id, principal.AccountID, *nonce,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	if tag.RowsAffected() == 0 {
		// The nonce moved under us: another request answered this challenge, or
		// a new one was issued. Either way this signature is no longer the
		// answer to the outstanding question.
		writeErr(w, apierrors.E(apierrors.CodePayoutChallengeExpired, ""))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"verified": true})
}

// verifyContractSignature asks the address whether it considers the signature
// valid, per EIP-1271.
//
// Returns false on any doubt at all -- an RPC that did not answer, a return
// value that is not exactly the magic word, an address with no code. This is an
// authorization decision, and "we could not tell" has to mean no.
func (h *PayoutDestinations) verifyContractSignature(ctx context.Context, address, message, signatureHex string) bool {
	if h.ArcRPC == "" {
		return false
	}
	sig, err := decodeHexSignature(signatureHex)
	if err != nil {
		return false
	}
	// EIP-1271 takes the hash the wallet would have signed, which for a
	// personal_sign flow is the EIP-191 prefixed digest -- not the raw message.
	hash := personalSignHash(message)

	ok, err := arcrpc.IsValidERC1271Signature(ctx, h.ArcRPC, address, hash, sig)
	if err != nil {
		return false
	}
	return ok
}

// Delete is DELETE /v1/payout_destinations/{id}.
func (h *PayoutDestinations) Delete(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}
	id := pathParam(r, "id")
	tag, err := h.Pool.Exec(r.Context(),
		`DELETE FROM payout_destinations WHERE id = $1 AND account_id = $2`,
		id, principal.AccountID,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
