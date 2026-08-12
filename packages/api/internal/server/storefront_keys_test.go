package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// TestStorefrontAPIKey: a storefront's own credential can be minted, actually
// works, is scoped to that storefront, and can be revoked.
//
// This is what makes the point-of-sale case possible. A restaurant's till mints
// a fixed-amount link per bill and prints it as a QR on the receipt; to do that
// it needs a key that belongs to the storefront, so the takings land on that
// storefront's books rather than the parent's. CreateSub returns such a key
// once, so without a way to mint another, a missed response left the storefront
// with a live but permanently unreachable credential.
func TestStorefrontAPIKey(t *testing.T) {
	srv, parentKey, _ := newLinkTestServer(t, 15509)

	resp := doJSON(t, srv.URL, "POST", "/v1/accounts/sub", parentKey,
		`{"name":"Kitchen till","settle_currency":"EUR","settle_address":"0x00000000000000000000000000000000000000CC"}`, "")
	if resp.status != http.StatusCreated {
		t.Fatalf("create storefront: status=%d body=%s", resp.status, resp.body)
	}
	var sub struct {
		ID string `json:"id"`
	}
	json.Unmarshal([]byte(resp.body), &sub)

	// Mint a fresh key for the storefront, as the dashboard's "create key" does.
	resp = doJSON(t, srv.URL, "POST", "/v1/accounts/"+sub.ID+"/api_keys", parentKey, ``, "")
	if resp.status != http.StatusCreated {
		t.Fatalf("mint storefront key: status=%d body=%s", resp.status, resp.body)
	}
	var minted struct {
		ID  string `json:"id"`
		Key string `json:"key"`
	}
	json.Unmarshal([]byte(resp.body), &minted)
	if !strings.HasPrefix(minted.Key, "sk_") {
		t.Fatalf("expected an sk_ secret, got %q", minted.Key)
	}

	// The POS flow: one fixed-amount link per bill, printed as a QR.
	resp = doJSON(t, srv.URL, "POST", "/v1/payment_links", minted.Key,
		`{"amount_mode":"fixed","amount":11099,"settle_currency":"EUR","settle_address":"0x00000000000000000000000000000000000000CC","reuse_policy":"single_use"}`, "")
	if resp.status != http.StatusCreated {
		t.Fatalf("create bill link with storefront key: status=%d body=%s", resp.status, resp.body)
	}
	var bill struct {
		ID        string `json:"id"`
		HostedURL string `json:"hosted_url"`
	}
	json.Unmarshal([]byte(resp.body), &bill)
	if !strings.HasSuffix(bill.HostedURL, "/pay/"+bill.ID) {
		t.Errorf("hosted_url = %q, want the printable /pay/<id> URL", bill.HostedURL)
	}

	// Attribution is the whole point: the bill must sit on the storefront's
	// books, not the parent's. The storefront's key sees it...
	resp = doJSON(t, srv.URL, "GET", "/v1/payment_links", minted.Key, ``, "")
	if !strings.Contains(resp.body, bill.ID) {
		t.Errorf("storefront should own the bill link; body=%s", resp.body)
	}
	// ...and the parent's key does not.
	resp = doJSON(t, srv.URL, "GET", "/v1/payment_links", parentKey, ``, "")
	if strings.Contains(resp.body, bill.ID) {
		t.Errorf("bill link leaked onto the parent account; body=%s", resp.body)
	}

	// Rotation half two: revoke, and the key stops working immediately.
	resp = doJSON(t, srv.URL, "POST", "/v1/api_keys/"+minted.ID+"/revoke", parentKey, ``, "")
	if resp.status != http.StatusOK {
		t.Fatalf("revoke: status=%d body=%s", resp.status, resp.body)
	}
	resp = doJSON(t, srv.URL, "GET", "/v1/payment_links", minted.Key, ``, "")
	if resp.status != http.StatusUnauthorized {
		t.Errorf("revoked key should be rejected, got %d body=%s", resp.status, resp.body)
	}
	// Idempotent: revoking twice is a no-op success, not an error.
	resp = doJSON(t, srv.URL, "POST", "/v1/api_keys/"+minted.ID+"/revoke", parentKey, ``, "")
	if resp.status != http.StatusOK {
		t.Errorf("second revoke should be idempotent, got %d", resp.status)
	}
}

// TestStorefrontAPIKeyTenancy: one merchant cannot mint a credential against
// another merchant's account.
func TestStorefrontAPIKeyTenancy(t *testing.T) {
	srv, key, _ := newLinkTestServer(t, 15510)

	resp := doJSON(t, srv.URL, "POST", "/v1/accounts", "",
		`{"name":"Other Co","settle_currency":"USD","settle_address":"0x00000000000000000000000000000000000000DD"}`, "")
	var other struct {
		ID string `json:"id"`
	}
	json.Unmarshal([]byte(resp.body), &other)

	resp = doJSON(t, srv.URL, "POST", "/v1/accounts/"+other.ID+"/api_keys", key, ``, "")
	if resp.status != http.StatusNotFound {
		t.Fatalf("cross-tenant key mint: expected 404, got %d body=%s", resp.status, resp.body)
	}
}
