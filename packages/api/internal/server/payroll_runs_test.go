package server

// Payroll runs.
//
// The property everything else serves: nobody is paid twice. A double-clicked
// button, a retried request and a restored tab all produce a second execute,
// and none of them can be prevented in a UI — so the refusal has to be here,
// and it has to hold when two arrive at once.
//
// After that: what a run says it owed cannot move when somebody edits a salary,
// and a run where one currency paid and another did not has to say so rather
// than pretending to be one or the other.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type payrollRun struct {
	ID               string `json:"id"`
	Status           string `json:"status"`
	TreasuryCurrency string `json:"treasury_currency"`
	Items            []struct {
		ID       string  `json:"id"`
		Name     string  `json:"name"`
		Currency string  `json:"currency"`
		Amount   string  `json:"amount"`
		Status   string  `json:"status"`
		TxHash   *string `json:"tx_hash"`
	} `json:"items"`
	Groups []struct {
		Currency        string `json:"currency"`
		Total           string `json:"total"`
		Recipients      int    `json:"recipients"`
		NeedsConversion bool   `json:"needs_conversion"`
		Status          string `json:"status"`
	} `json:"groups"`
	WalletBalance *string `json:"wallet_balance"`
	EstimatedGas  *string `json:"estimated_gas"`
	BalanceCovers *bool   `json:"balance_covers"`
}

// hireThree puts three people on the payroll across two currencies, which is
// the shape that makes "partial" possible at all.
func hireThree(t *testing.T, srvURL, key string) {
	t.Helper()
	for _, spec := range []struct{ name, cur, amount string }{
		{"Ada", "USD", "5000000"},
		{"Grace", "USD", "3000000"},
		{"Katherine", "EUR", "4000000"},
	} {
		_, addr := newSigner(t)
		resp, _ := addEmployee(t, srvURL, key, fmt.Sprintf(
			`{"name":%q,"address":%q,"pay_currency":%q,"pay_type":"fixed","amount":%q}`,
			spec.name, addr, spec.cur, spec.amount))
		if resp.status != http.StatusCreated {
			t.Fatalf("hire %s: status=%d body=%s", spec.name, resp.status, resp.body)
		}
	}
}

func draftRun(t *testing.T, srvURL, key, body string) (jsonResp, payrollRun) {
	t.Helper()
	resp := doJSON(t, srvURL, "POST", "/v1/payroll_runs", key, body, "")
	var run payrollRun
	_ = json.Unmarshal([]byte(resp.body), &run)
	return resp, run
}

// A draft is for reading before anybody is paid. It has to say what each person
// gets, what each currency totals, which need converting, and whether the wallet
// covers it — "you cannot afford this" belongs here, not at the signature.
func TestPayrollDraftShowsTheWholePicture(t *testing.T) {
	srv, key, _ := newLinkTestServer(t, 15611)
	hireThree(t, srv.URL, key)

	resp, run := draftRun(t, srv.URL, key, `{}`)
	if resp.status != http.StatusOK {
		t.Fatalf("draft: status=%d body=%s", resp.status, resp.body)
	}
	if run.Status != "draft" {
		t.Errorf("status=%q; nothing has been paid, so it must be a draft", run.Status)
	}
	if len(run.Items) != 3 {
		t.Fatalf("%d lines, want 3", len(run.Items))
	}
	if len(run.Groups) != 2 {
		t.Fatalf("%d currency groups, want 2 — a run executes one disperse per currency", len(run.Groups))
	}
	for _, g := range run.Groups {
		switch g.Currency {
		case "USD":
			if g.Total != "8000000" || g.Recipients != 2 {
				t.Errorf("USD group = %s across %d, want 8000000 across 2", g.Total, g.Recipients)
			}
			if g.NeedsConversion {
				t.Error("USD is the treasury currency and must not need converting")
			}
		case "EUR":
			if !g.NeedsConversion {
				t.Error("EUR is not the treasury currency, so it needs converting")
			}
		}
	}
	if run.EstimatedGas == nil {
		t.Error("no gas estimate: Arc charges gas in USDC, so a business needs to know before it commits")
	}
}

