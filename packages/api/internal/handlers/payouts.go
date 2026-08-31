package handlers

// Moving a business's own money out of its settlement wallet.
//
// Two steps, and the split is the point. The server decides WHETHER a
// withdrawal is allowed and to where; the browser produces the transaction,
// because a Circle wallet's key material lives on the user's own device and no
// server-side path can sign for it. Then the server records what actually
// happened, read back from the chain rather than believed.
//
// So this never touches a private key and never trusts a claim. It authorises,
// and then it verifies. A payout that was authorised and never signed stays
// pending forever, which is the honest state for it -- nothing was moved.
//
// Deliberately NOT a second transfer path. The transaction goes out through the
// same Circle provider /send already uses (lib/circle/provider.ts), which routes
// an ordinary eth_sendTransaction through the contract-execution challenge. What
// this adds is the authorisation in front of it and the ledger behind it.

import (
	"context"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kzn-labs/conduit/api/internal/arcrpc"
	"github.com/kzn-labs/conduit/api/internal/auth"
	"github.com/kzn-labs/conduit/api/internal/currency"
	apierrors "github.com/kzn-labs/conduit/api/internal/errors"
	"github.com/kzn-labs/conduit/api/internal/models"
)

type Payouts struct {
	Pool   *pgxpool.Pool
	ArcRPC string
}

type payoutResponse struct {
	ID          string     `json:"id"`
	Status      string     `json:"status"`
	Currency    string     `json:"currency"`
	Amount      string     `json:"amount"`
	Destination string     `json:"destination_address"`
	From        string     `json:"from_address"`
	TxHash      *string    `json:"tx_hash"`
	CreatedAt   time.Time  `json:"created_at"`
	PaidAt      *time.Time `json:"paid_at"`
	// Transfer is what the browser needs to build the transaction, present only
	// on the create response. Everything in it is derived server-side: the token
	// from the currency, the recipient from the VERIFIED destination. A client
	// that supplied any of it would be choosing where money goes.
	Transfer *payoutTransfer `json:"transfer,omitempty"`
}

type payoutTransfer struct {
	Token  string `json:"token"`
	To     string `json:"to"`
	Amount string `json:"amount"`
}

// Create is POST /v1/payouts.
//
// Authorises a withdrawal and hands back the transfer to make. Nothing has
// moved when this returns.
func (h *Payouts) Create(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}
	var req struct {
		DestinationID string `json:"destination_id"`
		Currency      string `json:"currency"`
		Amount        string `json:"amount"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "body"))
		return
	}
	info, ok := currency.ByISO(req.Currency)
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeCurrencyNotSupported, "currency"))
		return
	}
	amount, ok := new(big.Int).SetString(strings.TrimSpace(req.Amount), 10)
	if !ok || amount.Sign() <= 0 {
		// Minor units, as everywhere else here. A float would round somebody's
		// withdrawal.
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "amount"))
		return
	}

	// The destination, and whether anyone ever proved they control it.
	var destAddress string
	var verifiedAt *time.Time
	err := h.Pool.QueryRow(r.Context(),
		`SELECT address, verified_at FROM payout_destinations WHERE id = $1 AND account_id = $2`,
		strings.TrimSpace(req.DestinationID), principal.AccountID,
	).Scan(&destAddress, &verifiedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, apierrors.E(apierrors.CodeNotFound, "destination_id"))
		return
	}
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	// The whole reason destinations exist. An unproven address is
	// indistinguishable from a typo, and the transfer is final.
	if verifiedAt == nil {
		writeErr(w, apierrors.E(apierrors.CodePayoutUnverified, "destination_id"))
		return
	}

	// Out of the account's own settlement wallet, never anywhere else.
	from, e := deriveSettleAddress(r.Context(), h.Pool, principal.AccountID)
	if e != nil {
		writeErr(w, e)
		return
	}

	id := models.NewID("po")
	var out payoutResponse
	err = h.Pool.QueryRow(r.Context(),
		`INSERT INTO payouts (id, account_id, destination_id, destination_address,
		                      from_address, currency, amount)
		 VALUES ($1,$2,$3,$4,$5,$6,$7)
		 RETURNING id, status, currency, amount::text, destination_address, from_address,
		           tx_hash, created_at, paid_at`,
		id, principal.AccountID, req.DestinationID, destAddress, from, info.ISO, amount.String(),
	).Scan(&out.ID, &out.Status, &out.Currency, &out.Amount, &out.Destination,
		&out.From, &out.TxHash, &out.CreatedAt, &out.PaidAt)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	out.Transfer = &payoutTransfer{
		Token:  info.Token,
		To:     destAddress,
		Amount: amount.String(),
	}
	writeJSON(w, http.StatusCreated, out)
}

// Confirm is POST /v1/payouts/{id}/confirm.
//
// Takes the transaction the browser produced and checks the chain for it. The
// hash is a claim until this has looked: a ledger built from what a client says
// happened is a ledger that can be told anything.
func (h *Payouts) Confirm(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}
	id := pathParam(r, "id")
	var req struct {
		TxHash string `json:"tx_hash"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.TxHash) == "" {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "tx_hash"))
		return
	}

	var status, currencyISO, amountStr, destAddress, fromAddress string
	var existingHash *string
	err := h.Pool.QueryRow(r.Context(),
		`SELECT status, currency, amount::text, destination_address, from_address, tx_hash
		   FROM payouts WHERE id = $1 AND account_id = $2`,
		id, principal.AccountID,
	).Scan(&status, &currencyISO, &amountStr, &destAddress, &fromAddress, &existingHash)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
		return
	}
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	if status == "paid" {
		// Already recorded. Answering with the current state rather than an
		// error: a client retrying a confirm it completed has nothing to fix.
		h.writePayout(w, r, id, principal.AccountID)
		return
	}

	info, ok := currency.ByISO(currencyISO)
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	amount, _ := new(big.Int).SetString(amountStr, 10)

	// The chain, not the caller.
	moved, err := h.transferHappened(r.Context(), req.TxHash, info.Token, fromAddress, destAddress, amount)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeUpstreamUnavailable, "arc rpc"))
		return
	}
	if !moved {
		writeErr(w, apierrors.E(apierrors.CodePayoutNotOnChain, "tx_hash"))
		return
	}

	// Marking paid and writing the ledger row together, so a payout can never
	// be paid without a ledger entry or counted twice with one. The tx_hash
	// unique index is what stops the same transfer confirming two payouts.
	tx, err := h.Pool.Begin(r.Context())
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	defer tx.Rollback(r.Context())

	tag, err := tx.Exec(r.Context(),
		`UPDATE payouts SET status = 'paid', tx_hash = $1, paid_at = now()
		  WHERE id = $2 AND account_id = $3 AND status = 'pending'`,
		req.TxHash, id, principal.AccountID,
	)
	if err != nil {
		// The unique index on tx_hash: this transfer already settled another
		// payout. Refusing is the point -- one transfer, one withdrawal.
		writeErr(w, apierrors.E(apierrors.CodePayoutNotOnChain, "tx_hash"))
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "status"))
		return
	}

	// Negative net, because the balance goes down. gross carries the amount and
	// net carries its effect, so summing net over an account gives what it
	// actually holds rather than what has passed through it.
	if _, err := tx.Exec(r.Context(),
		`INSERT INTO balance_transactions (id, account_id, type, gross, fee, net, currency)
		 VALUES ($1,$2,'payout',$3,0,$4,$5)`,
		models.NewID("btx"), principal.AccountID, amount.String(),
		new(big.Int).Neg(amount).String(), currencyISO,
	); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	h.writePayout(w, r, id, principal.AccountID)
}

