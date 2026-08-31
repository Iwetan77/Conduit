package server

// The people a business pays.
//
// The properties worth holding down are the ones that cost somebody their
// salary: a payroll line that cannot be built, a line carrying an amount nobody
// meant to pay, a person paid twice because they are on the list twice, a
// person whose record vanished along with the history of what they were owed,
// and one business reading another's staff list.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
)

type employee struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Address     string  `json:"address"`
	Username    *string `json:"username"`
	PayCurrency string  `json:"pay_currency"`
	PayType     string  `json:"pay_type"`
	Amount      *string `json:"amount"`
	Status      string  `json:"status"`
}

func addEmployee(t *testing.T, srvURL, key, body string) (jsonResp, employee) {
	t.Helper()
	resp := doJSON(t, srvURL, "POST", "/v1/employees", key, body, "")
	var e employee
	_ = json.Unmarshal([]byte(resp.body), &e)
	return resp, e
}

func listEmployees(t *testing.T, srvURL, key, query string) []employee {
	t.Helper()
	resp := doJSON(t, srvURL, "GET", "/v1/employees"+query, key, "", "")
	if resp.status != http.StatusOK {
		t.Fatalf("list: status=%d body=%s", resp.status, resp.body)
	}
	var out struct {
		Data []employee `json:"data"`
	}
	_ = json.Unmarshal([]byte(resp.body), &out)
	return out.Data
}

// A fixed employee is one whose amount is known in advance. Without it there is
// no payroll line to build, and finding that out at run time means finding it
// out with everybody else's payment already in flight.
func TestAFixedEmployeeWithoutAnAmountIsRejected(t *testing.T) {
	srv, key, _ := newLinkTestServer(t, 15601)
	_, addr := newSigner(t)

	resp, _ := addEmployee(t, srv.URL, key, fmt.Sprintf(
		`{"name":"Ada","address":%q,"pay_currency":"USD","pay_type":"fixed"}`, addr))
	if resp.status != http.StatusBadRequest {
		t.Fatalf("status=%d, want 400; body=%s", resp.status, resp.body)
	}
}

// And the reverse. An amount stored against somebody paid a different sum every
// month is a number that will eventually be paid by accident -- so it is
// refused rather than quietly dropped, which would hide that the caller
// believed otherwise.
func TestAVariableEmployeeWithAnAmountIsRejected(t *testing.T) {
	srv, key, _ := newLinkTestServer(t, 15602)
	_, addr := newSigner(t)

	resp, _ := addEmployee(t, srv.URL, key, fmt.Sprintf(
		`{"name":"Grace","address":%q,"pay_currency":"USD","pay_type":"variable","amount":"5000000"}`, addr))
	if resp.status != http.StatusBadRequest {
		t.Fatalf("status=%d, want 400; body=%s", resp.status, resp.body)
	}
}

// Adding by name is the primary path, and the name is resolved ONCE. Names are
// for reading and addresses are for paying: resolving at pay time would send a
// salary to whoever holds the name by then.
func TestEmployeeAddedByUsernameResolvesAndStoresTheAddress(t *testing.T) {
	srv, key, pool := newLinkTestServer(t, 15603)
	ctx := context.Background()

	// A second account with a name, which is who we are hiring.
	resp := doJSON(t, srv.URL, "POST", "/v1/accounts", "",
		`{"name":"Payee Co","settle_currency":"USD","settle_address":"0x00000000000000000000000000000000000000e5"}`, "")
	var payee struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal([]byte(resp.body), &payee)
	if _, err := pool.Exec(ctx,
		`UPDATE accounts SET username = 'Ada' WHERE id = $1`, payee.ID); err != nil {
		t.Fatalf("claim username: %v", err)
	}

	created, e := addEmployee(t, srv.URL, key,
		`{"name":"Ada Lovelace","username":"@Ada","pay_currency":"USD","pay_type":"fixed","amount":"5000000"}`)
	if created.status != http.StatusCreated {
		t.Fatalf("status=%d body=%s", created.status, created.body)
	}
	if !equalFold(e.Address, "0x00000000000000000000000000000000000000e5") {
		t.Fatalf("address = %s, want the account's settle address", e.Address)
	}
	// Kept for display. A hex string on a payroll confirmation screen is how a
	// wrong line goes unnoticed.
	if e.Username == nil || *e.Username != "Ada" {
		t.Fatalf("username = %v, want it stored for display", e.Username)
	}

	// A name nobody holds is a 404, not an employee paid to nowhere.
	missing, _ := addEmployee(t, srv.URL, key,
		`{"name":"Nobody","username":"@nobodyhasthis","pay_currency":"USD","pay_type":"variable"}`)
	if missing.status != http.StatusNotFound {
		t.Fatalf("unknown username: status=%d, want 404; body=%s", missing.status, missing.body)
	}
}

// One row per person. Two rows for one address is how somebody is paid twice in
// a single run.
func TestOnePersonCannotBeOnThePayrollTwice(t *testing.T) {
	srv, key, _ := newLinkTestServer(t, 15604)
	_, addr := newSigner(t)
	body := fmt.Sprintf(
		`{"name":"Ada","address":%q,"pay_currency":"USD","pay_type":"fixed","amount":"5000000"}`, addr)

	if resp, _ := addEmployee(t, srv.URL, key, body); resp.status != http.StatusCreated {
		t.Fatalf("first add: status=%d", resp.status)
	}
	dup, _ := addEmployee(t, srv.URL, key, body)
	if dup.status != http.StatusConflict {
		t.Fatalf("second add: status=%d, want 409; body=%s", dup.status, dup.body)
	}
}

