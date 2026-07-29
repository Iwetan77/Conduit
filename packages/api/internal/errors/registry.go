// Package errors is the single source of truth mapping an internal error code
// to an HTTP status, a client-facing message, and a docs slug. No raw revert
// string or upstream provider error body should ever reach a client — handlers
// must translate through Lookup() or E() before writing a response.
package errors

import "net/http"

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
)

type entry struct {
	status  int
	message string
}

var registry = map[Code]entry{
	CodeFxQuoteExpired:        {http.StatusConflict, "The FX quote has expired. Request a new quote."},
	CodeFxNoRoute:             {http.StatusUnprocessableEntity, "No route exists between these currencies right now."},
	CodeFxInvalidAmount:       {http.StatusUnprocessableEntity, "This amount is outside the FX provider's quotable range (too small or too large)."},
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
		DocURL:  "https://docs.conduit.xyz/errors/" + string(code),
		Status:  entry.status,
	}
}
