package server

import (
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
		`{"name":"Other Co","settle_currency":"USD","settle_address":"0x0000000000000000000000000000000000000008"}`, "")
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
		`{"name":"Racer Co","settle_currency":"USD","settle_address":"0x0000000000000000000000000000000000000007"}`, "")
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