// The one that matters. Two executes with one key pay one payroll.
func TestPayrollASecondExecuteWithTheSameKeyPaysNobodyTwice(t *testing.T) {
	// Before the server is built: New() reads this once, at construction.
	t.Setenv("CONDUIT_PAYROLL_ADDRESS", "0xcC4b99a2B74DA98695d4136FB7F20988621BeB11")
	srv, key, p := newLinkTestServer(t, 15612)
	hireThree(t, srv.URL, key)
	_, run := draftRun(t, srv.URL, key, `{}`)

	first := doJSON(t, srv.URL, "POST", "/v1/payroll_runs/"+run.ID+"/execute", key,
		`{"run_key":"payroll-2026-08"}`, "")
	if first.status != http.StatusOK {
		t.Fatalf("first execute: status=%d body=%s", first.status, first.body)
	}

	// A second draft, so this is genuinely a re-use of the key rather than a
	// re-execution of the same run -- which is the shape a double-click on a
	// freshly reloaded page actually produces.
	_, second := draftRun(t, srv.URL, key, `{}`)
	dup := doJSON(t, srv.URL, "POST", "/v1/payroll_runs/"+second.ID+"/execute", key,
		`{"run_key":"payroll-2026-08"}`, "")
	if dup.status != http.StatusConflict {
		t.Fatalf("re-used key: status=%d, want 409; body=%s", dup.status, dup.body)
	}
	if got := errCode(t, dup.body); got != "payroll_run_key_reused" {
		t.Errorf("code=%s, want payroll_run_key_reused", got)
	}

	// The second run was never started, so nothing in it can be paid.
	var status string
	_ = p.QueryRow(context.Background(),
		`SELECT status FROM payroll_runs WHERE id = $1`, second.ID).Scan(&status)
	if status != "draft" {
		t.Fatalf("the refused run moved to %q; it must be untouched", status)
	}
}

// And it must hold when two arrive together, which a check in Go would not.
func TestPayrollConcurrentExecutesLeaveExactlyOneWinner(t *testing.T) {
	t.Setenv("CONDUIT_PAYROLL_ADDRESS", "0xcC4b99a2B74DA98695d4136FB7F20988621BeB11")
	srv, key, _ := newLinkTestServer(t, 15613)
	hireThree(t, srv.URL, key)

	const attempts = 6
	runs := make([]string, attempts)
	for i := range runs {
		_, r := draftRun(t, srv.URL, key, `{}`)
		runs[i] = r.ID
	}

	var wg sync.WaitGroup
	results := make([]int, attempts)
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			resp := doJSON(t, srv.URL, "POST", "/v1/payroll_runs/"+runs[i]+"/execute", key,
				`{"run_key":"one-key-many-clicks"}`, "")
			results[i] = resp.status
		}(i)
	}
	wg.Wait()

	winners := 0
	for _, s := range results {
		if s == http.StatusOK {
			winners++
		}
	}
	if winners != 1 {
		t.Fatalf("%d of %d concurrent executes succeeded; exactly one may", winners, attempts)
	}
}

// What a run says it owed cannot move afterwards. Editing a salary must never
// change what a past run says it paid — the same rule as an intent's address.
func TestARunsAmountsDoNotFollowAnEmployeesSalary(t *testing.T) {
	srv, key, p := newLinkTestServer(t, 15614)
	ctx := context.Background()
	hireThree(t, srv.URL, key)
	_, run := draftRun(t, srv.URL, key, `{}`)

	var employeeID, before string
	if err := p.QueryRow(ctx,
		`SELECT employee_id, amount::text FROM payroll_run_items WHERE run_id = $1 ORDER BY amount LIMIT 1`,
		run.ID).Scan(&employeeID, &before); err != nil {
		t.Fatalf("read item: %v", err)
	}

	raise := doJSON(t, srv.URL, "PATCH", "/v1/employees/"+employeeID, key,
		`{"pay_type":"fixed","amount":"99000000"}`, "")
	if raise.status != http.StatusOK {
		t.Fatalf("raise: status=%d body=%s", raise.status, raise.body)
	}

	var after string
	_ = p.QueryRow(ctx,
		`SELECT amount::text FROM payroll_run_items WHERE run_id = $1 AND employee_id = $2`,
		run.ID, employeeID).Scan(&after)
	if after != before {
		t.Fatalf("the run followed the raise: %s -> %s", before, after)
	}
}

