package handlers

// Executing a run.
//
// The server authorises and records; the merchant's own wallet signs. A Circle
// wallet's key material lives on the user's device, so nothing here can move
// money on their behalf — which is the same shape as a payout, and for the same
// reason.
//
// So execution is two calls. This one claims the run, freezes it, and hands back
// exactly what has to be signed: one approve and one disperse per currency
// group. The browser executes those through the Circle challenge path, then
// reports each transaction back and the run records what the chain says.
//
// Claiming BEFORE signing is what makes the run key work. A second execute is
// refused at the moment it arrives, not after it has produced a second set of
// transactions somebody might sign.

import (
	"context"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/jackc/pgx/v5"
	"github.com/kzn-labs/conduit/api/internal/arcrpc"
	"github.com/kzn-labs/conduit/api/internal/auth"
	"github.com/kzn-labs/conduit/api/internal/currency"
	apierrors "github.com/kzn-labs/conduit/api/internal/errors"
)

// payrollLeg is one currency group's worth of work: approve the total, then
// disperse it. Both are the merchant's own transactions.
type payrollLeg struct {
	Currency string `json:"currency"`
	Token    string `json:"token"`
	Total    string `json:"total"`
	// NeedsConversion is reported rather than performed here. Converting is a
	// StableFX leg whose quote expires in about three and a half seconds, so it
	// belongs immediately before the transaction that spends it — in the
	// browser, next to the signature — not minutes earlier on a server.
	NeedsConversion bool     `json:"needs_conversion"`
	Recipients      []string `json:"recipients"`
	Amounts         []string `json:"amounts"`
	RunIDHash       string   `json:"run_id_hash"`
}

type executeResponse struct {
	RunID   string       `json:"run_id"`
	Status  string       `json:"status"`
	Spender string       `json:"spender"`
	Legs    []payrollLeg `json:"legs"`
}

