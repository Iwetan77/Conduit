package handlers

// Paying everybody, once.
//
// A run is built, looked at, and then executed. Those are three separate acts
// on purpose: the thing that makes payroll frightening is finding out what you
// were about to do only after you had done it, so the draft exists to be read
// before anybody is paid.
//
// Two properties matter more than the rest.
//
// PAYING TWICE IS IMPOSSIBLE, not unlikely. A double-clicked button, a retried
// request, a browser restoring a tab -- all of them produce a second execute
// call, and none of them can be prevented in a UI. So execution carries a key
// and the database refuses the second one. It is a unique index, not a check in
// Go, because two requests in flight at once would both pass a check.
//
// PARTIAL IS AN OUTCOME, not an error. Currencies are dispersed in groups; one
// group can land while another fails. Reporting that as "failed" would be a lie
// to the people who were paid and to the business reconciling it. The run says
// which lines paid, which did not, and why, and a retry pays only the unpaid.

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kzn-labs/conduit/api/internal/arcrpc"
	"github.com/kzn-labs/conduit/api/internal/auth"
	"github.com/kzn-labs/conduit/api/internal/currency"
	apierrors "github.com/kzn-labs/conduit/api/internal/errors"
	"github.com/kzn-labs/conduit/api/internal/models"
	"github.com/kzn-labs/conduit/api/internal/webhooks"
)

type PayrollRuns struct {
	Pool     *pgxpool.Pool
	Webhooks *webhooks.Dispatcher
	ArcRPC   string
	// PayrollContract is the deployed ConduitPayroll. Without it a run can be
	// drafted and read but not executed -- the same opt-in shape the bridge
	// uses, so a deployment without the address degrades rather than panics.
	PayrollContract string
}

type payrollItem struct {
	ID         string  `json:"id"`
	EmployeeID string  `json:"employee_id"`
	Name       string  `json:"name"`
	Username   *string `json:"username"`
	Address    string  `json:"address"`
	Currency   string  `json:"currency"`
	Amount     string  `json:"amount"`
	Status     string  `json:"status"`
	TxHash     *string `json:"tx_hash"`
	Error      *string `json:"error"`
}

// payrollGroup is one currency's worth of a run — one disperse call.
type payrollGroup struct {
	Currency string `json:"currency"`
	Total    string `json:"total"`
	Count    int    `json:"recipients"`
	// NeedsConversion is true when the business does not hold this currency and
	// a StableFX leg has to run before the group can be paid.
	NeedsConversion bool   `json:"needs_conversion"`
	Status          string `json:"status"`
}

type payrollRunResponse struct {
	ID               string         `json:"id"`
	Status           string         `json:"status"`
	TreasuryCurrency string         `json:"treasury_currency"`
	Items            []payrollItem  `json:"items"`
	Groups           []payrollGroup `json:"groups"`
	CreatedAt        time.Time      `json:"created_at"`
	ExecutedAt       *time.Time     `json:"executed_at"`
	// Preview, present on the draft. What the business needs in order to decide,
	// rather than to find out afterwards.
	WalletBalance   *string `json:"wallet_balance,omitempty"`
	EstimatedGas    *string `json:"estimated_gas,omitempty"`
	BalanceCovers   *bool   `json:"balance_covers,omitempty"`
	SettleAddress   string  `json:"settle_address,omitempty"`
	ContractAddress string  `json:"payroll_contract,omitempty"`
}

// Gas, in USDC, because Arc charges it in USDC rather than a separate native
// token — so a business needs USDC to run payroll at all, on top of what it is
// paying out. Measured at 28,825 per recipient in the contract's own tests,
// plus the fixed cost of the pull; rounded up, because a preview that
// underestimates is worse than one that does not.
const gasPerRecipient = 35_000
const gasFixed = 80_000

// Fallback only, and deliberately high.
//
// This was hardcoded at 1 gwei. Arc charges 21, so the preview came out
// TWENTY-ONE TIMES too low -- it would have told a business it could afford a
// payroll it could not, which is the exact failure the preview exists to
// prevent. Measured against a real disperse: 196,113 gas at 21 gwei cost 4,118
// USDC minor units, and the old formula said 196.
//
// The live price is read instead, and this is what to use when that read fails.
// Erring high: an over-estimate makes somebody top up unnecessarily, an
// under-estimate makes a payroll fail halfway.
const fallbackGasPriceWei = 30_000_000_000 // 30 gwei

// Arc's native unit is 18-decimal while USDC is 6, so a wei-denominated fee
// divides by 1e12 to land in USDC minor units. Verified against a real receipt.
var weiPerUSDCMinorUnit = big.NewInt(1_000_000_000_000)