// One currency paid and another failed is neither "completed" nor "failed". The
// run has to say exactly who was paid, or the people who were not cannot be told
// anything true.
func TestPayrollOneCurrencyPaidAndOneFailedIsPartial(t *testing.T) {
	t.Setenv("CONDUIT_PAYROLL_ADDRESS", "0xcC4b99a2B74DA98695d4136FB7F20988621BeB11")
	srv, key, p := newLinkTestServer(t, 15615)
	ctx := context.Background()
	hireThree(t, srv.URL, key)
	_, run := draftRun(t, srv.URL, key, `{}`)

	if resp := doJSON(t, srv.URL, "POST", "/v1/payroll_runs/"+run.ID+"/execute", key,
		`{"run_key":"partial-run"}`, ""); resp.status != http.StatusOK {
		t.Fatalf("execute: status=%d body=%s", resp.status, resp.body)
	}

	// The USD group is marked paid directly, because recording it through the
	// API now REQUIRES a transaction that really contains the run -- which is
	// the point of that check and cannot be produced without a chain. What is
	// under test here is the status derivation, and this is the state a
	// verified leg leaves behind. The API path is proven end to end in
	// scripts/e2e-payroll.sh against a real disperse.
	if _, err := p.Exec(ctx,
		`UPDATE payroll_run_items SET status = 'paid', tx_hash = '0xverified'
		  WHERE run_id = $1 AND currency = 'USD'`, run.ID); err != nil {
		t.Fatalf("mark USD paid: %v", err)
	}
	failed := doJSON(t, srv.URL, "POST", "/v1/payroll_runs/"+run.ID+"/legs", key,
		`{"currency":"EUR","failed":true,"error":"conversion quote expired"}`, "")
	if failed.status != http.StatusOK {
		t.Fatalf("record EUR: status=%d body=%s", failed.status, failed.body)
	}

	var status string
	_ = p.QueryRow(ctx, `SELECT status FROM payroll_runs WHERE id = $1`, run.ID).Scan(&status)
	if status != "partial" {
		t.Fatalf("status=%q; one group paid and one did not, which is partial", status)
	}

	var final payrollRun
	got := doJSON(t, srv.URL, "GET", "/v1/payroll_runs/"+run.ID, key, "", "")
	_ = json.Unmarshal([]byte(got.body), &final)
	var paidCount, failedCount int
	for _, it := range final.Items {
		switch it.Status {
		case "paid":
			paidCount++
			if it.TxHash == nil {
				t.Error("a paid line with no transaction is a payment nobody can find")
			}
		case "failed":
			failedCount++
		}
	}
	if paidCount != 2 || failedCount != 1 {
		t.Fatalf("paid=%d failed=%d, want 2 and 1 — the run must say exactly who was paid", paidCount, failedCount)
	}
}

// One business's payroll is not another's to draft against, read or execute.
func TestPayrollRunsAreScopedToTheirAccount(t *testing.T) {
	srv, keyA, _ := newLinkTestServer(t, 15616)
	hireThree(t, srv.URL, keyA)
	_, run := draftRun(t, srv.URL, keyA, `{}`)

	resp := doJSON(t, srv.URL, "POST", "/v1/accounts", "",
		`{"name":"Other Co","settle_currency":"USD","settle_address":"0x00000000000000000000000000000000000000f7"}`, "")
	var other struct {
		APIKey struct {
			Key string `json:"key"`
		} `json:"api_key"`
	}
	_ = json.Unmarshal([]byte(resp.body), &other)

	if got := doJSON(t, srv.URL, "GET", "/v1/payroll_runs/"+run.ID, other.APIKey.Key, "", ""); got.status != http.StatusNotFound {
		t.Errorf("another account read the run: status=%d", got.status)
	}
	if got := doJSON(t, srv.URL, "POST", "/v1/payroll_runs/"+run.ID+"/execute", other.APIKey.Key,
		`{"run_key":"hijack"}`, ""); got.status == http.StatusOK {
		t.Error("another account executed the run")
	}
}

// A payroll with nobody on it is refused rather than silently producing an empty
// run somebody then tries to execute.
func TestAPayrollWithNobodyActiveIsRefused(t *testing.T) {
	srv, key, _ := newLinkTestServer(t, 15617)
	resp, _ := draftRun(t, srv.URL, key, `{}`)
	if resp.status != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d, want 422; body=%s", resp.status, resp.body)
	}
}

