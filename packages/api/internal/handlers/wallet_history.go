package handlers

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/jackc/pgx/v5/pgxpool"
	apierrors "github.com/kzn-labs/conduit/api/internal/errors"
)

// WalletHistory serves a connected wallet's own cross-currency settlement
// history. The Arc-native /history page already reads same-currency payments
// straight off ConduitRouter's PaymentSettled event log, which needs no
// server at all -- but StableFX cross-currency settlements are delivered by
// Circle's maker via Permit2 and never touch ConduitRouter, so they leave no
// on-chain event to read. This endpoint is the only place a payer can see
// those payments, ever.
//
// It has no API key -- a payer paying from /send or a pay link has none --
// so instead of a bearer token it requires the wallet to sign a short-lived
// message proving control of the address being queried. This is read-only
// (no funds move, nothing here can authorize a payment), so a signature
// that's replayable within its validity window is an acceptable trade for
// not making a payer sign twice.
type WalletHistory struct {
	Pool *pgxpool.Pool
}

type walletHistoryRequest struct {
	Wallet    string `json:"wallet"`
	Timestamp int64  `json:"timestamp"` // unix seconds, embedded in the signed message
	Signature string `json:"signature"` // hex, personal_sign (eth_sign / signMessage) over walletHistoryMessage(wallet, timestamp)
}

type walletSettlementRow struct {
	ID             string  `json:"id"`
	TxHash         string  `json:"tx_hash"`
	PayCurrency    string  `json:"pay_currency"`
	PayAmount      string  `json:"pay_amount"`
	SettleCurrency string  `json:"settle_currency"`
	SettleAmount   string  `json:"settle_amount"`
	SettleAddress  string  `json:"settle_address"`
	RateApplied    *string `json:"rate_applied"`
	SettledAt      string  `json:"settled_at"`
	// "sent" when this wallet funded the payment, "received" when it was the
	// payout address. Lets /history colour and sign the row correctly.
	Direction string `json:"direction"`
}

// walletHistoryMessage is the exact string the wallet must have signed. Fixed
// format, no free text, so there is nothing a signer could be tricked into
// authorizing beyond "let this timestamp's holder read my history."
func walletHistoryMessage(wallet string, timestamp int64) string {
	return fmt.Sprintf(
		"Conduit: view payment history\n\nWallet: %s\nTimestamp: %d",
		strings.ToLower(wallet), timestamp,
	)
}

// verifyPersonalSign recovers the signer of a personal_sign (EIP-191,
// "\x19Ethereum Signed Message:\n<len><message>") signature and reports
// whether it matches wallet.
func verifyPersonalSign(wallet, message, signatureHex string) bool {
	sig, err := decodeHexSignature(signatureHex)
	if err != nil || len(sig) != 65 {
		return false
	}
	// go-ethereum's crypto.Ecrecover wants the recovery id in [0,1]; wallets
	// send it as 27/28 (or already 0/1 for some providers) per EIP-191.
	if sig[64] >= 27 {
		sig[64] -= 27
	}
	prefixed := []byte(fmt.Sprintf("\x19Ethereum Signed Message:\n%d%s", len(message), message))
	hash := crypto.Keccak256(prefixed)
	pub, err := crypto.SigToPub(hash, sig)
	if err != nil {
		return false
	}
	recovered := crypto.PubkeyToAddress(*pub)
	return common.HexToAddress(wallet) == recovered
}

func decodeHexSignature(s string) ([]byte, error) {
	return hex.DecodeString(strings.TrimPrefix(s, "0x"))
}

// List verifies the signature and returns this wallet's cross-currency
// settlement history — the payer's fx_trades.pay_address is the ONLY correct
// key here: it's the address that actually signed and funded the trade,
// which is not always the same as the merchant-facing settlement_intent's
// account (e.g. it never is, for the direct-send personal-account path).
func (h *WalletHistory) List(w http.ResponseWriter, r *http.Request) {
	var req walletHistoryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "malformed JSON body"))
		return
	}
	if !common.IsHexAddress(req.Wallet) {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "wallet"))
		return
	}

	// Bound the replay window: a signature is good for 10 minutes either
	// side of now, generous enough for clock skew and a slow connection,
	// tight enough that a leaked signature isn't a standing credential.
	now := time.Now().Unix()
	if req.Timestamp == 0 || req.Timestamp < now-600 || req.Timestamp > now+120 {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "timestamp"))
		return
	}

	message := walletHistoryMessage(req.Wallet, req.Timestamp)
	if !verifyPersonalSign(req.Wallet, message, req.Signature) {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, "signature does not match wallet"))
		return
	}

	// Both directions, and both settlement kinds:
	//   - LEFT JOIN on fx_trades, not INNER: a cross-CHAIN settlement that
	//     needed no FX (USD merchant, USDC minted straight to them) has no
	//     fx_trade at all, so an inner join dropped every bridged payment.
	//   - matched on settle_address as well as pay_address, so the RECIPIENT
	//     of a cross-currency or bridged payment sees the money arrive. Before
	//     this, an off-chain settlement was visible only to the sender —
	//     a merchant paid this way had no record of it anywhere.
	rows, err := h.Pool.Query(context.Background(),
		`SELECT s.id, s.tx_hash, s.pay_currency, s.pay_amount::text,
		        si.settle_currency, s.settle_amount::text, si.settle_address,
		        s.rate_applied::text, s.settled_at,
		        CASE WHEN lower(si.settle_address) = lower($1) THEN 'received' ELSE 'sent' END AS direction
		 FROM settlements s
		 JOIN settlement_intents si ON si.id = s.intent_id
		 LEFT JOIN fx_trades ft ON ft.id = s.fx_trade_id
		 WHERE lower(ft.pay_address) = lower($1) OR lower(si.settle_address) = lower($1)
		 ORDER BY s.settled_at DESC
		 LIMIT 200`,
		req.Wallet,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	defer rows.Close()

	results := []walletSettlementRow{}
	for rows.Next() {
		var row walletSettlementRow
		var rate *string
		var settledAt time.Time
		if err := rows.Scan(&row.ID, &row.TxHash, &row.PayCurrency, &row.PayAmount,
			&row.SettleCurrency, &row.SettleAmount, &row.SettleAddress, &rate, &settledAt,
			&row.Direction); err != nil {
			writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
			return
		}
		row.RateApplied = rate
		row.SettledAt = strconv.FormatInt(settledAt.Unix(), 10)
		results = append(results, row)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": results})
}
