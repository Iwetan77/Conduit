package handlers

import (
	"context"
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
	AmountMode     string     `json:"amount_mode"` // fixed | open | open_with_suggested
	Amount         *bigAmount `json:"amount"`      // required for fixed; suggested default for open_with_suggested; must be omitted for open
	MinAmount      *bigAmount `json:"min_amount"`  // open / open_with_suggested only
	MaxAmount      *bigAmount `json:"max_amount"`  // open / open_with_suggested only
	SettleCurrency string     `json:"settle_currency"`
	// NOT the address this will settle to -- that is derived from the account.
	// Present only so a caller still sending one can be refused rather than
	// silently ignored. See rejectSuppliedSettleAddress.
	SuppliedSettleAddress *string  `json:"settle_address"`
	AcceptCurrencies      []string `json:"accept_currencies"`
	Description           string   `json:"description"`
	MerchantReference     string   `json:"merchant_reference"`
	ReusePolicy           string   `json:"reuse_policy"` // single_use (default) | multi_use
	ExpiresIn             int64    `json:"expires_in"`   // seconds; 0/omitted = no expiry (a reusable QR isn't obligated to expire)
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
	// Present on GET /:id once money has landed. A till polling this endpoint
	// would otherwise learn only that status flipped to 'paid' and have to make
	// a second call to find out what was actually received -- so the check that
	// matters most (is this the amount I billed?) was the one that took extra
	// work. Never populated on create or list.
	Settlements []linkSettlement `json:"settlements,omitempty"`
}

// linkSettlement is one payment received against a link. A single_use link has
// at most one; a multi_use link (a storefront's standing QR) accumulates them,
// which is why this is a list and not a single object.
type linkSettlement struct {
	ID             string    `json:"id"`
	IntentID       string    `json:"intent_id"`
	TxHash         string    `json:"tx_hash"`
	PayCurrency    string    `json:"pay_currency"`
	PayAmount      string    `json:"pay_amount"`
	SettleAmount   string    `json:"settle_amount"`
	SettleCurrency string    `json:"settle_currency"`
	Fee            string    `json:"fee"`
	SettledAt      time.Time `json:"settled_at"`
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
	if req.MinAmount != nil && req.MaxAmount != nil && req.MinAmount.Cmp(req.MaxAmount.bi()) > 0 {
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
		if req.MinAmount != nil && req.Amount.Cmp(req.MinAmount.bi()) < 0 {
			return apierrors.E(apierrors.CodeLinkAmountOutOfBounds, "amount")
		}
		if req.MaxAmount != nil && req.Amount.Cmp(req.MaxAmount.bi()) > 0 {
			return apierrors.E(apierrors.CodeLinkAmountOutOfBounds, "amount")
		}
	default:
		return apierrors.E(apierrors.CodeInvalidRequest, "amount_mode")
	}
	return nil
}

