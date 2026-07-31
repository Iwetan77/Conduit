package handlers

import (
	"encoding/json"
	"math/big"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kzn-labs/conduit/api/internal/auth"
	"github.com/kzn-labs/conduit/api/internal/currency"
	apierrors "github.com/kzn-labs/conduit/api/internal/errors"
	"github.com/kzn-labs/conduit/api/internal/models"
)

// PaymentLinks implements the Phase 3 policy layer on top of
// settlement_intents: amount mode/bounds, expiry, reuse policy, void, and
// two-sided references. A link never moves money itself -- Pay creates a
// settlement_intent (the existing, untouched quote/prepare/confirm flow)
// each time it's actually paid.
type PaymentLinks struct {
	Pool       *pgxpool.Pool
	AppBaseURL string
}

type createLinkRequest struct {
	AmountMode        string   `json:"amount_mode"` // fixed | open | open_with_suggested
	Amount            *big.Int `json:"amount"`      // required for fixed; suggested default for open_with_suggested; must be omitted for open
	MinAmount         *big.Int `json:"min_amount"`  // open / open_with_suggested only
	MaxAmount         *big.Int `json:"max_amount"`  // open / open_with_suggested only
	SettleCurrency    string   `json:"settle_currency"`
	SettleAddress     string   `json:"settle_address"`
	AcceptCurrencies  []string `json:"accept_currencies"`
	Description       string   `json:"description"`
	MerchantReference string   `json:"merchant_reference"`
	ReusePolicy       string   `json:"reuse_policy"` // single_use (default) | multi_use
	ExpiresIn         int64    `json:"expires_in"`   // seconds; 0/omitted = no expiry (a reusable QR isn't obligated to expire)
}

type linkResponse struct {
	ID                string     `json:"id"`
	AmountMode        string     `json:"amount_mode"`
	Amount            string     `json:"amount,omitempty"`
	MinAmount         string     `json:"min_amount,omitempty"`
	MaxAmount         string     `json:"max_amount,omitempty"`
	SettleCurrency    string     `json:"settle_currency"`
	SettleAddress     string     `json:"settle_address"`
	AcceptCurrencies  []string   `json:"accept_currencies"`
	Description       string     `json:"description,omitempty"`
	MerchantReference string     `json:"merchant_reference,omitempty"`
	ReusePolicy       string     `json:"reuse_policy"`
	Status            string     `json:"status"`
	ExpiresAt         *time.Time `json:"expires_at,omitempty"`
	Created           time.Time  `json:"created"`
	HostedURL         string     `json:"hosted_url"`
	QRPayload         string     `json:"qr_payload"`
}

// bigStrDB renders b for a nullable DB param (nil -> SQL NULL).
func bigStrDB(b *big.Int) any {
	if b == nil {
		return nil
	}
	return b.String()
}

// bigStrDisplay renders b for a response field (nil -> "", omitted via omitempty).
func bigStrDisplay(b *big.Int) string {
	if b == nil {
		return ""
	}
	return b.String()
}

// validateAmounts enforces 3.1's amount-mode rules at creation time: fixed
// needs an amount and no bounds semantics; open forbids a fixed amount and
// allows optional min/max; open_with_suggested needs a default amount that
// (if bounds are set) falls within them.
func validateAmounts(req createLinkRequest) *apierrors.APIError {
	if req.MinAmount != nil && req.MaxAmount != nil && req.MinAmount.Cmp(req.MaxAmount) > 0 {
		return apierrors.E(apierrors.CodeInvalidRequest, "min_amount must not exceed max_amount")
	}
	switch req.AmountMode {
	case "fixed":
		if req.Amount == nil || req.Amount.Sign() <= 0 {
			return apierrors.E(apierrors.CodeLinkAmountRequired, "amount")
		}
	case "open":
		if req.Amount != nil {
			return apierrors.E(apierrors.CodeInvalidRequest, "amount must be omitted for amount_mode=open")
		}
	case "open_with_suggested":
		if req.Amount == nil || req.Amount.Sign() <= 0 {
			return apierrors.E(apierrors.CodeLinkAmountRequired, "amount")
		}
		if req.MinAmount != nil && req.Amount.Cmp(req.MinAmount) < 0 {
			return apierrors.E(apierrors.CodeLinkAmountOutOfBounds, "amount")
		}
		if req.MaxAmount != nil && req.Amount.Cmp(req.MaxAmount) > 0 {
			return apierrors.E(apierrors.CodeLinkAmountOutOfBounds, "amount")
		}
	default:
		return apierrors.E(apierrors.CodeInvalidRequest, "amount_mode")
	}
	return nil
}

