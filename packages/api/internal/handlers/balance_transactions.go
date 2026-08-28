package handlers

import (
	"encoding/csv"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kzn-labs/conduit/api/internal/auth"
	"github.com/kzn-labs/conduit/api/internal/currency"
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
		        bt.fee::text, bt.net::text, COALESCE(s.tx_hash,''),
		        COALESCE(si.settle_address,'')
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
	// settle_address is WHERE THE MONEY WENT, and it belongs in an export used
	// for bookkeeping. It was omitted while every payment necessarily landed at
	// the account's one address, which made the column identical on every row.
	// A business can now choose its payout address and change it, so two rows in
	// the same export can have settled to two different places -- and a ledger
	// that cannot say which is not a ledger.
	//
	// Read from the INTENT, not the account: settle_address is copied onto the
	// intent when it is created, so each row reports where that payment actually
	// went rather than where the next one would go.
	cw.Write([]string{"date", "intent_id", "reference", "pay_currency", "pay_amount", "settle_currency", "settle_amount", "rate_applied", "fee", "net", "tx_hash", "settle_address"})

	for rows.Next() {
		var date, intentID, reference, payCurrency, payAmount, settleCurrency, settleAmount, rateApplied, fee, net, txHash, settleAddress string
		if err := rows.Scan(&date, &intentID, &reference, &payCurrency, &payAmount, &settleCurrency, &settleAmount, &rateApplied, &fee, &net, &txHash, &settleAddress); err != nil {
			return // partial CSV already streamed; can't recover mid-stream
		}

		// Raw columns are minor-unit integers (NUMERIC(78,0) cast to text).
		// Spec §2.9: "Amounts as decimal strings at each currency's real
		// precision. No floats anywhere in the export path." Resolve each
		// amount's own currency decimals (pay_currency is a token SYMBOL,
		// settle_currency/fee/net are the intent's ISO code) and convert with
		// pure big.Int math — never a float64.
		if payAmount != "" {
			if info, ok := currency.BySymbol(payCurrency); ok {
				payAmount = currency.FormatMinorUnits(payAmount, info.Decimals)
			}
		}
		if settleInfo, ok := currency.ByISO(settleCurrency); ok {
			if settleAmount != "" {
				settleAmount = currency.FormatMinorUnits(settleAmount, settleInfo.Decimals)
			}
			if fee != "" {
				fee = currency.FormatMinorUnits(fee, settleInfo.Decimals)
			}
			if net != "" {
				net = currency.FormatMinorUnits(net, settleInfo.Decimals)
			}
		}

		cw.Write([]string{date, intentID, reference, payCurrency, payAmount, settleCurrency, settleAmount, rateApplied, fee, net, txHash, settleAddress})
	}
	cw.Flush()
}
