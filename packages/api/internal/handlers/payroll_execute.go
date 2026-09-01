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
	"fmt"
	"log"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
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

	// Can this wallet actually pay for it?
	//
	// Checked BEFORE the claim, so a refusal leaves the run a draft that can be
	// executed again once the wallet is topped up — nothing to release, no key
	// burned. And checked here rather than only in the browser, because the
	// browser's copy is a disabled button and a disabled button is a
	// suggestion: this route is reachable with an API key.
	//
	// The shortfall used to be a warning next to a working button. A payroll
	// that starts short does not fail cleanly — the first group pays, the
	// wallet empties, and a later group reverts — so the outcome is some people
	// paid and some not, chosen by whatever order the currencies sorted in.
	if p, err := h.load(ctx, runID, principal.AccountID); err == nil && p.Status == "draft" {
		var settleAddress string
		_ = h.Pool.QueryRow(ctx,
			`SELECT settle_address FROM accounts WHERE id = $1`, principal.AccountID).Scan(&settleAddress)
		a := h.affordability(ctx, p, settleAddress)
		// Only on a balance we actually read. An unreachable RPC must not stop
		// payroll — that would turn a flaky node into an outage for the one
		// operation with a deadline attached — and the on-chain transaction is
		// still the real check either way.
		if short := a.short(); short != nil {
			e := apierrors.E(apierrors.CodePayrollShortBalance, "")
			writeJSON(w, e.Status, map[string]any{
				"error":    e,
				"balance":  a.have.String(),
				"required": a.need.String(),
				"short_by": short.String(),
				"currency": p.TreasuryCurrency,
			})
			return
		}
	}

	// Claim it. One statement, so two requests arriving together cannot both
	// pass: the unique index on (account_id, run_key) rejects the loser, and
	// the status guard rejects a run somebody already executed.
	var treasury string
	err := h.claimRun(ctx, runID, principal.AccountID, runKey, "draft", &treasury)

	if err != nil {
		// A duplicate key means this exact run key was already used. Answering
		// with the run it belongs to rather than a bare error, because the
		// caller retrying almost certainly wants to know what happened to it.
		var existingID, existingStatus string
		// Looked up in payroll_run_keys, not payroll_runs.run_key.
		//
		// That column is overwritten when a stalled run is resumed, so after a
		// resume it no longer names the run that consumed the ORIGINAL key --
		// and this lookup found nothing, turning a perfectly correct refusal
		// into a 500. The key table is the authoritative record of what was
		// consumed and by which run, which is exactly the question here.
		if lookupErr := h.Pool.QueryRow(ctx,
			`SELECT r.id, r.status
			   FROM payroll_run_keys k
			   JOIN payroll_runs r ON r.id = k.run_id
			  WHERE k.account_id = $1 AND k.run_key = $2`,
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

// payrollResumeMinAge is how long a run must have sat still before it may be
// resumed.
//
// The number is a judgement about people, not machines: it has to outlast a
// merchant reading a wallet prompt, checking an amount, and approving it, plus
// the time the transaction takes to confirm. Shorter and a resume races a
// browser that is still working, and two live sessions build legs from the
// same pending rows -- whichever confirms second pays people the first already
// paid. Longer and somebody whose tab genuinely crashed waits for no reason.
const payrollResumeMinAge = 10 * time.Minute

// payrollStallThreshold is when a run stuck in 'executing' stops being slow and
// starts being a problem somebody must be told about.
//
// Deliberately longer than payrollResumeMinAge: the merchant should be able to
// fix it themselves before a webhook announces it as an incident.
const payrollStallThreshold = 30 * time.Minute

// maxPayrollRecipients mirrors ConduitPayroll.MAX_RECIPIENTS.
//
// Derived there from Arc's 30,000,000 block gas limit against the 35,000 gas a
// recipient costs (gasPerRecipient), with better than half of it as headroom.
// Duplicated here rather than read from the chain because a draft must be
// refusable without an RPC call — but the two MUST move together, and the
// contract's own comment says so from its side.
const maxPayrollRecipients = 400

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
		leg := *byCurrency[cur]
		// The same cap the contract enforces, checked HERE so it surfaces at
		// draft time.
		//
		// ConduitPayroll reverts TooManyRecipients above MAX_RECIPIENTS. Left
		// only to the contract, a business with too large a roster finds out
		// after signing and paying for the approve -- a wasted signature and a
		// wasted fee for a run that could never have worked. This one number
		// has to move in both places at once; the contract's own comment says
		// the same thing from the other side.
		if len(leg.Recipients) > maxPayrollRecipients {
			return nil, apierrors.E(apierrors.CodeInvalidRequest,
				fmt.Sprintf(
					"a payroll run can pay at most %d people in one currency; %s has %d. Pause some, or split them across two runs.",
					maxPayrollRecipients, cur, len(leg.Recipients),
				))
		}
		out = append(out, leg)
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

		// The business's own treasury is the only wallet that may pay this
		// account's payroll.
		var settleAddress string
		_ = h.Pool.QueryRow(ctx,
			`SELECT settle_address FROM accounts WHERE id = $1`, principal.AccountID,
		).Scan(&settleAddress)

		txHash := strings.TrimSpace(req.TxHash)
		paid, err := h.dispersed(ctx, txHash, runID, req.Currency, total, settleAddress)
		if err != nil {
			writeErr(w, apierrors.E(apierrors.CodeUpstreamUnavailable, "arc rpc"))
			return
		}
		if len(paid) == 0 {
			writeErr(w, apierrors.E(apierrors.CodePayrollNotOnChain, "tx_hash"))
			return
		}

		// One log per row, matched individually.
		//
		// This used to be a single UPDATE marking every pending item in the
		// currency as paid, on the strength of the aggregate event alone. A
		// caller could disperse the correct total to one address and everybody
		// in the group was recorded as paid. The contract emits a PayrollPaid
		// per recipient so that this does not have to be inferred, and each row
		// is now marked from its OWN matched log or left pending.
		//
		// A multiset, not a set: the contract deliberately allows the same
		// address twice — a person with salary and expenses as two arrangements
		// — and each line must consume its own log. Collapsing them would let
		// one payment mark two rows paid.
		available := map[payment]int{}
		for _, p := range paid {
			available[p]++
		}

		rows, err := h.Pool.Query(ctx,
			`SELECT id, address, amount::text FROM payroll_run_items
			  WHERE run_id = $1 AND currency = $2 AND status = 'pending'`,
			runID, req.Currency)
		if err != nil {
			writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
			return
		}
		type pendingItem struct{ id, addr, amount string }
		var pending []pendingItem
		for rows.Next() {
			var it pendingItem
			if err := rows.Scan(&it.id, &it.addr, &it.amount); err != nil {
				rows.Close()
				writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
				return
			}
			pending = append(pending, it)
		}
		rows.Close()

		matched := 0
		for _, it := range pending {
			key := payment{to: strings.ToLower(it.addr), amount: it.amount}
			if available[key] == 0 {
				// No log paid this person this amount. The row stays pending,
				// and settleRunStatus below reports the run as partial.
				continue
			}
			available[key]--
			if _, err := h.Pool.Exec(ctx,
				`UPDATE payroll_run_items SET status = 'paid', tx_hash = $1, error = NULL
				  WHERE id = $2 AND status = 'pending'`,
				txHash, it.id); err != nil {
				writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
				return
			}
			matched++
		}
		if matched == 0 {
			writeErr(w, apierrors.E(apierrors.CodePayrollNotOnChain, "tx_hash"))
			return
		}
		if matched < len(pending) {
			log.Printf(
				"payroll: run %s currency %s — tx %s paid %d of %d pending rows; the rest stay pending",
				runID, req.Currency, txHash, matched, len(pending),
			)
		}
	}

	// This run just moved. Recorded so the sweeper can tell a payroll that is
	// progressing slowly -- a merchant working through five wallet prompts --
	// from one nobody is driving any more. executed_at cannot say that: it is
	// set once and never again.
	_, _ = h.Pool.Exec(ctx,
		`UPDATE payroll_runs SET last_progress_at = now(), stalled_at = NULL WHERE id = $1`, runID)

	if e := h.settleRunStatus(ctx, runID, principal.AccountID); e != nil {
		writeErr(w, e)
		return
	}
	h.writeRun(w, r, runID, principal.AccountID, false)
}

