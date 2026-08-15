package auth

import (
	"net/http"
	"testing"
)

// A pk_ key is designed to be pasted into a public web page. Anyone who views
// source has it, so the set of routes it reaches is a security boundary rather
// than a convenience.
//
// The predicate this exercises previously compared only the HTTP method and
// never read the path prefix it stored alongside it, which collapsed it to "any
// GET or POST under /v1/settlement_intents/". That admitted the private intent
// view and the cancel route. Both cases are asserted here by name so a
// regression names itself.
func TestIsPkAllowed(t *testing.T) {
	const id = "si_01HZX0000000000000000000"

	cases := []struct {
		name   string
		method string
		path   string
		want   bool
	}{
		// The documented contract: drive an existing charge.
		{"quote", http.MethodPost, "/v1/settlement_intents/" + id + "/quote", true},
		{"prepare", http.MethodPost, "/v1/settlement_intents/" + id + "/prepare", true},
		{"confirm", http.MethodPost, "/v1/settlement_intents/" + id + "/confirm", true},
		{"record", http.MethodPost, "/v1/settlement_intents/" + id + "/record", true},

		// The two routes the old predicate wrongly admitted.
		{"cancel is denied", http.MethodPost, "/v1/settlement_intents/" + id + "/cancel", false},
		{"private intent view is denied", http.MethodGet, "/v1/settlement_intents/" + id, false},

		// The public view is not reached through here at all (it is registered
		// on the unauthenticated group), but a pk_ key must not be granted the
		// bare GET that would make the /public split pointless.
		{"public view still not via pk", http.MethodGet, "/v1/settlement_intents/" + id + "/public", false},

		// Creating and listing charges is the sk_ key's job.
		{"create is denied", http.MethodPost, "/v1/settlement_intents", false},
		{"list is denied", http.MethodGet, "/v1/settlement_intents", false},
		{"direct create is denied", http.MethodPost, "/v1/settlement_intents/direct", false},

		// Nested routes must not be admitted by an id/action shape check.
		{"bridge initiate is denied", http.MethodPost, "/v1/settlement_intents/" + id + "/bridge/initiate", false},
		{"bridge report_spend is denied", http.MethodPost, "/v1/settlement_intents/" + id + "/bridge/report_spend", false},

		// Nothing outside the intents tree, whatever the method.
		{"accounts is denied", http.MethodGet, "/v1/accounts/me", false},
		{"api keys is denied", http.MethodPost, "/v1/api_keys", false},
		{"patch account is denied", http.MethodPatch, "/v1/accounts/acct_1", false},

		// Malformed shapes fail closed.
		{"empty action", http.MethodPost, "/v1/settlement_intents/" + id + "/", false},
		{"empty id", http.MethodPost, "/v1/settlement_intents//quote", false},
		{"prefix only", http.MethodPost, "/v1/settlement_intents/", false},
		{"quote by GET", http.MethodGet, "/v1/settlement_intents/" + id + "/quote", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isPkAllowed(tc.method, tc.path); got != tc.want {
				t.Errorf("isPkAllowed(%q, %q) = %v, want %v", tc.method, tc.path, got, tc.want)
			}
		})
	}
}
