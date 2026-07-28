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
	"github.com/kzn-labs/conduit/api/internal/fx"
	"github.com/kzn-labs/conduit/api/internal/models"
)

type SettlementIntents struct {
	Pool        *pgxpool.Pool
	StableFX    *fx.StableFXProvider
	AppBaseURL  string
}

type createIntentRequest struct {
	Amount           *big.Int          `json:"amount"`
	SettleCurrency   string            `json:"settle_currency"`
	SettleAddress    string            `json:"settle_address"`
	AcceptCurrencies []string          `json:"accept_currencies"`
	Reference        string            `json:"reference"`
	ExpiresIn        int64             `json:"expires_in"`
	Metadata         map[string]any    `json:"metadata"`
}

type intentResponse struct {
	ID               string         `json:"id"`
	Status           string         `json:"status"`
	Amount           string         `json:"amount"`
	SettleCurrency   string         `json:"settle_currency"`
	SettleAddress    string         `json:"settle_address"`
	AcceptCurrencies []string       `json:"accept_currencies"`
	Reference        string         `json:"reference,omitempty"`
	Metadata         map[string]any `json:"metadata"`
	ExpiresAt        time.Time      `json:"expires_at"`
	Created          time.Time      `json:"created"`
	HostedURL        string         `json:"hosted_url"`
	QRPayload        string         `json:"qr_payload"`
}

func (h *SettlementIntents) Create(w http.ResponseWriter, r *http.Request) {
	principal, _ := auth.FromContext(r.Context())

	var req createIntentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "body"))
		return
	}
	if req.Amount == nil || req.Amount.Sign() <= 0 {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "amount"))
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
	expiresIn := req.ExpiresIn
	if expiresIn <= 0 {
		expiresIn = 3600
	}
	if req.AcceptCurrencies == nil {
		req.AcceptCurrencies = []string{}
	}

	ctx := r.Context()
	q := queryable(ctx, h.Pool)

	id := models.NewID("si")
	expiresAt := time.Now().Add(time.Duration(expiresIn) * time.Second)
	metadataJSON, _ := json.Marshal(req.Metadata)
	if req.Metadata == nil {
		metadataJSON = []byte("{}")
	}

	_, err := q.Exec(ctx,
		`INSERT INTO settlement_intents
		 (id, account_id, amount, settle_currency, settle_address, accept_currencies, status, reference, metadata, expires_at, livemode)
		 VALUES ($1,$2,$3,$4,$5,$6,'created',$7,$8,$9,$10)`,
		id, principal.AccountID, req.Amount.String(), req.SettleCurrency, req.SettleAddress,
		req.AcceptCurrencies, nullIfEmpty(req.Reference), metadataJSON, expiresAt, principal.Livemode,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	writeJSON(w, http.StatusCreated, h.toResponse(id, req.Amount.String(), "created", req.SettleCurrency,
		req.SettleAddress, req.AcceptCurrencies, req.Reference, req.Metadata, expiresAt, time.Now()))
}

