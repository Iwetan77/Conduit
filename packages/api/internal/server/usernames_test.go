package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
)

// Claiming a name, end to end against a real database.
//
// The rules that matter here cannot be tested without one, because they are
// enforced BY it: uniqueness lives in a partial unique index and "only once"
// lives in a WHERE clause. A unit test of the validator proves neither.

func claimUsername(t *testing.T, srvURL, key, name string) (int, string) {
	t.Helper()
	resp := doJSON(t, srvURL, "POST", "/v1/accounts/me/username", key,
		`{"username":"`+name+`"}`, "")
	return resp.status, resp.body
}

func TestUsernameClaimAndResolve(t *testing.T) {
	srv, key, _ := newLinkTestServer(t, 15521)

	if status, body := claimUsername(t, srv.URL, key, "Ivan"); status != http.StatusOK {
		t.Fatalf("claim: status=%d body=%s", status, body)
	}

	// Resolution is PUBLIC -- a payer typing a name has no key. Empty key
	// argument, deliberately.
	resp := doJSON(t, srv.URL, "GET", "/v1/usernames/Ivan", "", "", "")
	if resp.status != http.StatusOK {
		t.Fatalf("resolve: status=%d body=%s", resp.status, resp.body)
	}
	var res struct {
		Username      string `json:"username"`
		DisplayName   string `json:"display_name"`
		SettleAddress string `json:"settle_address"`
	}
	if err := json.Unmarshal([]byte(resp.body), &res); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	// Case is PRESERVED as claimed: someone who types "Ivan" is shown "Ivan".
	if res.Username != "Ivan" {
		t.Fatalf("username = %q, want the claimed casing %q", res.Username, "Ivan")
	}
	if res.SettleAddress == "" {
		t.Fatal("resolution carried no settle_address -- there is nowhere to send the money")
	}

	// ...but lookup is case-INSENSITIVE, or a name typed from memory misses.
	lower := doJSON(t, srv.URL, "GET", "/v1/usernames/ivan", "", "", "")
	if lower.status != http.StatusOK {
		t.Fatalf("lowercase lookup: status=%d body=%s", lower.status, lower.body)
	}

	// Resolution must not leak the account behind the name. A username is a
	// mailbox; knowing it must not reveal what is in it.
	for _, leaked := range []string{"acct_", "login_wallet", "auth_subject", "livemode"} {
		if strings.Contains(resp.body, leaked) {
			t.Fatalf("resolution exposed %q: %s", leaked, resp.body)
		}
	}
}

func TestUsernameIsClaimedOnlyOnce(t *testing.T) {
	srv, key, _ := newLinkTestServer(t, 15522)

	if status, body := claimUsername(t, srv.URL, key, "First"); status != http.StatusOK {
		t.Fatalf("first claim: status=%d body=%s", status, body)
	}
	// A second name for the same account is refused. A username is what other
	// people save and send to, so a silent reassignment would strand payments
	// addressed from memory.
	status, body := claimUsername(t, srv.URL, key, "Second")
	if status != http.StatusConflict {
		t.Fatalf("second claim: status=%d body=%s, want 409", status, body)
	}
	if !strings.Contains(body, "username_already_set") {
		t.Fatalf("second claim reported %s, want username_already_set", body)
	}

	// And the original still resolves — the failed second claim must not have
	// cleared or altered it.
	resp := doJSON(t, srv.URL, "GET", "/v1/usernames/First", "", "", "")
	if resp.status != http.StatusOK {
		t.Fatalf("original username stopped resolving: status=%d body=%s", resp.status, resp.body)
	}
}

func TestUsernameCannotBeTakenTwice(t *testing.T) {
	srv, keyA, pool := newLinkTestServer(t, 15523)

	// A second account, so two DIFFERENT accounts contend for one name.
	resp := doJSON(t, srv.URL, "POST", "/v1/accounts", "",
		`{"name":"Other Co","settle_currency":"USD","settle_address":"0x0000000000000000000000000000000000000009"}`, "")
	if resp.status != http.StatusCreated {
		t.Fatalf("create second account: status=%d body=%s", resp.status, resp.body)
	}
	var acct struct {
		APIKey struct {
			Key string `json:"key"`
		} `json:"api_key"`
	}
	if err := json.Unmarshal([]byte(resp.body), &acct); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	keyB := acct.APIKey.Key
	_ = pool

	if status, body := claimUsername(t, srv.URL, keyA, "shared"); status != http.StatusOK {
		t.Fatalf("first account's claim: status=%d body=%s", status, body)
	}
	// Different case, same name. Two names differing only in case are the same
	// name to a person reading a chat message, and that ambiguity costs a
	// misdirected payment.
	status, body := claimUsername(t, srv.URL, keyB, "SHARED")
	if status != http.StatusConflict {
		t.Fatalf("second account's claim: status=%d body=%s, want 409", status, body)
	}
	if !strings.Contains(body, "username_taken") {
		t.Fatalf("collision reported %s, want username_taken", body)
	}
}