// Leaving is an ordinary event and must not corrupt the record of what somebody
// was owed while they were there. So archiving hides them from the list without
// removing the row, and it is reversible.
func TestArchivingAnEmployeeKeepsTheRecordAndIsReversible(t *testing.T) {
	srv, key, pool := newLinkTestServer(t, 15605)
	_, addr := newSigner(t)
	_, e := addEmployee(t, srv.URL, key, fmt.Sprintf(
		`{"name":"Ada","address":%q,"pay_currency":"USD","pay_type":"fixed","amount":"5000000"}`, addr))

	if resp := doJSON(t, srv.URL, "POST", "/v1/employees/"+e.ID+"/archive", key, "", ""); resp.status != http.StatusOK {
		t.Fatalf("archive: status=%d body=%s", resp.status, resp.body)
	}

	if got := listEmployees(t, srv.URL, key, ""); len(got) != 0 {
		t.Fatalf("archived employee still on the working list: %+v", got)
	}
	// The ROW is still there. A deleted one would break the history of every
	// run that paid them.
	var count int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM employees WHERE id = $1`, e.ID).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Fatal("archiving deleted the row; the history of every run that paid them goes with it")
	}
	if got := listEmployees(t, srv.URL, key, "?include_archived=true"); len(got) != 1 {
		t.Fatalf("archived employee is not retrievable at all: %+v", got)
	}

	// Reversible: somebody comes back.
	back := doJSON(t, srv.URL, "PATCH", "/v1/employees/"+e.ID, key, `{"status":"active"}`, "")
	if back.status != http.StatusOK {
		t.Fatalf("un-archive: status=%d body=%s", back.status, back.body)
	}
	if got := listEmployees(t, srv.URL, key, ""); len(got) != 1 || got[0].Status != "active" {
		t.Fatalf("did not come back: %+v", got)
	}
}

// Pausing excludes somebody from the next run without losing anything -- a
// contractor between engagements, not a leaver.
func TestPausingKeepsTheEmployeeOnTheList(t *testing.T) {
	srv, key, _ := newLinkTestServer(t, 15606)
	_, addr := newSigner(t)
	_, e := addEmployee(t, srv.URL, key, fmt.Sprintf(
		`{"name":"Ada","address":%q,"pay_currency":"USD","pay_type":"variable"}`, addr))

	if resp := doJSON(t, srv.URL, "PATCH", "/v1/employees/"+e.ID, key, `{"status":"paused"}`, ""); resp.status != http.StatusOK {
		t.Fatalf("pause: status=%d body=%s", resp.status, resp.body)
	}
	got := listEmployees(t, srv.URL, key, "")
	if len(got) != 1 || got[0].Status != "paused" {
		t.Fatalf("a paused employee should still be on the list: %+v", got)
	}
}

// Switching somebody between pay types is validated against the type the row
// will END UP with. Otherwise a variable employee becomes fixed with no amount,
// which is a line the run cannot build.
func TestChangingAnEmployeePayTypeIsValidatedAgainstTheNewType(t *testing.T) {
	srv, key, _ := newLinkTestServer(t, 15607)
	_, addr := newSigner(t)
	_, e := addEmployee(t, srv.URL, key, fmt.Sprintf(
		`{"name":"Ada","address":%q,"pay_currency":"USD","pay_type":"variable"}`, addr))

	bad := doJSON(t, srv.URL, "PATCH", "/v1/employees/"+e.ID, key, `{"pay_type":"fixed"}`, "")
	if bad.status != http.StatusBadRequest {
		t.Fatalf("variable -> fixed with no amount: status=%d, want 400; body=%s", bad.status, bad.body)
	}
	good := doJSON(t, srv.URL, "PATCH", "/v1/employees/"+e.ID, key,
		`{"pay_type":"fixed","amount":"7000000"}`, "")
	if good.status != http.StatusOK {
		t.Fatalf("variable -> fixed with an amount: status=%d body=%s", good.status, good.body)
	}
}

// One business's staff list is not another's to read or change.
func TestEmployeesAreScopedToTheirAccount(t *testing.T) {
	srv, keyA, _ := newLinkTestServer(t, 15608)
	_, addr := newSigner(t)
	_, e := addEmployee(t, srv.URL, keyA, fmt.Sprintf(
		`{"name":"Ada","address":%q,"pay_currency":"USD","pay_type":"fixed","amount":"5000000"}`, addr))

	resp := doJSON(t, srv.URL, "POST", "/v1/accounts", "",
		`{"name":"Other Co","settle_currency":"USD","settle_address":"0x00000000000000000000000000000000000000e6"}`, "")
	var other struct {
		APIKey struct {
			Key string `json:"key"`
		} `json:"api_key"`
	}
	_ = json.Unmarshal([]byte(resp.body), &other)

	if got := listEmployees(t, srv.URL, other.APIKey.Key, ""); len(got) != 0 {
		t.Errorf("another account can read the staff list: %+v", got)
	}
	if got := doJSON(t, srv.URL, "PATCH", "/v1/employees/"+e.ID, other.APIKey.Key, `{"name":"Hijacked"}`, ""); got.status != http.StatusNotFound {
		t.Errorf("another account could edit them: status=%d", got.status)
	}
	if got := doJSON(t, srv.URL, "POST", "/v1/employees/"+e.ID+"/archive", other.APIKey.Key, "", ""); got.status != http.StatusNotFound {
		t.Errorf("another account could archive them: status=%d", got.status)
	}
}
