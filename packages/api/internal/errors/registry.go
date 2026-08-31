// Package errors is the single source of truth mapping an internal error code
// to an HTTP status, a client-facing message, and a docs slug. No raw revert
// string or upstream provider error body should ever reach a client — handlers
// must translate through Lookup() or E() before writing a response.
package errors

import (
	"net/http"
	"os"
	"strings"
)

type Code string

const (
	CodeFxQuoteExpired        Code = "fx_quote_expired"
	CodeFxNoRoute             Code = "fx_no_route"
	CodeFxInvalidAmount       Code = "fx_invalid_amount"
	CodeFxProviderUnavailable Code = "fx_provider_unavailable"
	CodeCurrencyNotSupported  Code = "currency_not_supported"
	CodeIntentExpired         Code = "intent_expired"
	CodeIntentAlreadySettled  Code = "intent_already_settled"
	CodeIdempotencyKeyReuse   Code = "idempotency_key_reuse"
	CodeSignatureInvalid      Code = "signature_invalid"
	CodeInsufficientBalance   Code = "insufficient_payer_balance"
	CodeInvalidRequest        Code = "invalid_request"
	CodeNotFound              Code = "not_found"
	CodeUnauthorized          Code = "unauthorized"
	CodeForbidden             Code = "forbidden"
	CodeInternal              Code = "internal_error"
	CodeRateLimited           Code = "rate_limited"

	CodeUsernameTaken      Code = "username_taken"
	CodeUsernameAlreadySet Code = "username_already_set"

	CodeLinkExpired           Code = "payment_link_expired"
	CodeLinkVoided            Code = "payment_link_voided"
	CodeLinkAlreadyUsed       Code = "payment_link_already_used"
	CodeLinkAmountOutOfBounds Code = "payment_link_amount_out_of_bounds"
	CodeLinkAmountRequired    Code = "payment_link_amount_required"

	CodeSettlementWalletRequired Code = "settlement_wallet_required"
	CodeSettlementWalletUnknown  Code = "settlement_wallet_unknown"
	CodeSettlementWalletInvalid  Code = "settlement_wallet_invalid"
	CodeSettlementWalletSet      Code = "settlement_wallet_already_set"
	CodeSettleAddressDerived     Code = "settle_address_derived"

	CodePayoutChallengeRequired Code = "payout_challenge_required"
	CodePayoutChallengeExpired  Code = "payout_challenge_expired"
	CodePayoutUnverified        Code = "payout_destination_unverified"
	CodePayoutNotOnChain        Code = "payout_not_found_on_chain"
	CodeUpstreamUnavailable     Code = "upstream_unavailable"
	CodeConfirmationMismatch    Code = "confirmation_mismatch"
)

type entry struct {
	status  int
	message string
}