func (h *PaymentLinks) Create(w http.ResponseWriter, r *http.Request) {
	principal, _ := auth.FromContext(r.Context())

	var req createLinkRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "body"))
		return
	}
	if _, ok := currency.ByISO(req.SettleCurrency); !ok {
		writeErr(w, apierrors.E(apierrors.CodeCurrencyNotSupported, "settle_currency"))
		return
	}
	if req.SettleAddress == "" {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "settle_address"))
		return
	}
	if req.ReusePolicy == "" {
		req.ReusePolicy = "single_use"
	}
	if req.ReusePolicy != "single_use" && req.ReusePolicy != "multi_use" {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "reuse_policy"))
		return
	}
	if apiErr := validateAmounts(req); apiErr != nil {
		writeErr(w, apiErr)
		return
	}
	if req.AcceptCurrencies == nil {
		req.AcceptCurrencies = []string{}
	}

	var expiresAt *time.Time
	if req.ExpiresIn > 0 {
		t := time.Now().Add(time.Duration(req.ExpiresIn) * time.Second)
		expiresAt = &t
	}

	id := models.NewID("pl")
	ctx := r.Context()
	_, err := h.Pool.Exec(ctx,
		`INSERT INTO payment_links
		 (id, account_id, amount_mode, amount, min_amount, max_amount, settle_currency, settle_address,
		  accept_currencies, description, merchant_reference, reuse_policy, status, expires_at, livemode)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active',$13,$14)`,
		id, principal.AccountID, req.AmountMode, bigStrDB(req.Amount), bigStrDB(req.MinAmount), bigStrDB(req.MaxAmount),
		req.SettleCurrency, req.SettleAddress, req.AcceptCurrencies, nullIfEmpty(req.Description),
		nullIfEmpty(req.MerchantReference), req.ReusePolicy, expiresAt, principal.Livemode,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	writeJSON(w, http.StatusCreated, h.toResponse(id, req.AmountMode, bigStrDisplay(req.Amount), bigStrDisplay(req.MinAmount), bigStrDisplay(req.MaxAmount),
		req.SettleCurrency, req.SettleAddress, req.AcceptCurrencies, req.Description, req.MerchantReference,
		req.ReusePolicy, "active", expiresAt, time.Now()))
}