func estimateGasCost(recipients, groups int, gasPriceWei *big.Int) *big.Int {
	units := big.NewInt(int64(gasFixed*groups + gasPerRecipient*recipients))
	return new(big.Int).Div(new(big.Int).Mul(units, gasPriceWei), weiPerUSDCMinorUnit)
}

// gasPrice asks the chain, because a hardcoded one was wrong by a factor of 21
// and nothing noticed until a receipt was read by hand.
func (h *PayrollRuns) gasPrice(ctx context.Context) *big.Int {
	client, err := arcrpc.Get(ctx, h.ArcRPC)
	if err == nil {
		callCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		if p, err := client.SuggestGasPrice(callCtx); err == nil && p.Sign() > 0 {
			// A fifth on top. Gas moves between drafting a run and signing it,
			// and the direction that hurts is upward.
			return new(big.Int).Div(new(big.Int).Mul(p, big.NewInt(6)), big.NewInt(5))
		}
	}
	return big.NewInt(fallbackGasPriceWei)
}

// Create is POST /v1/payroll_runs — builds a draft and returns the whole
// preview. Nothing is paid, and nothing is committed to except the amounts.
func (h *PayrollRuns) Create(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}
	var req struct {
		// Amounts for variable employees, keyed by employee id. A run cannot be
		// executed while any variable line is blank, and asking for them here
		// means the blank is visible in the preview rather than at execution.
		Amounts map[string]string `json:"amounts"`
		// Pay one group only. Absent means everybody active, which is what a
		// run has always meant and what an account with no groups still gets.
		//
		// This is the whole point of groups: one person often runs more than one
		// business, and paying one team used to mean pausing every other team
		// and remembering to unpause them.
		GroupID string `json:"group_id"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	ctx := r.Context()
	var treasury, settleAddress string
	if err := h.Pool.QueryRow(ctx,
		`SELECT settle_currency, settle_address FROM accounts WHERE id = $1`, principal.AccountID,
	).Scan(&treasury, &settleAddress); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	// Refused, not ignored. A group id belonging to somebody else would filter
	// this to nobody, and a payroll that pays nobody reports as "done" rather
	// than as "wrong" -- the worst possible way for this to fail.
	groupID := strings.TrimSpace(req.GroupID)
	if groupID != "" && !groupBelongsTo(ctx, h.Pool, groupID, principal.AccountID) {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "group_id"))
		return
	}

	rows, err := h.Pool.Query(ctx,
		`SELECT id, name, username, address, pay_currency, pay_type, amount::text
		   FROM employees
		  WHERE account_id = $1 AND status = 'active'
		    AND ($2 = '' OR group_id = $2)
		  ORDER BY created_at`,
		principal.AccountID, groupID)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	type staged struct {
		id, name, address, cur string
		username               *string
		amount                 *big.Int
	}
	var lines []staged
	for rows.Next() {
		var s staged
		var payType string
		var amt *string
		if err := rows.Scan(&s.id, &s.name, &s.username, &s.address, &s.cur, &payType, &amt); err != nil {
			rows.Close()
			writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
			return
		}
		switch payType {
		case "fixed":
			s.amount, _ = new(big.Int).SetString(*amt, 10)
		case "variable":
			given, ok := req.Amounts[s.id]
			if !ok || strings.TrimSpace(given) == "" {
				// Named, so the caller knows WHICH line is blank. "Some amounts
				// are missing" on a fifty-person payroll is not usable.
				rows.Close()
				writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "amounts."+s.id))
				return
			}
			n, ok := new(big.Int).SetString(strings.TrimSpace(given), 10)
			if !ok || n.Sign() <= 0 {
				rows.Close()
				writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "amounts."+s.id))
				return
			}
			s.amount = n
		}
		lines = append(lines, s)
	}
	rows.Close()
	if len(lines) == 0 {
		writeErr(w, apierrors.E(apierrors.CodePayrollNoEmployees, ""))
		return
	}

	tx, err := h.Pool.Begin(ctx)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	defer tx.Rollback(ctx)

	runID := models.NewID("pr")
	if _, err := tx.Exec(ctx,
		`INSERT INTO payroll_runs (id, account_id, treasury_currency) VALUES ($1,$2,$3)`,
		runID, principal.AccountID, treasury,
	); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	for _, l := range lines {
		if _, err := tx.Exec(ctx,
			`INSERT INTO payroll_run_items (id, run_id, employee_id, address, currency, amount)
			 VALUES ($1,$2,$3,$4,$5,$6)`,
			models.NewID("pri"), runID, l.id, l.address, l.cur, l.amount.String(),
		); err != nil {
			writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	h.writeRun(w, r, runID, principal.AccountID, true)
}

// Discard is DELETE /v1/payroll_runs/{id} — throws away a draft nobody ran.
//
// Drafts are cheap to make and somebody deciding not to run one is the normal
// case, not an error: they open the preview to see the number and close it.
// Without this, every one of those left a row behind forever.
//
// Only a draft, and the status guard sits in the WHERE clause rather than in a
// read followed by a delete — an executed run is a financial record, and a
// check in Go would let this route race an execute that claimed the run
// between the two statements. The items go with it through the run_id foreign
// key's ON DELETE CASCADE (migration 0028).
func (h *PayrollRuns) Discard(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}
	runID := pathParam(r, "id")
	ctx := r.Context()

	tag, err := h.Pool.Exec(ctx,
		`DELETE FROM payroll_runs
		  WHERE id = $1 AND account_id = $2 AND status = 'draft'`,
		runID, principal.AccountID)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	if tag.RowsAffected() == 0 {
		// Either it never existed, it belongs to somebody else, or it has been
		// run. Distinguishing the last is worth it: a client discarding a run
		// it already executed has a bug worth naming.
		var status string
		if e := h.Pool.QueryRow(ctx,
			`SELECT status FROM payroll_runs WHERE id = $1 AND account_id = $2`,
			runID, principal.AccountID).Scan(&status); e == nil {
			writeErr(w, apierrors.E(apierrors.CodePayrollNotDraft, ""))
			return
		}
		writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Get is GET /v1/payroll_runs/{id}.
func (h *PayrollRuns) Get(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}
	h.writeRun(w, r, pathParam(r, "id"), principal.AccountID, false)
}

// List is GET /v1/payroll_runs.
func (h *PayrollRuns) List(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}
	// Drafts are excluded. A draft is a question — "here is what running
	// payroll would do" — and building one to look at it is not an event in
	// this business's history. Listing them put a row reading "draft" into Past
	// runs for every preview anybody ever opened and backed out of, which is
	// both noise and a lie about what happened.
	//
	// Filtered here rather than only hidden in the dashboard, because the same
	// list is what an API client reads, and "past runs" has to mean the same
	// thing to both.
	rows, err := h.Pool.Query(r.Context(),
		`SELECT id, status, treasury_currency, created_at, executed_at
		   FROM payroll_runs
		  WHERE account_id = $1 AND status <> 'draft'
		  ORDER BY created_at DESC`,
		principal.AccountID)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	defer rows.Close()
	out := []payrollRunResponse{}
	for rows.Next() {
		var p payrollRunResponse
		if err := rows.Scan(&p.ID, &p.Status, &p.TreasuryCurrency, &p.CreatedAt, &p.ExecutedAt); err != nil {
			writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
			return
		}
		out = append(out, p)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

func (h *PayrollRuns) load(ctx context.Context, runID, accountID string) (*payrollRunResponse, error) {
	var p payrollRunResponse
	err := h.Pool.QueryRow(ctx,
		`SELECT id, status, treasury_currency, created_at, executed_at
		   FROM payroll_runs WHERE id = $1 AND account_id = $2`,
		runID, accountID).Scan(&p.ID, &p.Status, &p.TreasuryCurrency, &p.CreatedAt, &p.ExecutedAt)
	if err != nil {
		return nil, err
	}
	rows, err := h.Pool.Query(ctx,
		`SELECT i.id, i.employee_id, e.name, e.username, i.address, i.currency,
		        i.amount::text, i.status, i.tx_hash, i.error
		   FROM payroll_run_items i
		   JOIN employees e ON e.id = i.employee_id
		  WHERE i.run_id = $1
		  ORDER BY i.currency, e.name`,
		runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	p.Items = []payrollItem{}
	for rows.Next() {
		var it payrollItem
		if err := rows.Scan(&it.ID, &it.EmployeeID, &it.Name, &it.Username, &it.Address,
			&it.Currency, &it.Amount, &it.Status, &it.TxHash, &it.Error); err != nil {
			return nil, err
		}
		p.Items = append(p.Items, it)
	}
	p.Groups = groupItems(p.Items, p.TreasuryCurrency)
	return &p, nil
}

// groupItems collapses the lines into one entry per currency — which is what a
// run actually executes as, since a disperse call pays one token.
func groupItems(items []payrollItem, treasury string) []payrollGroup {
	totals := map[string]*big.Int{}
	counts := map[string]int{}
	paid := map[string]int{}
	failed := map[string]int{}
	for _, it := range items {
		n, _ := new(big.Int).SetString(it.Amount, 10)
		if totals[it.Currency] == nil {
			totals[it.Currency] = new(big.Int)
		}
		totals[it.Currency].Add(totals[it.Currency], n)
		counts[it.Currency]++
		switch it.Status {
		case "paid":
			paid[it.Currency]++
		case "failed":
			failed[it.Currency]++
		}
	}
	out := make([]payrollGroup, 0, len(totals))
	for cur, total := range totals {
		status := "pending"
		switch {
		case paid[cur] == counts[cur]:
			status = "paid"
		case failed[cur] > 0:
			status = "failed"
		}
		out = append(out, payrollGroup{
			Currency:        cur,
			Total:           total.String(),
			Count:           counts[cur],
			NeedsConversion: cur != treasury,
			Status:          status,
		})
	}
	// Stable order, so a preview does not reshuffle between reads and a person
	// re-reading it sees the same list.
	sort.Slice(out, func(i, j int) bool { return out[i].Currency < out[j].Currency })
	return out
}

func (h *PayrollRuns) writeRun(w http.ResponseWriter, r *http.Request, runID, accountID string, preview bool) {
	p, err := h.load(r.Context(), runID, accountID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
		return
	}
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	if preview {
		var settleAddress string
		_ = h.Pool.QueryRow(r.Context(),
			`SELECT settle_address FROM accounts WHERE id = $1`, accountID).Scan(&settleAddress)
		p.SettleAddress = settleAddress
		p.ContractAddress = h.PayrollContract

		a := h.affordability(r.Context(), p, settleAddress)
		gasStr := a.gas.String()
		p.EstimatedGas = &gasStr
		// The balance, so "you cannot afford this" is said HERE rather than at
		// the challenge — where it arrives as a failed transaction with
		// everybody's payment already in motion.
		if a.balanceKnown {
			balStr := a.have.String()
			p.WalletBalance = &balStr
			covers := a.covers()
			p.BalanceCovers = &covers
		}
	}
	writeJSON(w, http.StatusOK, p)
}

// affordability is the one answer to "can this wallet run this payroll".
//
// One function because there are two callers who must never disagree: the
// preview that reports it and the execute guard that refuses on it. Two copies
// of this arithmetic would eventually differ, and the way that surfaces is a
// preview saying the run is covered and the execute call refusing it — which
// reads as a broken product rather than an empty wallet.
type payrollAffordability struct {
	// need is the treasury-currency total plus gas. Groups in OTHER currencies
	// are excluded deliberately: they are not spendable from this balance and
	// have to be converted first, so counting them here would refuse runs that
	// are perfectly affordable.
	need *big.Int
	have *big.Int
	gas  *big.Int
	// False when the balance could not be read at all. Callers decide what to
	// do with that; neither of them may treat it as zero.
	balanceKnown bool
}

func (a payrollAffordability) covers() bool {
	return a.balanceKnown && a.have.Cmp(a.need) >= 0
}

// short returns how much is missing, or nil when nothing is.
func (a payrollAffordability) short() *big.Int {
	if a.covers() || !a.balanceKnown {
		return nil
	}
	return new(big.Int).Sub(a.need, a.have)
}

func (h *PayrollRuns) affordability(ctx context.Context, p *payrollRunResponse, settleAddress string) payrollAffordability {
	a := payrollAffordability{
		gas:  estimateGasCost(len(p.Items), len(p.Groups), h.gasPrice(ctx)),
		have: new(big.Int),
	}
	a.need = new(big.Int).Set(a.gas)
	for _, g := range p.Groups {
		if g.Currency == p.TreasuryCurrency {
			t, _ := new(big.Int).SetString(g.Total, 10)
			a.need.Add(a.need, t)
		}
	}
	if bal, err := h.treasuryBalance(ctx, settleAddress, p.TreasuryCurrency); err == nil {
		a.have = bal
		a.balanceKnown = true
	}
	return a
}

func (h *PayrollRuns) treasuryBalance(ctx context.Context, address, iso string) (*big.Int, error) {
	info, ok := currency.ByISO(iso)
	if !ok {
		return nil, errors.New("unknown currency")
	}
	return erc20BalanceOf(ctx, h.ArcRPC, info.Token, address)
}

// erc20BalanceOf reads one token balance.
//
// Deliberately not the multicall the balances endpoint uses: that reads every
// currency at once because a payer's screen shows all of them, whereas this
// wants one, and a preview that fails because an unrelated token's call
// reverted would be a worse answer than no preview.
func erc20BalanceOf(ctx context.Context, rpcURL, token, owner string) (*big.Int, error) {
	client, err := arcrpc.Get(ctx, rpcURL)
	if err != nil {
		return nil, err
	}
	callCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()

	selector, _ := hex.DecodeString("70a08231")
	data := append(append([]byte{}, selector...),
		common.LeftPadBytes(common.HexToAddress(owner).Bytes(), 32)...)
	to := common.HexToAddress(token)
	out, err := client.CallContract(callCtx, ethereum.CallMsg{To: &to, Data: data}, nil)
	if err != nil {
		return nil, err
	}
	return new(big.Int).SetBytes(out), nil
}