// Recording a payment that did not happen would tell everybody in that group
// they had been paid. So the transaction has to actually contain the run —
// a hash on its own is a claim, not evidence.
func TestPayrollALegCannotBeRecordedOnAnUnrelatedTransaction(t *testing.T) {
	t.Setenv("CONDUIT_PAYROLL_ADDRESS", "0xcC4b99a2B74DA98695d4136FB7F20988621BeB11")
	srv, key, p := newLinkTestServer(t, 15618)
	ctx := context.Background()
	hireThree(t, srv.URL, key)
	_, run := draftRun(t, srv.URL, key, `{}`)

	if resp := doJSON(t, srv.URL, "POST", "/v1/payroll_runs/"+run.ID+"/execute", key,
		`{"run_key":"unverified-leg"}`, ""); resp.status != http.StatusOK {
		t.Fatalf("execute: status=%d body=%s", resp.status, resp.body)
	}

	// A well-formed hash for a transaction that is not this payroll. Whether the
	// chain says "no such transaction" or "not that run", the answer must not be
	// success.
	resp := doJSON(t, srv.URL, "POST", "/v1/payroll_runs/"+run.ID+"/legs", key,
		`{"currency":"USD","tx_hash":"0x2222222222222222222222222222222222222222222222222222222222222222"}`, "")
	if resp.status == http.StatusOK {
		t.Fatalf("an unrelated transaction recorded a payroll group as paid: %s", resp.body)
	}

	var paid int
	_ = p.QueryRow(ctx,
		`SELECT count(*) FROM payroll_run_items WHERE run_id = $1 AND status = 'paid'`,
		run.ID).Scan(&paid)
	if paid != 0 {
		t.Fatalf("%d lines were marked paid on an unverified claim", paid)
	}
}

// A failure after the run is claimed must not strand it. The claim happens
// before any work so a second execute cannot slip in, but an error that moved
// no money should leave the run runnable.
func TestPayrollAFailedExecuteReleasesTheRun(t *testing.T) {
	t.Setenv("CONDUIT_PAYROLL_ADDRESS", "0xcC4b99a2B74DA98695d4136FB7F20988621BeB11")
	srv, key, p := newLinkTestServer(t, 15619)
	ctx := context.Background()
	hireThree(t, srv.URL, key)
	_, run := draftRun(t, srv.URL, key, `{}`)

	// Every line already resolved, so there is nothing left to build legs from —
	// the shape a run is in when it has been fully recorded already.
	if _, err := p.Exec(ctx,
		`UPDATE payroll_run_items SET status = 'failed' WHERE run_id = $1`, run.ID); err != nil {
		t.Fatalf("seed: %v", err)
	}

	resp := doJSON(t, srv.URL, "POST", "/v1/payroll_runs/"+run.ID+"/execute", key,
		`{"run_key":"released"}`, "")
	if resp.status == http.StatusOK {
		t.Fatalf("a run with no payable lines executed: %s", resp.body)
	}

	var status string
	var runKey *string
	_ = p.QueryRow(ctx,
		`SELECT status, run_key FROM payroll_runs WHERE id = $1`, run.ID).Scan(&status, &runKey)
	if status != "draft" || runKey != nil {
		t.Fatalf("a failed execute stranded the run: status=%s key=%v", status, runKey)
	}
}

// ── Phase C2: a run that stranded itself ──────────────────────────────────────
//
// Execute claims a run as 'executing' and burns its key. If the browser then
// dies between claiming and reporting -- closed tab, hung wallet, merchant
// walked away mid-signature -- the run could never move again: Execute requires
// 'draft', settleRunStatus returns early while anything is pending, and the key
// cannot be reused. Nothing recovered it and nothing said who had been paid.

// stall backdates a run so it looks abandoned, which is the only way to test
// this without waiting ten real minutes.
func stall(t *testing.T, p *pgxpool.Pool, runID string, ago time.Duration) {
	t.Helper()
	if _, err := p.Exec(context.Background(),
		`UPDATE payroll_runs SET last_progress_at = now() - $1::interval WHERE id = $2`,
		ago.String(), runID); err != nil {
		t.Fatalf("backdating run: %v", err)
	}
}