// claimRun takes a run from `fromStatus` to 'executing' and BURNS the key.
//
// One transaction, so two requests arriving together cannot both pass: the
// primary key on payroll_run_keys rejects the loser, and the status guard
// rejects a run somebody already executed.
//
// The key is burned in a separate table rather than by writing it to
// payroll_runs.run_key. That column gets overwritten on resume, and uniqueness
// living there would mean the ORIGINAL key became replayable the moment a
// stalled run was recovered -- turning a recovery into a way to re-run a
// payroll.
func (h *PayrollRuns) claimRun(
	ctx context.Context, runID, accountID, runKey, fromStatus string, treasury *string,
) error {
	tx, err := h.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx,
		`INSERT INTO payroll_run_keys (account_id, run_key, run_id) VALUES ($1,$2,$3)`,
		accountID, runKey, runID); err != nil {
		return err
	}
	if err := tx.QueryRow(ctx,
		`UPDATE payroll_runs
		    SET run_key = $1, status = 'executing',
		        executed_at = COALESCE(executed_at, now()),
		        last_progress_at = now(),
		        stalled_at = NULL
		  WHERE id = $2 AND account_id = $3 AND status = $4
		  RETURNING treasury_currency`,
		runKey, runID, accountID, fromStatus,
	).Scan(treasury); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Resume is POST /v1/payroll_runs/{id}/resume.
