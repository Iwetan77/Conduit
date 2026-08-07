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

	CodeLinkExpired           Code = "payment_link_expired"
	CodeLinkVoided            Code = "payment_link_voided"
	CodeLinkAlreadyUsed       Code = "payment_link_already_used"
	CodeLinkAmountOutOfBounds Code = "payment_link_amount_out_of_bounds"
	CodeLinkAmountRequired    Code = "payment_link_amount_required"
)

type entry struct {
	status  int
	message string
}

var registry = map[Code]entry{
	CodeFxQuoteExpired:        {http.StatusConflict, "The FX quote has expired. Request a new quote."},
	CodeFxNoRoute:             {http.StatusUnprocessableEntity, "No route exists between these currencies right now."},
	// Measured against the live provider: the floor is ~1.00 USD of value, on
	// the amount being converted -- not a per-currency rule. It bites hardest on
	// low-unit-value currencies (1 ZAR is about 6 US cents, so "10 ZAR" is only
	// ~57c and is rejected while "10 BRL" is ~$1.97 and goes through), which
	// read as "ZAR is broken" rather than "that amount is too small". Say the
	// actual number so the payer can act on it.
	CodeFxInvalidAmount:       {http.StatusUnprocessableEntity, "Amount is too small to convert — it must be worth at least about 1.00 USD. Try a larger amount."},
	CodeFxProviderUnavailable: {http.StatusServiceUnavailable, "The FX provider is temporarily unavailable."},
	CodeCurrencyNotSupported:  {http.StatusUnprocessableEntity, "This currency is not currently supported."},
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

	CodeLinkExpired:           {http.StatusConflict, "This payment link has expired."},
	CodeLinkVoided:            {http.StatusConflict, "This payment link has been voided."},
	CodeLinkAlreadyUsed:       {http.StatusConflict, "This single-use payment link has already been paid."},
	CodeLinkAmountOutOfBounds: {http.StatusUnprocessableEntity, "The amount is outside this link's allowed range."},
	CodeLinkAmountRequired:    {http.StatusBadRequest, "An amount is required for this payment link."},
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