// Two accounts claiming the same name in the same instant.
//
// A read-then-write would let both through: each SELECT sees the name free
// before either INSERT lands. The unique index is what actually decides it,
// which is why the claim relies on the constraint rather than on a prior check.
func TestConcurrentClaimsOfOneNameLeaveExactlyOneWinner(t *testing.T) {
	srv, keyA, _ := newLinkTestServer(t, 15524)

	resp := doJSON(t, srv.URL, "POST", "/v1/accounts", "",
		`{"name":"Racer Co","settle_currency":"USD","settle_address":"0x0000000000000000000000000000000000000009"}`, "")
	if resp.status != http.StatusCreated {
		t.Fatalf("create second account: status=%d body=%s", resp.status, resp.body)
	}
	var acct struct {
		APIKey struct {
			Key string `json:"key"`
		} `json:"api_key"`
	}
	if err := json.Unmarshal([]byte(resp.body), &acct); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	var wg sync.WaitGroup
	statuses := make([]int, 2)
	for i, k := range []string{keyA, acct.APIKey.Key} {
		wg.Add(1)
		go func(idx int, key string) {
			defer wg.Done()
			statuses[idx], _ = claimUsername(t, srv.URL, key, "contested")
		}(i, k)
	}
	wg.Wait()

	won := 0
	for _, s := range statuses {
		if s == http.StatusOK {
			won++
		}
	}
	if won != 1 {
		t.Fatalf("statuses=%v, want exactly one 200 -- a name may belong to one account only", statuses)
	}
}

func TestUsernameAvailabilityAnswersWithoutFailing(t *testing.T) {
	srv, key, _ := newLinkTestServer(t, 15525)

	// A taken or invalid name is a successful ANSWER, not an error. A 4xx here
	// would be read as a failure by every fetch wrapper between here and the
	// input box.
	for _, tc := range []struct {
		name      string
		path      string
		available bool
	}{
		{"a free name", "/v1/usernames/freename/available", true},
		{"too short", "/v1/usernames/ab/available", false},
		{"reserved", "/v1/usernames/admin/available", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp := doJSON(t, srv.URL, "GET", tc.path, "", "", "")
			if resp.status != http.StatusOK {
				t.Fatalf("status=%d body=%s, want 200", resp.status, resp.body)
			}
			var out struct {
				Available bool   `json:"available"`
				Reason    string `json:"reason"`
			}
			if err := json.Unmarshal([]byte(resp.body), &out); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if out.Available != tc.available {
				t.Fatalf("available=%v, want %v (body %s)", out.Available, tc.available, resp.body)
			}
			if !tc.available && out.Reason == "" {
				t.Fatal("refused without saying why")
			}
		})
	}

	// Once claimed, it stops being available.
	if status, body := claimUsername(t, srv.URL, key, "freename"); status != http.StatusOK {
		t.Fatalf("claim: status=%d body=%s", status, body)
	}
	resp := doJSON(t, srv.URL, "GET", "/v1/usernames/freename/available", "", "", "")
	if !strings.Contains(resp.body, `"available":false`) {
		t.Fatalf("claimed name still reported available: %s", resp.body)
	}
}

func TestUnknownUsernameIsNotFound(t *testing.T) {
	srv, _, _ := newLinkTestServer(t, 15526)
	resp := doJSON(t, srv.URL, "GET", "/v1/usernames/nobodyhasthis", "", "", "")
	if resp.status != http.StatusNotFound {
		t.Fatalf("status=%d body=%s, want 404", resp.status, resp.body)
	}
}

// A username is typed from memory into a send box and read off receipts. The
// characters people drop, double or mistype are the ones that turn a payment
// into one addressed to nobody -- or, once somebody registers the lookalike, to
// the wrong person.
func TestUsernameCharactersAreLettersAndDigitsOnly(t *testing.T) {
	srv, key, _ := newLinkTestServer(t, 15561)

	refused := []struct{ name, why string }{
		{"iv_an", "underscore: the character most reliably mistyped as a hyphen or dropped"},
		{"_ivan", "leading underscore"},
		{"ivan_", "trailing underscore"},
		{"iv-an", "hyphen"},
		{"iv.an", "a dot reads as a domain and splits differently in every client"},
		{"iv an", "a space cannot survive being read aloud or pasted"},
		{"123456", "all digits: indistinguishable from an id or an amount beside one"},
		{"1van", "leading digit, same reason"},
		{"iv", "too short"},
		{"ivanivanivanivanivani", "21 characters, too long"},
	}
	for _, c := range refused {
		body, _ := json.Marshal(map[string]string{"username": c.name})
		resp := doJSON(t, srv.URL, "POST", "/v1/accounts/me/username", key, string(body), "")
		if resp.status == http.StatusOK {
			t.Errorf("accepted %q (%s)", c.name, c.why)
		}
	}

	// And the shape that IS allowed still works.
	body, _ := json.Marshal(map[string]string{"username": "Ivan2"})
	resp := doJSON(t, srv.URL, "POST", "/v1/accounts/me/username", key, string(body), "")
	if resp.status != http.StatusOK {
		t.Fatalf("refused a valid name: status=%d body=%s", resp.status, resp.body)
	}
}