//
// A run claimed with 'executing' and then abandoned -- tab closed, wallet hung,
// merchant walked away -- could never move again: Execute requires 'draft',
// settleRunStatus returns early while anything is pending, and the original key
// cannot be reused. Nothing recovered it and nothing said which employees had
// been paid. On a payroll that is somebody not getting their salary with no
// explanation available.
//
// Rebuilds legs from the still-pending items ONLY. buildLegs already filters
// `WHERE status = 'pending'`, which is exactly right and is why nobody already
// paid can be paid twice by a resume.
func (h *PayrollRuns) Resume(w http.ResponseWriter, r *http.Request) {
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
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "run_key"))
		return
	}
	runKey := strings.TrimSpace(req.RunKey)
	ctx := r.Context()

	// Old enough to be abandoned rather than slow.
	//
	// Without this, resume races the browser that is still signing: two live
	// sessions building legs from the same pending rows, and whichever wallet
	// confirms second pays people the first already paid. The wait is the whole
	// safety property -- a signature prompt a merchant is reading is not a
	// stalled run.
	var status string
	var age time.Duration
	var lastProgress *time.Time
	if err := h.Pool.QueryRow(ctx,
		`SELECT status, last_progress_at FROM payroll_runs WHERE id = $1 AND account_id = $2`,
		runID, principal.AccountID).Scan(&status, &lastProgress); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
		return
	}
	if status != "executing" {
		// Only a stalled run can be resumed. A draft is executed, and a
		// finished one is finished.
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest,
			"only a run stuck in 'executing' can be resumed; this one is '"+status+"'"))
		return
	}
	if lastProgress != nil {
		age = time.Since(*lastProgress)
	}
	if age < payrollResumeMinAge {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest,
			fmt.Sprintf(
				"this run last moved %s ago; a resume is only allowed after %s, so it cannot race a browser that is still signing",
				age.Round(time.Second), payrollResumeMinAge,
			)))
		return
	}

	var treasury string
	if err := h.claimRun(ctx, runID, principal.AccountID, runKey, "executing", &treasury); err != nil {
		// Almost always the key: the same one twice, or one already used on
		// another run.
		writeErr(w, apierrors.E(apierrors.CodePayrollKeyReused, "run_key"))
		return
	}

	legs, e := h.buildLegs(ctx, runID, treasury)
	if e != nil {
		writeErr(w, e)
		return
	}
	if len(legs) == 0 {
		// Everything already landed. Resolve it rather than leaving it stuck
		// again -- this is the case where the browser paid everybody and only
		// the final report was lost.
		if e := h.settleRunStatus(ctx, runID, principal.AccountID); e != nil {
			writeErr(w, e)
			return
		}
		writeJSON(w, http.StatusOK, executeResponse{
			RunID: runID, Spender: h.PayrollContract, Legs: []payrollLeg{},
		})
		return
	}

	writeJSON(w, http.StatusOK, executeResponse{
		RunID:   runID,
		Spender: h.PayrollContract,
		Legs:    legs,
	})
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