func (h *PaymentLinks) Create(w http.ResponseWriter, r *http.Request) {
	principal, _ := auth.FromContext(r.Context())

	// A link is the most durable thing this API makes -- printed, pasted into
	// chats, and paid weeks later. One pointing at a business owner's personal
	// wallet is the worst version of this bug, so it is refused before it exists.
	if e := settlementWalletReady(r.Context(), h.Pool, principal.AccountID); e != nil {
		writeErr(w, e)
		return
	}

	var req createLinkRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "body"))
		return
	}
	if _, ok := currency.ByISO(req.SettleCurrency); !ok {
		writeErr(w, apierrors.E(apierrors.CodeCurrencyNotSupported, "settle_currency"))
		return
	}
	if e := rejectSuppliedSettleAddress(req.SuppliedSettleAddress); e != nil {
		writeErr(w, e)
		return
	}
	// The link's address comes from the account that owns it and is snapshotted
	// into the row, exactly as the storefront path already did. Every path now
	// looks like that one.
	settleAddress, e := deriveSettleAddress(r.Context(), h.Pool, principal.AccountID)
	if e != nil {
		writeErr(w, e)
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

	// Short id: this lands in a URL a customer sees, scans, or reads aloud.
	id := models.NewShortID("pl")
	ctx := r.Context()
	_, err := h.Pool.Exec(ctx,
		`INSERT INTO payment_links
		 (id, account_id, amount_mode, amount, min_amount, max_amount, settle_currency, settle_address,
		  accept_currencies, description, merchant_reference, reuse_policy, status, expires_at, livemode)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active',$13,$14)`,
		id, principal.AccountID, req.AmountMode, bigStrDB(req.Amount.bi()), bigStrDB(req.MinAmount.bi()), bigStrDB(req.MaxAmount.bi()),
		req.SettleCurrency, settleAddress, req.AcceptCurrencies, nullIfEmpty(req.Description),
		nullIfEmpty(req.MerchantReference), req.ReusePolicy, expiresAt, principal.Livemode,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	writeJSON(w, http.StatusCreated, h.toResponse(id, req.AmountMode, bigStrDisplay(req.Amount.bi()), bigStrDisplay(req.MinAmount.bi()), bigStrDisplay(req.MaxAmount.bi()),
		req.SettleCurrency, settleAddress, req.AcceptCurrencies, req.Description, req.MerchantReference,
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
	resp := h.toResponse(id, amountMode, derefStr(amount), derefStr(minAmount), derefStr(maxAmount),
		settleCurrency, settleAddress, acceptCurrencies, description, merchantReference, reusePolicy, status, expiresAt, created)
	resp.Settlements = h.settlementsFor(r.Context(), id)
	writeJSON(w, http.StatusOK, resp)
}

// settlementsFor lists the payments received against a link, newest first.
//
// Best-effort: a link that can't load its settlements still returns the link.
// Losing the detail is a degraded answer; failing the whole request would take
// a till's payment-status poll down with it.
func (h *PaymentLinks) settlementsFor(ctx context.Context, linkID string) []linkSettlement {
	rows, err := h.Pool.Query(ctx,
		`SELECT s.id, s.intent_id, s.tx_hash, s.pay_currency, s.pay_amount::text,
		        s.settle_amount::text, si.settle_currency, s.fee::text, s.settled_at
		 FROM settlements s
		 JOIN settlement_intents si ON si.id = s.intent_id
		 WHERE si.payment_link_id = $1
		 ORDER BY s.settled_at DESC`,
		linkID,
	)
	if err != nil {
		return nil
	}
	defer rows.Close()

	var out []linkSettlement
	for rows.Next() {
		var s linkSettlement
		if err := rows.Scan(&s.ID, &s.IntentID, &s.TxHash, &s.PayCurrency, &s.PayAmount,
			&s.SettleAmount, &s.SettleCurrency, &s.Fee, &s.SettledAt); err != nil {
			return out
		}
		out = append(out, s)
	}
	return out
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
		        COALESCE(pl.description,''), pl.status, pl.expires_at,
		        -- Same rule as the settlement intent's public view: the name
		        -- someone chose to be paid under beats the account's own name,
		        -- and a name held by another account on the SAME WALLET beats
		        -- the generic fallback. A link is a link whichever surface made
		        -- it, so both must answer "who is this from" identically --
		        -- otherwise the same person is one name on a link and another
		        -- on an intent.
		        COALESCE(
		            NULLIF(a.username, ''),
		            (SELECT w.username FROM accounts w
		              WHERE w.username IS NOT NULL
		                AND w.login_wallet IS NOT NULL
		                AND lower(w.login_wallet) = lower(a.login_wallet)
		              ORDER BY (w.privy_user_id IS NULL AND w.auth_subject IS NULL) DESC
		              LIMIT 1),
		            a.name
		        ), a.logo_url
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
	Amount         *bigAmount `json:"amount"` // required for open, optional override for open_with_suggested, ignored for fixed
	PayerReference string     `json:"payer_reference"`
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
			payAmount = req.Amount.bi()
		} else {
			payAmount, _ = new(big.Int).SetString(*amount, 10)
		}
	case "open":
		if req.Amount == nil || req.Amount.Sign() <= 0 {
			writeErr(w, apierrors.E(apierrors.CodeLinkAmountRequired, "amount"))
			return
		}
		payAmount = req.Amount.bi()
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

	// Starting checkout does NOT mean the link is paid. Marking it 'paid' here
	// (before the payer has moved any money) was the bug behind links showing
	// PAID for payments that later failed on insufficient funds — the 'paid'
	// transition now happens only when a real settlement lands (see the confirm
	// handler in settlement_intents.go and the indexer). Here we just record
	// that the link has been opened.
	//
	// The single-use double-payment guard is enforced at settlement time: once
	// a link's intent settles it flips to 'paid', and the status checks above
	// reject any further Pay() call. (A link only truly closes on real payment,
	// not on someone merely reaching checkout.)
	h.Pool.Exec(ctx, `UPDATE payment_links SET status = 'viewed', updated_at = now() WHERE id = $1 AND status = 'active'`, id)

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

// StorefrontLink implements POST /v1/accounts/{id}/storefront_link: the
// standing, reusable, open-amount link whose hosted URL is what a storefront's
// printed QR encodes.
//
// Get-or-create, so the Storefronts page can call it for every card on every
// load without minting duplicates, and so storefronts created before this
// existed get one on first view rather than needing a backfill. The link is
// deliberately derived from the account -- its settle_currency, settle_address
// and name -- because that is what "attribute takings to this location" means:
// a payment through this link settles to the storefront's own address in the
// storefront's own currency, and lands in settlements tagged to its account.
//
// Open amount (not fixed) because a printed sticker at a till can't know the
// sale total; the payer types what they owe, exactly like a UPI/PIX static QR.
func (h *PaymentLinks) StorefrontLink(w http.ResponseWriter, r *http.Request) {
	accountID := pathParam(r, "id")
	principal, _ := auth.FromContext(r.Context())
	ctx := r.Context()

	// The caller may only reach their own account or one of its storefronts.
	// Same containment rule Accounts.Get uses, so a leaked account id from
	// another merchant can't provision or read a link here.
	var name, settleCurrency, settleAddress string
	var livemode bool
	err := h.Pool.QueryRow(ctx,
		`SELECT name, settle_currency, settle_address, livemode FROM accounts
		 WHERE id = $1 AND (id = $2 OR parent_id = $2)`,
		accountID, principal.AccountID,
	).Scan(&name, &settleCurrency, &settleAddress, &livemode)
	if err != nil {
		if err == pgx.ErrNoRows {
			writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
			return
		}
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	if existing, ok := h.findStorefrontLink(ctx, accountID); ok {
		writeJSON(w, http.StatusOK, existing)
		return
	}

	id := models.NewShortID("pl")
	// ON CONFLICT DO NOTHING against the partial unique index: two tabs opening
	// the Storefronts page at once both miss the SELECT above, and the loser
	// simply re-reads the winner's row instead of erroring or double-inserting.
	_, err = h.Pool.Exec(ctx,
		`INSERT INTO payment_links
		 (id, account_id, amount_mode, settle_currency, settle_address, accept_currencies,
		  description, reuse_policy, status, livemode, is_storefront)
		 VALUES ($1,$2,'open',$3,$4,'{}',$5,'multi_use','active',$6,true)
		 ON CONFLICT DO NOTHING`,
		id, accountID, settleCurrency, settleAddress, nullIfEmpty(name), livemode,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	link, ok := h.findStorefrontLink(ctx, accountID)
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	writeJSON(w, http.StatusOK, link)
}

// findStorefrontLink reads the account's live storefront link, if it has one.
func (h *PaymentLinks) findStorefrontLink(ctx context.Context, accountID string) (linkResponse, bool) {
	var id, amountMode, settleCurrency, settleAddress, description, merchantReference, reusePolicy, status string
	var minAmount, maxAmount *string
	var acceptCurrencies []string
	var expiresAt *time.Time
	var created time.Time
	err := h.Pool.QueryRow(ctx,
		`SELECT id, amount_mode, min_amount::text, max_amount::text, settle_currency, settle_address,
		        accept_currencies, COALESCE(description,''), COALESCE(merchant_reference,''), reuse_policy,
		        status, expires_at, created_at
		 FROM payment_links WHERE account_id = $1 AND is_storefront AND status NOT IN ('void','expired')`,
		accountID,
	).Scan(&id, &amountMode, &minAmount, &maxAmount, &settleCurrency, &settleAddress, &acceptCurrencies,
		&description, &merchantReference, &reusePolicy, &status, &expiresAt, &created)
	if err != nil {
		return linkResponse{}, false
	}
	return h.toResponse(id, amountMode, "", derefStr(minAmount), derefStr(maxAmount), settleCurrency,
		settleAddress, acceptCurrencies, description, merchantReference, reusePolicy, status, expiresAt, created), true
}

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
