package handlers

import (
	"encoding/csv"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kzn-labs/conduit/api/internal/auth"
	apierrors "github.com/kzn-labs/conduit/api/internal/errors"
)

type BalanceTransactions struct{ Pool *pgxpool.Pool }

type balanceTransactionResponse struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	Gross     string `json:"gross"`
	Fee       string `json:"fee"`
	Net       string `json:"net"`
	Currency  string `json:"currency"`
	CreatedAt string `json:"created_at"`
}

func (h *BalanceTransactions) List(w http.ResponseWriter, r *http.Request) {
	principal, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(),
		`SELECT id, type, gross::text, fee::text, net::text, currency, created_at::text
		 FROM balance_transactions WHERE account_id = $1 ORDER BY created_at DESC LIMIT 200`,
		principal.AccountID,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	defer rows.Close()

	var results []balanceTransactionResponse
	for rows.Next() {
		var b balanceTransactionResponse
		if err := rows.Scan(&b.ID, &b.Type, &b.Gross, &b.Fee, &b.Net, &b.Currency, &b.CreatedAt); err != nil {
			writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
			return
		}
		results = append(results, b)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": results})
}

// Export streams a CSV per spec §2.9. Amounts are decimal strings at each
// currency's real precision — never floats, never re-scaled through a
// float64 that could lose an 18-decimal token's precision.
func (h *BalanceTransactions) Export(w http.ResponseWriter, r *http.Request) {
	principal, _ := auth.FromContext(r.Context())

	rows, err := h.Pool.Query(r.Context(),
		`SELECT bt.created_at::text, COALESCE(si.id,''), COALESCE(si.reference,''),
		        COALESCE(s.pay_currency,''), COALESCE(s.pay_amount::text,''),
		        bt.currency, bt.net::text, COALESCE(s.rate_applied::text,''),
		        bt.fee::text, bt.net::text, COALESCE(s.tx_hash,'')
		 FROM balance_transactions bt
		 LEFT JOIN settlements s ON s.id = bt.settlement_id
		 LEFT JOIN settlement_intents si ON si.id = s.intent_id
		 WHERE bt.account_id = $1
		 ORDER BY bt.created_at DESC`,
		principal.AccountID,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	defer rows.Close()

	w.Header().Set("Content-Type", "text/csv")
	w.Header().Set("Content-Disposition", `attachment; filename="conduit-balance-transactions.csv"`)
	cw := csv.NewWriter(w)
	cw.Write([]string{"date", "intent_id", "reference", "pay_currency", "pay_amount", "settle_currency", "settle_amount", "rate_applied", "fee", "net", "tx_hash"})

	for rows.Next() {
		var date, intentID, reference, payCurrency, payAmount, settleCurrency, settleAmount, rateApplied, fee, net, txHash string
		if err := rows.Scan(&date, &intentID, &reference, &payCurrency, &payAmount, &settleCurrency, &settleAmount, &rateApplied, &fee, &net, &txHash); err != nil {
			return // partial CSV already streamed; can't recover mid-stream
		}
		cw.Write([]string{date, intentID, reference, payCurrency, payAmount, settleCurrency, settleAmount, rateApplied, fee, net, txHash})
	}
	cw.Flush()
}