// payrollPaidTopic is the PER-RECIPIENT event. This is the one that says who
// was actually paid; PayrollRun only says how much left the payer's wallet.
var payrollPaidTopic = crypto.Keccak256Hash([]byte("PayrollPaid(bytes32,address,address,uint256)"))

// payment is one (recipient, amount) pair read off a PayrollPaid log.
type payment struct {
	to     string
	amount string
}

// dispersed reads a payroll transaction and reports WHO it actually paid.
//
// It used to return a bool, having checked only that a PayrollRun event carried
// the right run id, token and total. The caller then marked EVERY pending item
// in that currency as paid. Those two facts do not add up to each other: a
// caller could disperse the correct total to a single address of their choosing
// and every employee in the group would be recorded as paid, with
// payroll.run.completed fired and nothing anywhere saying otherwise. The
// contract emits one PayrollPaid per recipient precisely so this does not have
// to be inferred.
//
// So it returns the per-recipient payments, and the caller matches each one to
// a row. A row with no matching log stays pending.
//
// The payer is checked too. A merchant's payroll should be paid out of the
// merchant's own treasury, and until now nothing said so — the run-level event
// carries `payer` as msg.sender, which was read past.
func (h *PayrollRuns) dispersed(
	ctx context.Context, txHash, runID, currencyISO string, total *big.Int, settleAddress string,
) ([]payment, error) {
	info, ok := currency.ByISO(currencyISO)
	if !ok {
		return nil, nil
	}
	client, err := arcrpc.Get(ctx, h.ArcRPC)
	if err != nil {
		return nil, err
	}
	callCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	receipt, err := client.TransactionReceipt(callCtx, common.HexToHash(txHash))
	if err != nil {
		return nil, err
	}
	return payrollPayments(
		receipt,
		common.HexToAddress(h.PayrollContract),
		crypto.Keccak256Hash([]byte(runID)),
		common.HexToAddress(info.Token),
		settleAddress,
		total,
	), nil
}

// payrollPayments reads who a payroll transaction ACTUALLY paid.
//
// Pure, so it can be tested against a hand-built receipt without an RPC. That
// matters more than usual here: the bug this replaces was invisible precisely
// because nothing could exercise the log-reading in isolation.
//
// Returns nil unless a matching run-level event is present AND the payer is the
// account's own treasury. Otherwise it returns one entry per PayrollPaid log,
// which is what the caller matches rows against.
func payrollPayments(
	receipt *types.Receipt,
	contract common.Address,
	wantRun common.Hash,
	wantToken common.Address,
	settleAddress string,
	total *big.Int,
) []payment {
	// A reverted transaction paid nobody, whatever its logs say.
	if receipt == nil || receipt.Status != 1 {
		return nil
	}

	wantPayer := common.HexToAddress(settleAddress)
	var runSeen bool
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
		// The business's money, from the business's wallet. A payroll paid out
		// of somebody else's balance is not this account's payroll, however
		// correct the total looks.
		if settleAddress != "" && common.BytesToAddress(lg.Topics[3].Bytes()) != wantPayer {
			continue
		}
		// recipients, then total — two non-indexed words, in declaration order.
		if len(lg.Data) < 64 {
			continue
		}
		if new(big.Int).SetBytes(lg.Data[32:64]).Cmp(total) == 0 {
			runSeen = true
			break
		}
	}
	if !runSeen {
		return nil
	}

	var paid []payment
	for _, lg := range receipt.Logs {
		if lg.Address != contract || len(lg.Topics) != 4 || lg.Topics[0] != payrollPaidTopic {
			continue
		}
		if lg.Topics[1] != wantRun {
			continue
		}
		if common.BytesToAddress(lg.Topics[2].Bytes()) != wantToken {
			continue
		}
		if len(lg.Data) < 32 {
			continue
		}
		paid = append(paid, payment{
			to:     strings.ToLower(common.BytesToAddress(lg.Topics[3].Bytes()).Hex()),
			amount: new(big.Int).SetBytes(lg.Data[:32]).String(),
		})
	}
	return paid
}
