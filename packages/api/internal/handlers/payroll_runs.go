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

// A price rather than an oracle. Arc testnet gas is cheap and stable, and a
// preview figure that is roughly right is worth far more than a figure that
// needs a live call to produce and can therefore fail.
const gasPriceWei = 1_000_000_000 // 1 gwei

func estimateGasCost(recipients int, groups int) *big.Int {
	units := big.NewInt(int64(gasFixed*groups + gasPerRecipient*recipients))
	return new(big.Int).Div(new(big.Int).Mul(units, big.NewInt(gasPriceWei)), big.NewInt(1_000_000_000_000))
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

	rows, err := h.Pool.Query(ctx,
		`SELECT id, name, username, address, pay_currency, pay_type, amount::text
		   FROM employees WHERE account_id = $1 AND status = 'active'
		  ORDER BY created_at`,
		principal.AccountID)
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
	rows, err := h.Pool.Query(r.Context(),
		`SELECT id, status, treasury_currency, created_at, executed_at
		   FROM payroll_runs WHERE account_id = $1 ORDER BY created_at DESC`,
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

		gas := estimateGasCost(len(p.Items), len(p.Groups))
		gasStr := gas.String()
		p.EstimatedGas = &gasStr

		// The balance, so "you cannot afford this" is said HERE rather than at
		// the challenge — where it arrives as a failed transaction with
		// everybody's payment already in motion.
		if bal, err := h.treasuryBalance(r.Context(), settleAddress, p.TreasuryCurrency); err == nil {
			balStr := bal.String()
			p.WalletBalance = &balStr
			need := new(big.Int).Set(gas)
			for _, g := range p.Groups {
				if g.Currency == p.TreasuryCurrency {
					t, _ := new(big.Int).SetString(g.Total, 10)
					need.Add(need, t)
				}
			}
			covers := bal.Cmp(need) >= 0
			p.BalanceCovers = &covers
		}
	}
	writeJSON(w, http.StatusOK, p)
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