func TestPayrollAnAbandonedRunCanBeResumed(t *testing.T) {
	t.Setenv("CONDUIT_PAYROLL_ADDRESS", "0xcC4b99a2B74DA98695d4136FB7F20988621BeB11")
	srv, key, p := newLinkTestServer(t, 15620)
	hireThree(t, srv.URL, key)
	_, run := draftRun(t, srv.URL, key, `{}`)

	first := doJSON(t, srv.URL, "POST", "/v1/payroll_runs/"+run.ID+"/execute", key,
		`{"run_key":"run-a"}`, "")
	if first.status != http.StatusOK {
		t.Fatalf("execute: status=%d body=%s", first.status, first.body)
	}

	// The browser dies here. Nothing is reported.
	stall(t, p, run.ID, 20*time.Minute)

	res := doJSON(t, srv.URL, "POST", "/v1/payroll_runs/"+run.ID+"/resume", key,
		`{"run_key":"run-b"}`, "")
	if res.status != http.StatusOK {
		t.Fatalf("resume: status=%d body=%s", res.status, res.body)
	}
	if !strings.Contains(res.body, `"legs"`) {
		t.Fatalf("resume returned no legs to sign: %s", res.body)
	}
}

// The wait is the safety property, not a formality: without it a resume races
// the browser that is still signing, and two sessions build legs from the same
// pending rows.
func TestPayrollAResumeAttemptedImmediatelyIsRefused(t *testing.T) {
	t.Setenv("CONDUIT_PAYROLL_ADDRESS", "0xcC4b99a2B74DA98695d4136FB7F20988621BeB11")
	srv, key, _ := newLinkTestServer(t, 15621)
	hireThree(t, srv.URL, key)
	_, run := draftRun(t, srv.URL, key, `{}`)

	doJSON(t, srv.URL, "POST", "/v1/payroll_runs/"+run.ID+"/execute", key, `{"run_key":"run-a"}`, "")

	res := doJSON(t, srv.URL, "POST", "/v1/payroll_runs/"+run.ID+"/resume", key,
		`{"run_key":"run-b"}`, "")
	if res.status == http.StatusOK {
		t.Fatal("resumed a run that had only just started — this races a live browser")
	}
}

// The whole point of resuming rather than re-running.
func TestPayrollAResumeDoesNotRePayAnyoneAlreadyPaid(t *testing.T) {
	t.Setenv("CONDUIT_PAYROLL_ADDRESS", "0xcC4b99a2B74DA98695d4136FB7F20988621BeB11")
	srv, key, p := newLinkTestServer(t, 15622)
	hireThree(t, srv.URL, key)
	_, run := draftRun(t, srv.URL, key, `{}`)
	doJSON(t, srv.URL, "POST", "/v1/payroll_runs/"+run.ID+"/execute", key, `{"run_key":"run-a"}`, "")

	// One person lands. The rest never do.
	var paidID string
	if err := p.QueryRow(context.Background(),
		`UPDATE payroll_run_items SET status = 'paid', tx_hash = '0xdead'
		  WHERE id = (SELECT id FROM payroll_run_items WHERE run_id = $1 AND status = 'pending' LIMIT 1)
		  RETURNING id`, run.ID).Scan(&paidID); err != nil {
		t.Fatalf("marking one item paid: %v", err)
	}

	stall(t, p, run.ID, 20*time.Minute)
	res := doJSON(t, srv.URL, "POST", "/v1/payroll_runs/"+run.ID+"/resume", key,
		`{"run_key":"run-b"}`, "")
	if res.status != http.StatusOK {
		t.Fatalf("resume: status=%d body=%s", res.status, res.body)
	}

	// The paid row must be in no leg. buildLegs filters on 'pending', which is
	// exactly why -- this asserts that filter is load-bearing rather than
	// incidental.
	var addr string
	_ = p.QueryRow(context.Background(),
		`SELECT address FROM payroll_run_items WHERE id = $1`, paidID).Scan(&addr)
	if addr != "" && strings.Contains(strings.ToLower(res.body), strings.ToLower(addr)) {
		t.Fatalf("resume rebuilt a leg containing somebody already paid (%s)", addr)
	}

	var stillPaid string
	_ = p.QueryRow(context.Background(),
		`SELECT status FROM payroll_run_items WHERE id = $1`, paidID).Scan(&stillPaid)
	if stillPaid != "paid" {
		t.Fatalf("a paid item became %q during resume", stillPaid)
	}
}