var registry = map[Code]entry{
	CodeFxQuoteExpired: {http.StatusConflict, "The FX quote has expired. Request a new quote."},
	CodeFxNoRoute:      {http.StatusUnprocessableEntity, "No route exists between these currencies right now."},
	// Measured against the live provider: the floor is ~1.00 USD of value, on
	// the amount being converted -- not a per-currency rule. It bites hardest on
	// low-unit-value currencies (1 ZAR is about 6 US cents, so "10 ZAR" is only
	// ~57c and is rejected while "10 BRL" is ~$1.97 and goes through), which
	// read as "ZAR is broken" rather than "that amount is too small". Say the
	// actual number so the payer can act on it.
	CodeFxInvalidAmount:       {http.StatusUnprocessableEntity, "Amount is too small to convert — it must be worth at least about 1.00 USD. Try a larger amount."},
	CodeFxProviderUnavailable: {http.StatusServiceUnavailable, "The FX provider is temporarily unavailable."},
	CodeCurrencyNotSupported:  {http.StatusUnprocessableEntity, "This currency is not currently supported."},
	CodeRateLimited:           {http.StatusTooManyRequests, "Too many requests. Slow down and try again shortly."},
	CodeIntentExpired:         {http.StatusConflict, "This settlement intent has expired."},
	CodeIntentAlreadySettled:  {http.StatusConflict, "This settlement intent has already settled."},
	CodeIdempotencyKeyReuse:   {http.StatusConflict, "This idempotency key was already used with a different request body."},
	CodeSignatureInvalid:      {http.StatusBadRequest, "The provided signature is invalid."},
	CodeInsufficientBalance:   {http.StatusUnprocessableEntity, "The payer does not hold enough balance to fund this payment."},
	CodeInvalidRequest:        {http.StatusBadRequest, "The request could not be processed."},
	CodeNotFound:              {http.StatusNotFound, "The requested resource was not found."},
	CodeUnauthorized:          {http.StatusUnauthorized, "Missing or invalid API key."},
	CodeForbidden:             {http.StatusForbidden, "This API key is not permitted to perform this action."},
	CodeInternal:              {http.StatusInternalServerError, "An internal error occurred."},

	// 409 rather than 400: the request was well formed and the name was free
	// when the sender last looked. Somebody else simply got there first, and
	// that is a state conflict, not a mistake by the caller.
	CodeUsernameTaken: {http.StatusConflict, "That username is already taken."},
	// A username is what other people save and send money to, so it is claimed
	// once. Reassigning one would let a payment addressed from memory land with
	// whoever picked up the abandoned name.
	CodeUsernameAlreadySet: {http.StatusConflict, "This account already has a username."},

	CodeLinkExpired:           {http.StatusConflict, "This payment link has expired."},
	CodeLinkVoided:            {http.StatusConflict, "This payment link has been voided."},
	CodeLinkAlreadyUsed:       {http.StatusConflict, "This single-use payment link has already been paid."},
	CodeLinkAmountOutOfBounds: {http.StatusUnprocessableEntity, "The amount is outside this link's allowed range."},
	CodeLinkAmountRequired:    {http.StatusBadRequest, "An amount is required for this payment link."},

	// 409, not 422: the request is fine and the account is simply not ready
	// yet. Refusing here is the point -- the alternative is a settlement
	// pointed at whichever wallet the owner happened to sign in with, which is
	// how business income ends up in someone's personal wallet without anyone
	// deciding that it should.
	CodeSettlementWalletRequired: {http.StatusConflict, "This account has no settlement wallet yet. Finish setting one up before taking payments."},
	// 403 rather than 404: the wallet may well exist, just not for this user.
	// Saying which would let a caller enumerate other people's wallet ids.
	CodeSettlementWalletUnknown: {http.StatusForbidden, "That wallet does not belong to the signed-in user."},
	CodeSettlementWalletInvalid: {http.StatusUnprocessableEntity, "That wallet cannot be used for settlement."},
	// Moving where income lands is a deliberate act with its own confirmation,
	// not something a repeated provisioning call should do quietly.
	CodeSettlementWalletSet: {http.StatusConflict, "This account already has a settlement wallet."},
	// 400 rather than ignoring the field. An integration that keeps sending an
	// address and keeps getting 201 back would be paid somewhere other than it
	// asked for, with nothing anywhere reporting a problem.
	CodeSettleAddressDerived: {http.StatusBadRequest, "settle_address is derived from the account and can no longer be set on this request. Remove it."},

	CodePayoutChallengeRequired: {http.StatusConflict, "Request a challenge for this destination before verifying it."},
	// A fresh challenge rather than a retry: the nonce is single-use, so an
	// expired one cannot simply be signed again.
	CodePayoutChallengeExpired: {http.StatusConflict, "That verification challenge is no longer valid. Request a new one."},
	// The whole point of the destination model. A withdrawal is on-chain and
	// final, and an address nobody has proven control of is indistinguishable
	// from a typo until the money has gone.
	CodePayoutUnverified: {http.StatusConflict, "This payout destination has not been verified. Prove control of it before withdrawing to it."},
	// 422 rather than 404: the transaction may well exist and simply not be the
	// transfer this payout describes. A ledger built from what a client says
	// happened is a ledger that can be told anything.
	CodePayoutNotOnChain: {http.StatusUnprocessableEntity, "That transaction does not contain the transfer this payout describes."},
	// The chain could not be asked. Distinct from a definite no, because
	// retrying is the right response to one and not the other.
	CodeUpstreamUnavailable: {http.StatusServiceUnavailable, "A service this request depends on is temporarily unavailable."},
	// Not security -- anyone who can make this call can read the name. It is
	// friction, which is the right tool for a change that sends future income
	// somewhere we cannot reach it.
	CodeConfirmationMismatch: {http.StatusBadRequest, "That does not match the account name. Type it exactly to confirm."},
}

// APIError is what handlers return; the HTTP layer renders it to the
// {"error":{...}} envelope documented in the v2 build spec §2.6.
type APIError struct {
	Code    Code   `json:"code"`
	Type    string `json:"type"`
	Message string `json:"message"`
	Param   string `json:"param,omitempty"`
	DocURL  string `json:"doc_url"`
	Status  int    `json:"-"`
}

func (e *APIError) Error() string { return e.Message }

// E constructs an APIError from a registered code. Panics on an unregistered
// code — that's a programmer error caught at development time, not something
// that should ever reach a client as a 500 with no explanation.
// docsBaseURL is the docs ROOT (e.g. https://your-app/docs). Error codes are
// documented in the errors guide, so links are built as
// {root}/guides/errors#{code} — the route that actually exists. The old
// hardcoded https://docs.conduit.xyz/errors/{code} was a dead link on every
// error response: that domain does not exist and docs were folded into the
// app.
//
// Resolution order:
//  1. CONDUIT_DOCS_BASE_URL — an explicit docs root, for a deployment that
//     serves docs somewhere other than {app}/docs.
//  2. CONDUIT_APP_BASE_URL + "/docs" — docs live inside the app, so the one
//     var every deployment already sets is enough. Deriving it here is what
//     stops production from shipping localhost links in error responses
//     because a second, easily-forgotten var was never set.
//  3. local dev.
var docsBaseURL = func() string {
	if v := strings.TrimRight(strings.TrimSpace(os.Getenv("CONDUIT_DOCS_BASE_URL")), "/"); v != "" {
		return v
	}
	if v := strings.TrimRight(strings.TrimSpace(os.Getenv("CONDUIT_APP_BASE_URL")), "/"); v != "" {
		return v + "/docs"
	}
	return "http://localhost:3000/docs"
}()

func E(code Code, param string) *APIError {
	entry, ok := registry[code]
	if !ok {
		panic("errors: unregistered code: " + string(code))
	}
	return &APIError{
		Code:    code,
		Type:    "conduit_error",
		Message: entry.message,
		Param:   param,
		DocURL:  docsBaseURL + "/guides/errors#" + string(code),
		Status:  entry.status,
	}
}