func (h *SettlementIntents) Get(w http.ResponseWriter, r *http.Request) {
	id := pathParam(r, "id")
	principal, _ := auth.FromContext(r.Context())

	var amount, status, settleCurrency, settleAddress, reference string
	var acceptCurrencies []string
	var metadataJSON []byte
	var expiresAt, created time.Time

	err := h.Pool.QueryRow(r.Context(),
		`SELECT amount::text, status, settle_currency, settle_address, accept_currencies,
		        COALESCE(reference,''), metadata, expires_at, created_at
		 FROM settlement_intents WHERE id = $1 AND account_id = $2`,
		id, principal.AccountID,
	).Scan(&amount, &status, &settleCurrency, &settleAddress, &acceptCurrencies, &reference, &metadataJSON, &expiresAt, &created)
	if err != nil {
		if err == pgx.ErrNoRows {
			writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
			return
		}
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	var metadata map[string]any
	json.Unmarshal(metadataJSON, &metadata)

	resp := h.toResponse(id, amount, status, settleCurrency, settleAddress, acceptCurrencies, reference, metadata, expiresAt, created)
	writeJSON(w, http.StatusOK, resp)
}

func (h *SettlementIntents) Cancel(w http.ResponseWriter, r *http.Request) {
	id := pathParam(r, "id")
	principal, _ := auth.FromContext(r.Context())

	tag, err := h.Pool.Exec(r.Context(),
		`UPDATE settlement_intents SET status = 'canceled', updated_at = now()
		 WHERE id = $1 AND account_id = $2 AND status IN ('created','quoted')`,
		id, principal.AccountID,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, apierrors.E(apierrors.CodeIntentAlreadySettled, "id"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "canceled"})
}

type quoteResponse struct {
	Provider  string `json:"provider"`
	Rate      string `json:"rate"`
	PayAmount string `json:"pay_amount"`
	PayCurrency string `json:"pay_currency"`
	ExpiresAt int64  `json:"expires_at"`
	TypedData json.RawMessage `json:"typed_data,omitempty"`
}

// Quote implements POST /:id/quote. Per the v2 spec §2.2: this is deliberately
// the ONLY step allowed to happen before the payer is present — it does not
// create a StableFX trade (that's Prepare), so there's no cost to calling it
// speculatively or re-calling it on expiry.
func (h *SettlementIntents) Quote(w http.ResponseWriter, r *http.Request) {
	id := pathParam(r, "id")
	principal, _ := auth.FromContext(r.Context())

	var payCurrency string
	if err := json.NewDecoder(r.Body).Decode(&struct {
		PayCurrency *string `json:"pay_currency"`
	}{&payCurrency}); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "body"))
		return
	}

	var amountStr, settleCurrencyISO, settleAddress, status string
	err := h.Pool.QueryRow(r.Context(),
		`SELECT amount::text, settle_currency, settle_address, status FROM settlement_intents WHERE id = $1 AND account_id = $2`,
		id, principal.AccountID,
	).Scan(&amountStr, &settleCurrencyISO, &settleAddress, &status)
	if err != nil {
		if err == pgx.ErrNoRows {
			writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
			return
		}
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	if status == "settled" {
		writeErr(w, apierrors.E(apierrors.CodeIntentAlreadySettled, "id"))
		return
	}

	settleInfo, ok := currency.ByISO(settleCurrencyISO)
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeCurrencyNotSupported, "settle_currency"))
		return
	}
	if payCurrency == "" {
		payCurrency = settleInfo.Symbol
	}
	payInfo, ok := currency.BySymbol(payCurrency)
	if !ok {
		payInfo, ok = currency.ByISO(payCurrency)
		if !ok {
			writeErr(w, apierrors.E(apierrors.CodeCurrencyNotSupported, "pay_currency"))
			return
		}
	}

	amount, _ := new(big.Int).SetString(amountStr, 10)

	var q fx.Quote
	if payInfo.Symbol == settleInfo.Symbol {
		q, err = fx.DirectProvider{}.Quote(r.Context(), payInfo.Symbol, settleInfo.Symbol, amount, settleAddress)
	} else {
		q, err = h.StableFX.Quote(r.Context(), payInfo.Symbol, settleInfo.Symbol, amount, settleAddress)
	}
	if err != nil {
		if apiErr, ok := err.(*apierrors.APIError); ok {
			writeErr(w, apiErr)
			return
		}
		writeErr(w, apierrors.E(apierrors.CodeFxProviderUnavailable, ""))
		return
	}

	_, _ = h.Pool.Exec(r.Context(), `UPDATE settlement_intents SET status = 'quoted', updated_at = now() WHERE id = $1 AND status = 'created'`, id)

	writeJSON(w, http.StatusOK, quoteResponse{
		Provider: q.Provider, Rate: q.Rate, PayAmount: q.FromAmount.String(),
		PayCurrency: payInfo.Symbol, ExpiresAt: q.ExpiresAt, TypedData: q.RawTypedData,
	})
}

func (h *SettlementIntents) toResponse(id, amount, status, settleCurrency, settleAddress string,
	acceptCurrencies []string, reference string, metadata map[string]any, expiresAt, created time.Time) intentResponse {
	return intentResponse{
		ID: id, Status: status, Amount: amount, SettleCurrency: settleCurrency, SettleAddress: settleAddress,
		AcceptCurrencies: acceptCurrencies, Reference: reference, Metadata: metadata,
		ExpiresAt: expiresAt, Created: created,
		HostedURL: h.AppBaseURL + "/pay/" + id,
		QRPayload: id,
	}
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