func (h *PaymentLinks) List(w http.ResponseWriter, r *http.Request) {
	principal, _ := auth.FromContext(r.Context())

	rows, err := h.Pool.Query(r.Context(),
		`SELECT id, amount_mode, amount::text, min_amount::text, max_amount::text, settle_currency, settle_address,
		        accept_currencies, COALESCE(description,''), COALESCE(merchant_reference,''), reuse_policy, status,
		        expires_at, created_at
		 FROM payment_links WHERE account_id = $1 ORDER BY created_at DESC LIMIT 100`,
		principal.AccountID,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	defer rows.Close()

	var results []linkResponse
	for rows.Next() {
		var id, amountMode, settleCurrency, settleAddress, description, merchantReference, reusePolicy, status string
		var amount, minAmount, maxAmount *string
		var acceptCurrencies []string
		var expiresAt *time.Time
		var created time.Time
		if err := rows.Scan(&id, &amountMode, &amount, &minAmount, &maxAmount, &settleCurrency, &settleAddress,
			&acceptCurrencies, &description, &merchantReference, &reusePolicy, &status, &expiresAt, &created); err != nil {
			writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
			return
		}
		results = append(results, h.toResponse(id, amountMode, derefStr(amount), derefStr(minAmount), derefStr(maxAmount),
			settleCurrency, settleAddress, acceptCurrencies, description, merchantReference, reusePolicy, status, expiresAt, created))
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": results})
}

func (h *PaymentLinks) Get(w http.ResponseWriter, r *http.Request) {
	id := pathParam(r, "id")
	principal, _ := auth.FromContext(r.Context())

	var amountMode, settleCurrency, settleAddress, description, merchantReference, reusePolicy, status string
	var amount, minAmount, maxAmount *string
	var acceptCurrencies []string
	var expiresAt *time.Time
	var created time.Time
	err := h.Pool.QueryRow(r.Context(),
		`SELECT amount_mode, amount::text, min_amount::text, max_amount::text, settle_currency, settle_address,
		        accept_currencies, COALESCE(description,''), COALESCE(merchant_reference,''), reuse_policy, status,
		        expires_at, created_at
		 FROM payment_links WHERE id = $1 AND account_id = $2`,
		id, principal.AccountID,
	).Scan(&amountMode, &amount, &minAmount, &maxAmount, &settleCurrency, &settleAddress, &acceptCurrencies,
		&description, &merchantReference, &reusePolicy, &status, &expiresAt, &created)
	if err != nil {
		if err == pgx.ErrNoRows {
			writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
			return
		}
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	writeJSON(w, http.StatusOK, h.toResponse(id, amountMode, derefStr(amount), derefStr(minAmount), derefStr(maxAmount),
		settleCurrency, settleAddress, acceptCurrencies, description, merchantReference, reusePolicy, status, expiresAt, created))
}

// Void implements POST /:id/void. draft/active/viewed links can be voided;
// paid/settled links are immutable per spec 3.1. Voiding an already-void
// link is treated as an idempotent no-op success, not an error.
func (h *PaymentLinks) Void(w http.ResponseWriter, r *http.Request) {
	id := pathParam(r, "id")
	principal, _ := auth.FromContext(r.Context())

	var status string
	err := h.Pool.QueryRow(r.Context(),
		`SELECT status FROM payment_links WHERE id = $1 AND account_id = $2`, id, principal.AccountID,
	).Scan(&status)
	if err != nil {
		if err == pgx.ErrNoRows {
			writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
			return
		}
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	if status == "void" {
		writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "void"})
		return
	}
	if status == "paid" || status == "settled" {
		writeErr(w, apierrors.E(apierrors.CodeLinkAlreadyUsed, "id"))
		return
	}

	_, err = h.Pool.Exec(r.Context(),
		`UPDATE payment_links SET status = 'void', updated_at = now() WHERE id = $1 AND account_id = $2`,
		id, principal.AccountID,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "void"})
}

type publicLinkResponse struct {
	ID             string     `json:"id"`
	AmountMode     string     `json:"amount_mode"`
	Amount         string     `json:"amount,omitempty"`
	MinAmount      string     `json:"min_amount,omitempty"`
	MaxAmount      string     `json:"max_amount,omitempty"`
	SettleCurrency string     `json:"settle_currency"`
	Description    string     `json:"description,omitempty"`
	Status         string     `json:"status"`
	ExpiresAt      *time.Time `json:"expires_at,omitempty"`
	// Phase 4 recipient identity -- a payer looking at a bare hex address
	// won't pay; the business name is what they need to see first.
	// settle_address is included for on-request verification (hover/
	// expand), not as the primary label.
	DisplayName   string  `json:"display_name"`
	LogoURL       *string `json:"logo_url,omitempty"`
	SettleAddress string  `json:"settle_address"`
}

// GetPublic is GET /:id/public -- unauthenticated, for the payer surface.
// First view of an active link transitions it to viewed (the merchant wants
// to know the buyer opened the invoice, per spec 3.1). Deliberately omits
// account_id/merchant_reference; includes the recipient's display identity.
func (h *PaymentLinks) GetPublic(w http.ResponseWriter, r *http.Request) {
	id := pathParam(r, "id")

	var amountMode, settleCurrency, settleAddress, description, status, displayName string
	var amount, minAmount, maxAmount *string
	var logoURL *string
	var expiresAt *time.Time
	err := h.Pool.QueryRow(r.Context(),
		`SELECT pl.amount_mode, pl.amount::text, pl.min_amount::text, pl.max_amount::text, pl.settle_currency, pl.settle_address,
		        COALESCE(pl.description,''), pl.status, pl.expires_at, a.name, a.logo_url
		 FROM payment_links pl JOIN accounts a ON a.id = pl.account_id
		 WHERE pl.id = $1`,
		id,
	).Scan(&amountMode, &amount, &minAmount, &maxAmount, &settleCurrency, &settleAddress, &description, &status, &expiresAt,
		&displayName, &logoURL)
	if err != nil {
		if err == pgx.ErrNoRows {
			writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
			return
		}
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	if expiresAt != nil && time.Now().After(*expiresAt) && status != "expired" {
		status = "expired"
		h.Pool.Exec(r.Context(), `UPDATE payment_links SET status = 'expired', updated_at = now() WHERE id = $1 AND status NOT IN ('paid','settled','void')`, id)
	} else if status == "active" {
		status = "viewed"
		h.Pool.Exec(r.Context(), `UPDATE payment_links SET status = 'viewed', updated_at = now() WHERE id = $1 AND status = 'active'`, id)
	}

	writeJSON(w, http.StatusOK, publicLinkResponse{
		ID: id, AmountMode: amountMode, Amount: derefStr(amount), MinAmount: derefStr(minAmount), MaxAmount: derefStr(maxAmount),
		SettleCurrency: settleCurrency, Description: description, Status: status, ExpiresAt: expiresAt,
		DisplayName: displayName, LogoURL: logoURL, SettleAddress: settleAddress,
	})
}

type payLinkRequest struct {
	Amount         *big.Int `json:"amount"` // required for open, optional override for open_with_suggested, ignored for fixed
	PayerReference string   `json:"payer_reference"`
}

// Pay implements POST /:id/pay -- unauthenticated (the payer has no API
// key). This is the real enforcement point for spec 3.3: single-use re-pay,
// expiry, void, and out-of-bounds amounts are all rejected here with a
// typed error, not merely hidden in a UI. On success it creates a
// settlement_intent (the existing, unchanged FX flow) linked back to this
// payment_link and returns it for the payer to continue through
// quote/prepare/confirm exactly as they would for a bare settlement_intent.
func (h *PaymentLinks) Pay(w http.ResponseWriter, r *http.Request) {
	id := pathParam(r, "id")
	var req payLinkRequest
	if r.Body != nil {
		json.NewDecoder(r.Body).Decode(&req) // empty body is valid for fixed-amount links
	}

	ctx := r.Context()
	var accountID, amountMode, settleCurrency, settleAddress, status, reusePolicy, description, merchantReference string
	var amount, minAmount, maxAmount *string
	var acceptCurrencies []string
	var expiresAt *time.Time
	var livemode bool
	err := h.Pool.QueryRow(ctx,
		`SELECT account_id, amount_mode, amount::text, min_amount::text, max_amount::text, settle_currency, settle_address,
		        accept_currencies, status, reuse_policy, expires_at, livemode, COALESCE(description,''), COALESCE(merchant_reference,'')
		 FROM payment_links WHERE id = $1`,
		id,
	).Scan(&accountID, &amountMode, &amount, &minAmount, &maxAmount, &settleCurrency, &settleAddress,
		&acceptCurrencies, &status, &reusePolicy, &expiresAt, &livemode, &description, &merchantReference)
	if err != nil {
		if err == pgx.ErrNoRows {
			writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
			return
		}
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	if expiresAt != nil && time.Now().After(*expiresAt) {
		h.Pool.Exec(ctx, `UPDATE payment_links SET status = 'expired', updated_at = now() WHERE id = $1 AND status NOT IN ('paid','settled','void')`, id)
		writeErr(w, apierrors.E(apierrors.CodeLinkExpired, "id"))
		return
	}
	if status == "void" {
		writeErr(w, apierrors.E(apierrors.CodeLinkVoided, "id"))
		return
	}
	if status == "paid" || status == "settled" {
		writeErr(w, apierrors.E(apierrors.CodeLinkAlreadyUsed, "id"))
		return
	}
	if status != "active" && status != "viewed" {
		writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
		return
	}

	// Resolve the payment amount for this specific payment attempt.
	var payAmount *big.Int
	switch amountMode {
	case "fixed":
		payAmount, _ = new(big.Int).SetString(*amount, 10)
	case "open_with_suggested":
		if req.Amount != nil {
			payAmount = req.Amount
		} else {
			payAmount, _ = new(big.Int).SetString(*amount, 10)
		}
	case "open":
		if req.Amount == nil || req.Amount.Sign() <= 0 {
			writeErr(w, apierrors.E(apierrors.CodeLinkAmountRequired, "amount"))
			return
		}
		payAmount = req.Amount
	}
	if (amountMode == "open" || amountMode == "open_with_suggested") && req.Amount != nil {
		if minAmount != nil {
			min, _ := new(big.Int).SetString(*minAmount, 10)
			if payAmount.Cmp(min) < 0 {
				writeErr(w, apierrors.E(apierrors.CodeLinkAmountOutOfBounds, "amount"))
				return
			}
		}
		if maxAmount != nil {
			max, _ := new(big.Int).SetString(*maxAmount, 10)
			if payAmount.Cmp(max) > 0 {
				writeErr(w, apierrors.E(apierrors.CodeLinkAmountOutOfBounds, "amount"))
				return
			}
		}
	}

	// Atomically claim the link for single-use links -- this is the actual
	// double-payment guard, not just the earlier read-side status check
	// (which is racy under concurrent requests).
	if reusePolicy == "single_use" {
		tag, err := h.Pool.Exec(ctx,
			`UPDATE payment_links SET status = 'paid', updated_at = now()
			 WHERE id = $1 AND reuse_policy = 'single_use' AND status IN ('active','viewed')`,
			id,
		)
		if err != nil {
			writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
			return
		}
		if tag.RowsAffected() == 0 {
			writeErr(w, apierrors.E(apierrors.CodeLinkAlreadyUsed, "id"))
			return
		}
	} else {
		h.Pool.Exec(ctx, `UPDATE payment_links SET status = 'viewed', updated_at = now() WHERE id = $1 AND status = 'active'`, id)
	}

	intentID := models.NewID("si")
	intentExpiresAt := time.Now().Add(1 * time.Hour)
	metadata := map[string]any{}
	if description != "" {
		metadata["description"] = description
	}
	if merchantReference != "" {
		metadata["merchant_reference"] = merchantReference
	}
	metadataJSON, _ := json.Marshal(metadata)

	_, err = h.Pool.Exec(ctx,
		`INSERT INTO settlement_intents
		 (id, account_id, amount, settle_currency, settle_address, accept_currencies, status, reference, metadata, expires_at, livemode, source_chain, payment_link_id, payer_reference)
		 VALUES ($1,$2,$3,$4,$5,$6,'created',$7,$8,$9,$10,'arc',$11,$12)`,
		intentID, accountID, payAmount.String(), settleCurrency, settleAddress, acceptCurrencies,
		nullIfEmpty(merchantReference), metadataJSON, intentExpiresAt, livemode, id, nullIfEmpty(req.PayerReference),
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"id":              intentID,
		"payment_link_id": id,
		"amount":          payAmount.String(),
		"settle_currency": settleCurrency,
		"hosted_url":      h.AppBaseURL + "/pay/" + intentID,
	})
}

func (h *PaymentLinks) toResponse(id, amountMode, amount, minAmount, maxAmount, settleCurrency, settleAddress string,
	acceptCurrencies []string, description, merchantReference, reusePolicy, status string, expiresAt *time.Time, created time.Time) linkResponse {
	return linkResponse{
		ID: id, AmountMode: amountMode, Amount: amount, MinAmount: minAmount, MaxAmount: maxAmount,
		SettleCurrency: settleCurrency, SettleAddress: settleAddress, AcceptCurrencies: acceptCurrencies,
		Description: description, MerchantReference: merchantReference, ReusePolicy: reusePolicy, Status: status,
		ExpiresAt: expiresAt, Created: created,
		HostedURL: h.AppBaseURL + "/pay/" + id,
		QRPayload: id,
	}
}

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