// transferHappened reports whether `txHash` contains an ERC-20 Transfer of
// `token`, from `from`, to `to`, for at least `amount`.
//
// At least, not exactly: a merchant is entitled to send more than they told us
// about, and under-crediting their own ledger is the failure that matters here.
// A transfer smaller than claimed is refused, because recording a withdrawal
// larger than the one that happened would overstate what left the wallet.
func (h *Payouts) transferHappened(
	ctx context.Context, txHash, token, from, to string, amount *big.Int,
) (bool, error) {
	client, err := arcrpc.Get(ctx, h.ArcRPC)
	if err != nil {
		return false, err
	}
	callCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	receipt, err := client.TransactionReceipt(callCtx, common.HexToHash(txHash))
	if err != nil {
		return false, err
	}
	// A reverted transaction moved nothing, whatever its logs say.
	if receipt.Status != 1 {
		return false, nil
	}

	tokenAddr := common.HexToAddress(token)
	fromAddr := common.HexToAddress(from)
	toAddr := common.HexToAddress(to)
	for _, lg := range receipt.Logs {
		if lg.Address != tokenAddr || len(lg.Topics) != 3 || lg.Topics[0] != erc20TransferTopic {
			continue
		}
		if common.BytesToAddress(lg.Topics[1].Bytes()) != fromAddr {
			continue
		}
		if common.BytesToAddress(lg.Topics[2].Bytes()) != toAddr {
			continue
		}
		if new(big.Int).SetBytes(lg.Data).Cmp(amount) >= 0 {
			return true, nil
		}
	}
	return false, nil
}

// List is GET /v1/payouts.
func (h *Payouts) List(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}
	rows, err := h.Pool.Query(r.Context(),
		`SELECT id, status, currency, amount::text, destination_address, from_address,
		        tx_hash, created_at, paid_at
		   FROM payouts WHERE account_id = $1 ORDER BY created_at DESC`,
		principal.AccountID,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	defer rows.Close()
	out := []payoutResponse{}
	for rows.Next() {
		var p payoutResponse
		if err := rows.Scan(&p.ID, &p.Status, &p.Currency, &p.Amount, &p.Destination,
			&p.From, &p.TxHash, &p.CreatedAt, &p.PaidAt); err != nil {
			writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
			return
		}
		out = append(out, p)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

func (h *Payouts) writePayout(w http.ResponseWriter, r *http.Request, id, accountID string) {
	var p payoutResponse
	err := h.Pool.QueryRow(r.Context(),
		`SELECT id, status, currency, amount::text, destination_address, from_address,
		        tx_hash, created_at, paid_at
		   FROM payouts WHERE id = $1 AND account_id = $2`,
		id, accountID,
	).Scan(&p.ID, &p.Status, &p.Currency, &p.Amount, &p.Destination,
		&p.From, &p.TxHash, &p.CreatedAt, &p.PaidAt)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	writeJSON(w, http.StatusOK, p)
}