// Resume issues a new key; the original must stay burned. If it did not, a
// recovery would double as a way to replay the original request.
func TestPayrollTheOriginalRunKeyStaysUnusableAfterAResume(t *testing.T) {
	t.Setenv("CONDUIT_PAYROLL_ADDRESS", "0xcC4b99a2B74DA98695d4136FB7F20988621BeB11")
	srv, key, p := newLinkTestServer(t, 15623)
	hireThree(t, srv.URL, key)
	_, run := draftRun(t, srv.URL, key, `{}`)
	doJSON(t, srv.URL, "POST", "/v1/payroll_runs/"+run.ID+"/execute", key, `{"run_key":"run-a"}`, "")

	stall(t, p, run.ID, 20*time.Minute)
	res := doJSON(t, srv.URL, "POST", "/v1/payroll_runs/"+run.ID+"/resume", key, `{"run_key":"run-b"}`, "")
	if res.status != http.StatusOK {
		t.Fatalf("resume: status=%d body=%s", res.status, res.body)
	}

	// A fresh run, and the ORIGINAL key. Before Phase C2 the uniqueness lived
	// on payroll_runs.run_key, so overwriting it during resume handed the old
	// key back.
	_, second := draftRun(t, srv.URL, key, `{}`)
	dup := doJSON(t, srv.URL, "POST", "/v1/payroll_runs/"+second.ID+"/execute", key,
		`{"run_key":"run-a"}`, "")
	if dup.status != http.StatusConflict {
		t.Fatalf("the original key was accepted again after a resume: status=%d body=%s", dup.status, dup.body)
	}

	// And the resume's own key is burned too.
	_, third := draftRun(t, srv.URL, key, `{}`)
	dup2 := doJSON(t, srv.URL, "POST", "/v1/payroll_runs/"+third.ID+"/execute", key,
		`{"run_key":"run-b"}`, "")
	if dup2.status != http.StatusConflict {
		t.Fatalf("the resume key was accepted again: status=%d body=%s", dup2.status, dup2.body)
	}
}

// Only a stalled run. A draft is executed, and a finished one is finished.
func TestPayrollADraftCannotBeResumed(t *testing.T) {
	t.Setenv("CONDUIT_PAYROLL_ADDRESS", "0xcC4b99a2B74DA98695d4136FB7F20988621BeB11")
	srv, key, _ := newLinkTestServer(t, 15624)
	hireThree(t, srv.URL, key)
	_, run := draftRun(t, srv.URL, key, `{}`)

	res := doJSON(t, srv.URL, "POST", "/v1/payroll_runs/"+run.ID+"/resume", key, `{"run_key":"run-b"}`, "")
	if res.status == http.StatusOK {
		t.Fatal("resumed a draft; drafts are executed, not resumed")
	}
}

// ── Phase C3: paying a subset, and moving somebody's wallet ───────────────────

func TestPayrollCanPayASubsetByEmployeeID(t *testing.T) {
	t.Setenv("CONDUIT_PAYROLL_ADDRESS", "0xcC4b99a2B74DA98695d4136FB7F20988621BeB11")
	srv, key, _ := newLinkTestServer(t, 15630)
	hireThree(t, srv.URL, key)

	list := doJSON(t, srv.URL, "GET", "/v1/employees", key, "", "")
	var people struct {
		Data []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(list.body), &people); err != nil {
		t.Fatalf("listing employees: %v", err)
	}
	if len(people.Data) < 3 {
		t.Fatalf("expected three employees, got %d", len(people.Data))
	}

	// Just one of the three. Before this, paying a subset meant pausing the
	// others and remembering to unpause them.
	body := fmt.Sprintf(`{"employee_ids":[%q]}`, people.Data[0].ID)
	_, run := draftRun(t, srv.URL, key, body)
	if len(run.Items) != 1 {
		t.Fatalf("drafted %d items for a one-person run: %+v", len(run.Items), run.Items)
	}
}

// A payroll that quietly pays fewer people than it was asked to reports itself
// as a success, which is the worst way for this to go wrong.
func TestPayrollAnUnknownEmployeeIDIsRefusedNotIgnored(t *testing.T) {
	t.Setenv("CONDUIT_PAYROLL_ADDRESS", "0xcC4b99a2B74DA98695d4136FB7F20988621BeB11")
	srv, key, _ := newLinkTestServer(t, 15631)
	hireThree(t, srv.URL, key)

	res := doJSON(t, srv.URL, "POST", "/v1/payroll_runs", key,
		`{"employee_ids":["emp_does_not_exist"]}`, "")
	if res.status == http.StatusCreated || res.status == http.StatusOK {
		t.Fatalf("accepted an employee id that is not on this payroll: %s", res.body)
	}
}

