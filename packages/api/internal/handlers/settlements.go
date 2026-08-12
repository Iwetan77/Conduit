package handlers

import (
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kzn-labs/conduit/api/internal/auth"
	apierrors "github.com/kzn-labs/conduit/api/internal/errors"
)

// Settlements implements GET /v1/settlements and GET /v1/settlements/:id
// (spec §2.5's endpoint table). Distinct from balance_transactions: this is
// the per-payment view (counterparty, paid, received, rate, fee, tx link)
// the dashboard's Settlements screen (v2 §3.1) is built around.
type Settlements struct{ Pool *pgxpool.Pool }

type settlementResponse struct {
	ID            string `json:"id"`
	IntentID      string `json:"intent_id"`
	Reference     string `json:"reference,omitempty"`
	SettleAddress string `json:"settle_address"`
	// Who paid. Absent for cross-chain, where the account that moves funds on
	// Arc is Conduit's relayer rather than the payer -- see migration 0013.
	PayerAddress   *string `json:"payer_address,omitempty"`
	PayCurrency    string  `json:"pay_currency"`
	PayAmount      string  `json:"pay_amount"`
	SettleCurrency string  `json:"settle_currency"`
	SettleAmount   string  `json:"settle_amount"`
	RateApplied    *string `json:"rate_applied,omitempty"`
	Fee            string  `json:"fee"`
	TxHash         string  `json:"tx_hash"`
	SettledAt      string  `json:"settled_at"`
}

const settlementSelect = `
	SELECT s.id, s.intent_id, COALESCE(si.reference,''), si.settle_address,
	       s.pay_currency, s.pay_amount::text, si.settle_currency, s.settle_amount::text,
	       s.rate_applied::text, s.fee::text, s.tx_hash, s.settled_at::text, s.payer_address
	FROM settlements s
	JOIN settlement_intents si ON si.id = s.intent_id`

func scanSettlement(row interface{ Scan(...any) error }) (settlementResponse, error) {
	var s settlementResponse
	var rateApplied, payerAddress *string
	err := row.Scan(&s.ID, &s.IntentID, &s.Reference, &s.SettleAddress, &s.PayCurrency, &s.PayAmount,
		&s.SettleCurrency, &s.SettleAmount, &rateApplied, &s.Fee, &s.TxHash, &s.SettledAt, &payerAddress)
	s.RateApplied = rateApplied
	s.PayerAddress = payerAddress
	return s, err
}

func (h *Settlements) List(w http.ResponseWriter, r *http.Request) {
	principal, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(),
		settlementSelect+` WHERE si.account_id = $1 ORDER BY s.settled_at DESC LIMIT 200`,
		principal.AccountID,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	defer rows.Close()

	var results []settlementResponse
	for rows.Next() {
		s, err := scanSettlement(rows)
		if err != nil {
			writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
			return
		}
		results = append(results, s)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": results})
}

func (h *Settlements) Get(w http.ResponseWriter, r *http.Request) {
	id := pathParam(r, "id")
	principal, _ := auth.FromContext(r.Context())

	row := h.Pool.QueryRow(r.Context(), settlementSelect+` WHERE s.id = $1 AND si.account_id = $2`, id, principal.AccountID)
	s, err := scanSettlement(row)
	if err != nil {
		if err == pgx.ErrNoRows {
			writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
			return
		}
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	writeJSON(w, http.StatusOK, s)
}