// Execute is POST /v1/payroll_runs/{id}/execute.
func (h *PayrollRuns) Execute(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}
	if strings.TrimSpace(h.PayrollContract) == "" {
		writeErr(w, apierrors.E(apierrors.CodePayrollNotConfigured, ""))
		return
	}
	runID := pathParam(r, "id")
	var req struct {
		RunKey string `json:"run_key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.RunKey) == "" {
		// Required, not optional. Without one there is nothing to refuse a
		// second attempt with, and a payroll is the last place to make
		// idempotency opt-in.
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "run_key"))
		return
	}
	runKey := strings.TrimSpace(req.RunKey)

	ctx := r.Context()

	// Claim it. One statement, so two requests arriving together cannot both
	// pass: the unique index on (account_id, run_key) rejects the loser, and
	// the status guard rejects a run somebody already executed.
	var treasury string
	err := h.Pool.QueryRow(ctx,
		`UPDATE payroll_runs
		    SET run_key = $1, status = 'executing', executed_at = now()
		  WHERE id = $2 AND account_id = $3 AND status = 'draft'
		  RETURNING treasury_currency`,
		runKey, runID, principal.AccountID,
	).Scan(&treasury)

	if err != nil {
		// A duplicate key means this exact run key was already used. Answering
		// with the run it belongs to rather than a bare error, because the
		// caller retrying almost certainly wants to know what happened to it.
		var existingID, existingStatus string
		if lookupErr := h.Pool.QueryRow(ctx,
			`SELECT id, status FROM payroll_runs WHERE account_id = $1 AND run_key = $2`,
			principal.AccountID, runKey,
		).Scan(&existingID, &existingStatus); lookupErr == nil {
			e := apierrors.E(apierrors.CodePayrollKeyReused, "run_key")
			writeJSON(w, e.Status, map[string]any{
				"error":  e,
				"run_id": existingID,
				"status": existingStatus,
			})
			return
		}
		if errors.Is(err, pgx.ErrNoRows) {
			// Either it does not exist, or it is not a draft any more.
			var status string
			if e2 := h.Pool.QueryRow(ctx,
				`SELECT status FROM payroll_runs WHERE id = $1 AND account_id = $2`,
				runID, principal.AccountID).Scan(&status); e2 == nil {
				writeErr(w, apierrors.E(apierrors.CodePayrollNotDraft, ""))
				return
			}
			writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
			return
		}
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	legs, e := h.buildLegs(ctx, runID, treasury)
	if e != nil {
		// Put it back. The claim happens before any work so a second execute
		// cannot slip in beside this one -- but a failure here has moved no
		// money, and leaving the run 'executing' with its key consumed would
		// make it both unexecutable and unretryable over an error that touched
		// nothing.
		_, _ = h.Pool.Exec(ctx,
			`UPDATE payroll_runs SET status = 'draft', run_key = NULL, executed_at = NULL
			  WHERE id = $1 AND status = 'executing'`, runID)
		writeErr(w, e)
		return
	}
	if len(legs) == 0 {
		_, _ = h.Pool.Exec(ctx,
			`UPDATE payroll_runs SET status = 'draft', run_key = NULL, executed_at = NULL
			  WHERE id = $1 AND status = 'executing'`, runID)
		writeErr(w, apierrors.E(apierrors.CodePayrollNoEmployees, ""))
		return
	}
	writeJSON(w, http.StatusOK, executeResponse{
		RunID:   runID,
		Status:  "executing",
		Spender: h.PayrollContract,
		Legs:    legs,
	})
}

func (h *PayrollRuns) buildLegs(ctx context.Context, runID, treasury string) ([]payrollLeg, *apierrors.APIError) {
	rows, err := h.Pool.Query(ctx,
		`SELECT currency, address, amount::text
		   FROM payroll_run_items
		  WHERE run_id = $1 AND status = 'pending'
		  ORDER BY currency, address`,
		runID)
	if err != nil {
		return nil, apierrors.E(apierrors.CodeInternal, "")
	}
	defer rows.Close()

	byCurrency := map[string]*payrollLeg{}
	order := []string{}
	for rows.Next() {
		var cur, addr, amt string
		if err := rows.Scan(&cur, &addr, &amt); err != nil {
			return nil, apierrors.E(apierrors.CodeInternal, "")
		}
		leg, seen := byCurrency[cur]
		if !seen {
			info, ok := currency.ByISO(cur)
			if !ok {
				return nil, apierrors.E(apierrors.CodeCurrencyNotSupported, cur)
			}
			leg = &payrollLeg{
				Currency:        cur,
				Token:           info.Token,
				Total:           "0",
				NeedsConversion: cur != treasury,
				RunIDHash:       runIDHash(runID),
			}
			byCurrency[cur] = leg
			order = append(order, cur)
		}
		total, _ := new(big.Int).SetString(leg.Total, 10)
		n, _ := new(big.Int).SetString(amt, 10)
		leg.Total = total.Add(total, n).String()
		leg.Recipients = append(leg.Recipients, addr)
		leg.Amounts = append(leg.Amounts, amt)
	}

	out := make([]payrollLeg, 0, len(order))
	for _, cur := range order {
		out = append(out, *byCurrency[cur])
	}
	return out, nil
}

type recordLegRequest struct {
	Currency string `json:"currency"`
	TxHash   string `json:"tx_hash"`
	// Failed says the leg did not land, with a reason to show the people it did
	// not pay. Reported rather than inferred: a leg nobody reports is still
	// pending, which is the truthful state for one whose outcome is unknown.
	Failed bool   `json:"failed"`
	Error  string `json:"error"`
}

// RecordLeg is POST /v1/payroll_runs/{id}/legs — one currency group's outcome.
//
// Called once per group, as each transaction resolves. Not one call for the
// whole run: groups genuinely land at different times and can land differently,
// and collapsing them into one report is what makes "partial" impossible to
// express.
func (h *PayrollRuns) RecordLeg(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}
	runID := pathParam(r, "id")
	var req recordLegRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Currency) == "" {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "currency"))
		return
	}
	if !req.Failed && strings.TrimSpace(req.TxHash) == "" {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "tx_hash"))
		return
	}

	ctx := r.Context()
	var owned string
	if err := h.Pool.QueryRow(ctx,
		`SELECT id FROM payroll_runs WHERE id = $1 AND account_id = $2`,
		runID, principal.AccountID).Scan(&owned); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
		return
	}

	if req.Failed {
		_, err := h.Pool.Exec(ctx,
			`UPDATE payroll_run_items SET status = 'failed', error = $1
			  WHERE run_id = $2 AND currency = $3 AND status = 'pending'`,
			nullIfEmpty(req.Error), runID, req.Currency)
		if err != nil {
			writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
			return
		}
	} else {
		// The chain, not the caller.
		//
		// Payouts already read the receipt before recording one; this did not,
		// so a caller could report a payroll paid that never happened and every
		// person in it would be told they had been. The contract emits one
		// PayrollRun carrying the run id, the token and the total, which is
		// exactly the claim being made.
		total, e := h.groupTotal(ctx, runID, req.Currency)
		if e != nil {
			writeErr(w, e)
			return
		}
		ok, err := h.dispersed(ctx, strings.TrimSpace(req.TxHash), runID, req.Currency, total)
		if err != nil {
			writeErr(w, apierrors.E(apierrors.CodeUpstreamUnavailable, "arc rpc"))
			return
		}
		if !ok {
			writeErr(w, apierrors.E(apierrors.CodePayrollNotOnChain, "tx_hash"))
			return
		}
		if _, err := h.Pool.Exec(ctx,
			`UPDATE payroll_run_items SET status = 'paid', tx_hash = $1, error = NULL
			  WHERE run_id = $2 AND currency = $3 AND status = 'pending'`,
			strings.TrimSpace(req.TxHash), runID, req.Currency); err != nil {
			writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
			return
		}
	}

	if e := h.settleRunStatus(ctx, runID, principal.AccountID); e != nil {
		writeErr(w, e)
		return
	}
	h.writeRun(w, r, runID, principal.AccountID, false)
}

// settleRunStatus recomputes the run's own status from its lines, and fires the
// webhook when it reaches an end state.
//
// Derived rather than set by the caller: the run's status is a fact about its
// items, and letting it be reported separately is how the two drift into
// disagreeing about whether somebody was paid.
func (h *PayrollRuns) settleRunStatus(ctx context.Context, runID, accountID string) *apierrors.APIError {
	var pending, paid, failed int
	if err := h.Pool.QueryRow(ctx,
		`SELECT count(*) FILTER (WHERE status = 'pending'),
		        count(*) FILTER (WHERE status = 'paid'),
		        count(*) FILTER (WHERE status = 'failed')
		   FROM payroll_run_items WHERE run_id = $1`,
		runID).Scan(&pending, &paid, &failed); err != nil {
		return apierrors.E(apierrors.CodeInternal, "")
	}
	if pending > 0 {
		return nil // still going
	}

	status := "completed"
	event := "payroll.run.completed"
	switch {
	case paid == 0:
		status, event = "failed", "payroll.run.failed"
	case failed > 0:
		// The whole reason this state exists. Calling it "failed" would be a lie
		// to the people who were paid; calling it "completed" would be one to
		// the people who were not.
		status, event = "partial", "payroll.run.partial"
	}

	if _, err := h.Pool.Exec(ctx,
		`UPDATE payroll_runs SET status = $1 WHERE id = $2`, status, runID); err != nil {
		return apierrors.E(apierrors.CodeInternal, "")
	}

	// Enqueued, not merely defined. Four events in this codebase were declared
	// and never sent, which is worse than not having them: an integration
	// subscribes and waits forever.
	if h.Webhooks != nil {
		_ = h.Webhooks.Enqueue(ctx, accountID, event, map[string]any{
			"run_id": runID,
			"status": status,
			"paid":   paid,
			"failed": failed,
		})
	}
	return nil
}

// runIDHash turns pr_xxx into the bytes32 the contract emits, so an indexer can
// match a chain event back to a row without a lookup table of its own.
//
// keccak of the id rather than the id padded into 32 bytes: an id is 23
// characters today and nothing guarantees it stays under 32, and a hash that
// silently truncates is a run that cannot be found later.
func runIDHash(runID string) string {
	return crypto.Keccak256Hash([]byte(runID)).Hex()
}

// groupTotal is what this currency's pending lines add up to — the figure the
// contract should have reported paying.
func (h *PayrollRuns) groupTotal(ctx context.Context, runID, currencyISO string) (*big.Int, *apierrors.APIError) {
	var total string
	if err := h.Pool.QueryRow(ctx,
		`SELECT COALESCE(sum(amount), 0)::text FROM payroll_run_items
		  WHERE run_id = $1 AND currency = $2 AND status = 'pending'`,
		runID, currencyISO).Scan(&total); err != nil {
		return nil, apierrors.E(apierrors.CodeInternal, "")
	}
	n, _ := new(big.Int).SetString(total, 10)
	return n, nil
}

// payrollRunTopic is keccak256 of the run-level event the contract emits.
var payrollRunTopic = crypto.Keccak256Hash([]byte("PayrollRun(bytes32,address,address,uint256,uint256)"))

// dispersed reports whether `txHash` really contains this group's payment.
//
// Matched on the run id AND the token AND the total, all three. The run id
// alone would accept a different currency's leg from the same run; the token
// alone would accept somebody else's payroll of the same asset.
func (h *PayrollRuns) dispersed(
	ctx context.Context, txHash, runID, currencyISO string, total *big.Int,
) (bool, error) {
	info, ok := currency.ByISO(currencyISO)
	if !ok {
		return false, nil
	}
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
	// A reverted transaction paid nobody, whatever its logs say.
	if receipt.Status != 1 {
		return false, nil
	}

	wantRun := crypto.Keccak256Hash([]byte(runID))
	wantToken := common.HexToAddress(info.Token)
	contract := common.HexToAddress(h.PayrollContract)
	for _, lg := range receipt.Logs {
		if lg.Address != contract || len(lg.Topics) != 4 || lg.Topics[0] != payrollRunTopic {
			continue
		}
		if lg.Topics[1] != wantRun {
			continue
		}
		if common.BytesToAddress(lg.Topics[2].Bytes()) != wantToken {
			continue
		}
		// recipients, then total — two non-indexed words, in declaration order.
		if len(lg.Data) < 64 {
			continue
		}
		if new(big.Int).SetBytes(lg.Data[32:64]).Cmp(total) == 0 {
			return true, nil
		}
	}
	return false, nil
}