func TestEmployeeAddressMovesOnlyWithConfirmation(t *testing.T) {
	srv, key, p := newLinkTestServer(t, 15632)
	hireThree(t, srv.URL, key)

	list := doJSON(t, srv.URL, "GET", "/v1/employees", key, "", "")
	var people struct {
		Data []struct {
			ID      string `json:"id"`
			Address string `json:"address"`
		} `json:"data"`
	}
	_ = json.Unmarshal([]byte(list.body), &people)
	id := people.Data[0].ID
	oldAddr := people.Data[0].Address
	newAddr := "0x1234567890AbcdEF1234567890aBcdef12345678"

	// Mismatched confirmation is the typo this exists to catch.
	bad := doJSON(t, srv.URL, "POST", "/v1/employees/"+id+"/reassign_address", key,
		fmt.Sprintf(`{"address":%q,"confirm_address":"0x000000000000000000000000000000000000dEaD"}`, newAddr), "")
	if bad.status == http.StatusOK {
		t.Fatal("moved an address without a matching confirmation")
	}

	var stillOld string
	_ = p.QueryRow(context.Background(), `SELECT address FROM employees WHERE id = $1`, id).Scan(&stillOld)
	if !strings.EqualFold(stillOld, oldAddr) {
		t.Fatalf("the address moved on a refused request: %s", stillOld)
	}

	// Confirmed, so it moves.
	ok := doJSON(t, srv.URL, "POST", "/v1/employees/"+id+"/reassign_address", key,
		fmt.Sprintf(`{"address":%q,"confirm_address":%q,"note":"new hardware wallet"}`, newAddr, newAddr), "")
	if ok.status != http.StatusOK {
		t.Fatalf("reassign: status=%d body=%s", ok.status, ok.body)
	}

	var moved string
	_ = p.QueryRow(context.Background(), `SELECT address FROM employees WHERE id = $1`, id).Scan(&moved)
	if !strings.EqualFold(moved, newAddr) {
		t.Fatalf("address is %s, want %s", moved, newAddr)
	}

	// And it is written down. This is the record that makes a past run's
	// snapshotted address reconcilable against where the person is paid now.
	var audits int
	_ = p.QueryRow(context.Background(),
		`SELECT count(*) FROM employee_address_changes WHERE employee_id = $1 AND lower(old_address) = lower($2) AND lower(new_address) = lower($3)`,
		id, oldAddr, newAddr).Scan(&audits)
	if audits != 1 {
		t.Fatalf("audit rows = %d, want exactly 1", audits)
	}
}

// A past run records where the money ACTUALLY went. Moving somebody's wallet
// must not rewrite history.
func TestMovingAnAddressDoesNotRewritePastRuns(t *testing.T) {
	t.Setenv("CONDUIT_PAYROLL_ADDRESS", "0xcC4b99a2B74DA98695d4136FB7F20988621BeB11")
	srv, key, p := newLinkTestServer(t, 15633)
	hireThree(t, srv.URL, key)
	_, run := draftRun(t, srv.URL, key, `{}`)

	var before string
	_ = p.QueryRow(context.Background(),
		`SELECT address FROM payroll_run_items WHERE run_id = $1 ORDER BY id LIMIT 1`, run.ID).Scan(&before)

	var empID string
	_ = p.QueryRow(context.Background(),
		`SELECT employee_id FROM payroll_run_items WHERE run_id = $1 AND address = $2`, run.ID, before).Scan(&empID)

	newAddr := "0x9876543210FedCBa9876543210fEDcBA98765432"
	res := doJSON(t, srv.URL, "POST", "/v1/employees/"+empID+"/reassign_address", key,
		fmt.Sprintf(`{"address":%q,"confirm_address":%q}`, newAddr, newAddr), "")
	if res.status != http.StatusOK {
		t.Fatalf("reassign: status=%d body=%s", res.status, res.body)
	}

	var after string
	_ = p.QueryRow(context.Background(),
		`SELECT address FROM payroll_run_items WHERE run_id = $1 AND employee_id = $2`, run.ID, empID).Scan(&after)
	if !strings.EqualFold(after, before) {
		t.Fatalf("a past run's recorded address changed from %s to %s", before, after)
	}
}