// The database refuses it too, not only the handler.
//
// Validation in Go is where a rejection can explain itself, but it is one code
// path; the constraint holds for anything that reaches the table by any route.
func TestUsernameShapeIsEnforcedByTheDatabase(t *testing.T) {
	srv, _, pool := newLinkTestServer(t, 15562)
	_ = srv
	var id string
	if err := pool.QueryRow(context.Background(),
		`SELECT id FROM accounts LIMIT 1`).Scan(&id); err != nil {
		t.Fatalf("read account: %v", err)
	}
	if _, err := pool.Exec(context.Background(),
		`UPDATE accounts SET username = 'iv_an' WHERE id = $1`, id,
	); err == nil {
		t.Fatal("the database accepted an underscore username written directly")
	}
}

// A merchant's own name belongs to the merchant, not to their company.
//
// This is the case provisioned settlement wallets created. While a business
// settled to the wallet its owner signed in with, a name on either row resolved
// to the same address and nothing distinguished them. Now they are different
// addresses, and claiming "ivan" from the dashboard used to mean "pay my
// company" -- the person's own handle pointing at the business's money.
//
// The assertion that matters is the last one: @ivan resolves to IVAN'S address,
// and the business's settlement address is not it.
func TestMerchantsNameBindsToThePersonNotTheBusiness(t *testing.T) {
	srv, pool := newSettlementTestServer(t, 15541, "")
	ctx := context.Background()

	const owner = "0x00000000000000000000000000000000000000a1"
	const businessAddr = "0x00000000000000000000000000000000000000b2"
	session := seedMerchant(t, pool, "acct_biz", owner, "")

	// Give the business an address of its own, which is what makes the two
	// distinguishable at all. Written directly: provisioning goes through
	// Circle, and this test is about the username, not about that.
	if _, err := pool.Exec(ctx,
		`UPDATE accounts
		    SET settle_address = $2, provisioned_address = $2,
		        settle_wallet_id = 'wal_test', settle_address_source = 'provisioned'
		  WHERE id = $1`,
		"acct_biz", businessAddr,
	); err != nil {
		t.Fatalf("give the business its own address: %v", err)
	}

	if resp := doJSON(t, srv.URL, "POST", "/v1/accounts/me/username", session,
		`{"username":"Ivan"}`, ""); resp.status != http.StatusOK {
		t.Fatalf("claim: status=%d body=%s", resp.status, resp.body)
	}

	// The business row must not be holding it.
	var businessName *string
	if err := pool.QueryRow(ctx,
		`SELECT username FROM accounts WHERE id = 'acct_biz'`).Scan(&businessName); err != nil {
		t.Fatalf("read business: %v", err)
	}
	if businessName != nil {
		t.Fatalf("the name landed on the business account (%q) -- paying @Ivan would pay the company", *businessName)
	}

	// The owner's personal account is holding it, and it settles to the owner's
	// own wallet.
	var personalAddr string
	if err := pool.QueryRow(ctx,
		`SELECT settle_address FROM accounts
		  WHERE lower(username) = 'ivan'
		    AND privy_user_id IS NULL AND auth_subject IS NULL`,
	).Scan(&personalAddr); err != nil {
		t.Fatalf("no personal account holds the name: %v", err)
	}
	if !strings.EqualFold(personalAddr, owner) {
		t.Fatalf("personal account settles to %s, want the owner's wallet %s", personalAddr, owner)
	}

	// And that is what a payer typing the name is told to pay.
	resp := doJSON(t, srv.URL, "GET", "/v1/usernames/Ivan", "", "", "")
	if resp.status != http.StatusOK {
		t.Fatalf("resolve: status=%d body=%s", resp.status, resp.body)
	}
	var res struct {
		SettleAddress string `json:"settle_address"`
	}
	if err := json.Unmarshal([]byte(resp.body), &res); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if strings.EqualFold(res.SettleAddress, businessAddr) {
		t.Fatal("@Ivan resolves to the BUSINESS address -- a personal handle paying the company")
	}
	if !strings.EqualFold(res.SettleAddress, owner) {
		t.Fatalf("@Ivan resolves to %s, want the person's own address %s", res.SettleAddress, owner)
	}
}
