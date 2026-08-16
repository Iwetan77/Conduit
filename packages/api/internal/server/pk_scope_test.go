package server

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/kzn-labs/conduit/api/internal/auth"
)

// TestPkKeyCannotReachPrivateIntentRoutes exercises the pk_ scope through the
// real router and the real middleware, not just the predicate.
//
// A pk_ key is meant to be pasted into a public checkout page, so anyone who
// views source holds it. The scope check is therefore the only thing standing
// between a published key and the merchant's own data. It previously compared
// the HTTP method alone, which admitted every GET and POST under
// /v1/settlement_intents/ -- including the private intent view (settle_address,
// reference, metadata) and cancel.
//
// Note the key is inserted directly: no handler in this API mints a pk_ key
// today (every GenerateKey call site passes KeyTypeSecret), even though the
// gateway docs describe pk_ as a product surface. The scope has to hold for
// whenever that gap is closed.
func TestPkKeyCannotReachPrivateIntentRoutes(t *testing.T) {
	srv, secretKey, pool := newLinkTestServer(t, 15515)
	ctx := context.Background()

	// The account the test server minted its sk_ key against.
	var accountID string
	if err := pool.QueryRow(ctx, `SELECT account_id FROM api_keys LIMIT 1`).Scan(&accountID); err != nil {
		t.Fatalf("read account: %v", err)
	}

	pkKey, prefix, suffix, hash, err := auth.GenerateKey(auth.KeyTypePublishable, false)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO api_keys (id, account_id, key_hash, prefix, suffix, type, livemode)
		 VALUES ($1, $2, $3, $4, $5, 'pk', false)`,
		"key_pkscopetest", accountID, hash, prefix, suffix,
	); err != nil {
		t.Fatalf("insert pk key: %v", err)
	}

	// A real intent to aim at, created the way a merchant's server would.
	resp := doJSON(t, srv.URL, "POST", "/v1/settlement_intents", secretKey,
		`{"amount":7000000,"settle_currency":"USD","settle_address":"0x0000000000000000000000000000000000000009","reference":"order_1481"}`, "")
	if resp.status != http.StatusCreated {
		t.Fatalf("create intent: status=%d body=%s", resp.status, resp.body)
	}
	var intent struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal([]byte(resp.body), &intent); err != nil {
		t.Fatalf("unmarshal intent: %v", err)
	}

	// The private view leaks settle_address, reference and metadata. The
	// /public variant exists to withhold exactly those, so a pk_ key reaching
	// this route makes that split meaningless.
	resp = doJSON(t, srv.URL, "GET", "/v1/settlement_intents/"+intent.ID, pkKey, "", "")
	if resp.status != http.StatusForbidden {
		t.Errorf("pk GET private intent: status=%d, want 403; body=%s", resp.status, resp.body)
	}

	// Cancelling a stranger's checkouts from a key printed in their own page.
	resp = doJSON(t, srv.URL, "POST", "/v1/settlement_intents/"+intent.ID+"/cancel", pkKey, "", "")
	if resp.status != http.StatusForbidden {
		t.Errorf("pk POST cancel: status=%d, want 403; body=%s", resp.status, resp.body)
	}

	// Creating a charge is the sk_ key's job -- it is what fixes the amount
	// server-side so the browser cannot tamper with it.
	resp = doJSON(t, srv.URL, "POST", "/v1/settlement_intents", pkKey,
		`{"amount":1,"settle_currency":"USD","settle_address":"0x0000000000000000000000000000000000000009"}`, "")
	if resp.status != http.StatusForbidden {
		t.Errorf("pk POST create intent: status=%d, want 403; body=%s", resp.status, resp.body)
	}

	// Nothing outside the intents tree at all.
	resp = doJSON(t, srv.URL, "GET", "/v1/accounts/me", pkKey, "", "")
	if resp.status != http.StatusForbidden {
		t.Errorf("pk GET accounts/me: status=%d, want 403; body=%s", resp.status, resp.body)
	}

	// The sk_ key must still reach every one of those, or the fix has simply
	// broken the merchant's own credential instead of scoping the public one.
	resp = doJSON(t, srv.URL, "GET", "/v1/settlement_intents/"+intent.ID, secretKey, "", "")
	if resp.status != http.StatusOK {
		t.Errorf("sk GET private intent: status=%d, want 200; body=%s", resp.status, resp.body)
	}
	resp = doJSON(t, srv.URL, "GET", "/v1/accounts/me", secretKey, "", "")
	if resp.status != http.StatusOK {
		t.Errorf("sk GET accounts/me: status=%d, want 200; body=%s", resp.status, resp.body)
	}
	resp = doJSON(t, srv.URL, "POST", "/v1/settlement_intents/"+intent.ID+"/cancel", secretKey, "", "")
	if resp.status != http.StatusOK {
		t.Errorf("sk POST cancel: status=%d, want 200; body=%s", resp.status, resp.body)
	}
}
