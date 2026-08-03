package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kzn-labs/conduit/api/internal/db"
)

// newLinkTestServer boots a real embedded Postgres + in-process HTTP server
// and returns an sk_test_ key for a fresh account -- no StableFX calls are
// needed for any of these tests, since lifecycle/enforcement all happens
// before a quote is ever requested.
func newLinkTestServer(t *testing.T, port uint32) (*httptest.Server, string, *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	pool, cleanup, err := db.StartTestDB(ctx, port)
	if err != nil {
		t.Fatalf("StartTestDB: %v", err)
	}
	t.Cleanup(cleanup)

	handler := New(Config{Pool: pool, AppBaseURL: "https://app.conduit.xyz"})
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	resp := doJSON(t, srv.URL, "POST", "/v1/accounts", "",
		`{"name":"Link Test Co","settle_currency":"USD","settle_address":"0x0000000000000000000000000000000000000009"}`, "")
	if resp.status != http.StatusCreated {
		t.Fatalf("create account: status=%d body=%s", resp.status, resp.body)
	}
	var acct struct {
		APIKey struct {
			Key string `json:"key"`
		} `json:"api_key"`
	}
	if err := json.Unmarshal([]byte(resp.body), &acct); err != nil {
		t.Fatalf("unmarshal account: %v", err)
	}
	return srv, acct.APIKey.Key, pool
}

type linkErr struct {
	Error struct {
		Code string `json:"code"`
	} `json:"error"`
}

func errCode(t *testing.T, body string) string {
	t.Helper()
	var e linkErr
	if err := json.Unmarshal([]byte(body), &e); err != nil {
		t.Fatalf("unmarshal error body %q: %v", body, err)
	}
	return e.Error.Code
}

// TestLinkLifecycle: create -> public view flips active to viewed -> pay
// creates a real settlement_intent tied back to the link.
func TestLinkLifecycle(t *testing.T) {
	srv, key, pool := newLinkTestServer(t, 15501)

	createBody := `{"amount_mode":"fixed","amount":50000,"settle_currency":"USD","settle_address":"0x0000000000000000000000000000000000000009","description":"Invoice #1","merchant_reference":"INV-1"}`
	resp := doJSON(t, srv.URL, "POST", "/v1/payment_links", key, createBody, "")
	if resp.status != http.StatusCreated {
		t.Fatalf("create link: status=%d body=%s", resp.status, resp.body)
	}
	var link struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	json.Unmarshal([]byte(resp.body), &link)
	if link.Status != "active" {
		t.Fatalf("expected status=active on create, got %s", link.Status)
	}

	// First public view -> viewed
	resp = doJSON(t, srv.URL, "GET", "/v1/payment_links/"+link.ID+"/public", "", "", "")
	if resp.status != http.StatusOK {
		t.Fatalf("public get: status=%d body=%s", resp.status, resp.body)
	}
	var pub struct {
		Status string `json:"status"`
	}
	json.Unmarshal([]byte(resp.body), &pub)
	if pub.Status != "viewed" {
		t.Fatalf("expected status=viewed after first public view, got %s", pub.Status)
	}

	// Pay -> real settlement_intent created, tied back to the link
	resp = doJSON(t, srv.URL, "POST", "/v1/payment_links/"+link.ID+"/pay", "", `{"payer_reference":"PO-9"}`, "")
	if resp.status != http.StatusCreated {
		t.Fatalf("pay: status=%d body=%s", resp.status, resp.body)
	}
	var payResp struct {
		ID            string `json:"id"`
		PaymentLinkID string `json:"payment_link_id"`
		Amount        string `json:"amount"`
	}
	json.Unmarshal([]byte(resp.body), &payResp)
	if payResp.PaymentLinkID != link.ID {
		t.Errorf("expected payment_link_id=%s, got %s", link.ID, payResp.PaymentLinkID)
	}
	if payResp.Amount != "50000" {
		t.Errorf("expected amount=50000, got %s", payResp.Amount)
	}

	// Starting checkout does NOT mark the link paid — it only reaches 'viewed'.
	// The 'paid' transition happens when a real settlement lands (see
	// payment_links.go Pay() and the confirm handler / indexer), so a payment
	// that later fails on insufficient funds never leaves the link showing paid.
	resp = doJSON(t, srv.URL, "GET", "/v1/payment_links/"+link.ID, key, "", "")
	var got struct {
		Status string `json:"status"`
	}
	json.Unmarshal([]byte(resp.body), &got)
	if got.Status != "viewed" {
		t.Errorf("expected status=viewed after checkout starts (paid only on settlement), got %s", got.Status)
	}

	// Simulate the settlement landing (what the confirm handler / indexer do):
	// only now should the link read 'paid'.
	if _, err := pool.Exec(context.Background(),
		`UPDATE payment_links SET status = 'paid' WHERE id = $1`, link.ID); err != nil {
		t.Fatalf("simulate settlement: %v", err)
	}
	resp = doJSON(t, srv.URL, "GET", "/v1/payment_links/"+link.ID, key, "", "")
	json.Unmarshal([]byte(resp.body), &got)
	if got.Status != "paid" {
		t.Errorf("expected status=paid after settlement lands, got %s", got.Status)
	}
}

// TestSingleUse: once a single_use link has actually been PAID (a settlement
// landed), a further payment attempt must be rejected. Merely starting checkout
// no longer burns the link — that was the bug where a failed payment left the
// link unusable and falsely marked paid.
func TestSingleUse(t *testing.T) {
	srv, key, pool := newLinkTestServer(t, 15502)

	resp := doJSON(t, srv.URL, "POST", "/v1/payment_links", key,
		`{"amount_mode":"fixed","amount":10000,"settle_currency":"USD","settle_address":"0x0000000000000000000000000000000000000009","reuse_policy":"single_use"}`, "")
	var link struct {
		ID string `json:"id"`
	}
	json.Unmarshal([]byte(resp.body), &link)

	resp = doJSON(t, srv.URL, "POST", "/v1/payment_links/"+link.ID+"/pay", "", `{}`, "")
	if resp.status != http.StatusCreated {
		t.Fatalf("first pay should succeed: status=%d body=%s", resp.status, resp.body)
	}

	// Before settlement the link is still payable — a payer who abandoned or
	// whose payment failed must not have permanently burned it.
	resp = doJSON(t, srv.URL, "POST", "/v1/payment_links/"+link.ID+"/pay", "", `{}`, "")
	if resp.status != http.StatusCreated {
		t.Fatalf("retry before settlement should be allowed: status=%d body=%s", resp.status, resp.body)
	}

	// Now a settlement lands (confirm handler / indexer marks it paid).
	if _, err := pool.Exec(context.Background(),
		`UPDATE payment_links SET status = 'paid' WHERE id = $1`, link.ID); err != nil {
		t.Fatalf("simulate settlement: %v", err)
	}

	resp = doJSON(t, srv.URL, "POST", "/v1/payment_links/"+link.ID+"/pay", "", `{}`, "")
	if resp.status != http.StatusConflict {
		t.Fatalf("pay after a single_use link is paid: expected 409, got %d body=%s", resp.status, resp.body)
	}
	if code := errCode(t, resp.body); code != "payment_link_already_used" {
		t.Errorf("expected payment_link_already_used, got %s", code)
	}

	// A multi_use link must allow repeated payment.
	resp = doJSON(t, srv.URL, "POST", "/v1/payment_links", key,
		`{"amount_mode":"fixed","amount":5000,"settle_currency":"USD","settle_address":"0x0000000000000000000000000000000000000009","reuse_policy":"multi_use"}`, "")
	var multiLink struct {
		ID string `json:"id"`
	}
	json.Unmarshal([]byte(resp.body), &multiLink)

	for i := 0; i < 2; i++ {
		resp = doJSON(t, srv.URL, "POST", "/v1/payment_links/"+multiLink.ID+"/pay", "", `{}`, "")
		if resp.status != http.StatusCreated {
			t.Fatalf("multi_use pay #%d should succeed: status=%d body=%s", i+1, resp.status, resp.body)
		}
	}
}

// TestExpiry: a payment attempt against an expired link is rejected.
func TestExpiry(t *testing.T) {
	srv, key, pool := newLinkTestServer(t, 15503)

	// expires_in=1 second, then we wait past it via a direct DB backdate
	// instead of sleeping -- deterministic and instant.
	resp := doJSON(t, srv.URL, "POST", "/v1/payment_links", key,
		`{"amount_mode":"fixed","amount":10000,"settle_currency":"USD","settle_address":"0x0000000000000000000000000000000000000009","expires_in":3600}`, "")
	var link struct {
		ID string `json:"id"`
	}
	json.Unmarshal([]byte(resp.body), &link)

	_, err := pool.Exec(context.Background(), `UPDATE payment_links SET expires_at = now() - interval '1 hour' WHERE id = $1`, link.ID)
	if err != nil {
		t.Fatalf("backdate expiry: %v", err)
	}

	resp = doJSON(t, srv.URL, "POST", "/v1/payment_links/"+link.ID+"/pay", "", `{}`, "")
	if resp.status != http.StatusConflict {
		t.Fatalf("pay on expired link: expected 409, got %d body=%s", resp.status, resp.body)
	}
	if code := errCode(t, resp.body); code != "payment_link_expired" {
		t.Errorf("expected payment_link_expired, got %s", code)
	}
}

// TestVoid: a voided link cannot be paid; voiding a paid/settled link is
// rejected (immutable per spec).
func TestVoid(t *testing.T) {
	srv, key, pool := newLinkTestServer(t, 15504)

	resp := doJSON(t, srv.URL, "POST", "/v1/payment_links", key,
		`{"amount_mode":"fixed","amount":10000,"settle_currency":"USD","settle_address":"0x0000000000000000000000000000000000000009"}`, "")
	var link struct {
		ID string `json:"id"`
	}
	json.Unmarshal([]byte(resp.body), &link)

	resp = doJSON(t, srv.URL, "POST", "/v1/payment_links/"+link.ID+"/void", key, "", "")
	if resp.status != http.StatusOK {
		t.Fatalf("void: status=%d body=%s", resp.status, resp.body)
	}

	resp = doJSON(t, srv.URL, "POST", "/v1/payment_links/"+link.ID+"/pay", "", `{}`, "")
	if resp.status != http.StatusConflict {
		t.Fatalf("pay on void link: expected 409, got %d body=%s", resp.status, resp.body)
	}
	if code := errCode(t, resp.body); code != "payment_link_voided" {
		t.Errorf("expected payment_link_voided, got %s", code)
	}

	// A paid link cannot be voided (immutable).
	resp = doJSON(t, srv.URL, "POST", "/v1/payment_links", key,
		`{"amount_mode":"fixed","amount":10000,"settle_currency":"USD","settle_address":"0x0000000000000000000000000000000000000009"}`, "")
	var link2 struct {
		ID string `json:"id"`
	}
	json.Unmarshal([]byte(resp.body), &link2)
	resp = doJSON(t, srv.URL, "POST", "/v1/payment_links/"+link2.ID+"/pay", "", `{}`, "")
	if resp.status != http.StatusCreated {
		t.Fatalf("pay: status=%d body=%s", resp.status, resp.body)
	}
	// A link is immutable only once actually paid (a settlement landed) — not
	// merely because checkout was started. Simulate the settlement first.
	if _, err := pool.Exec(context.Background(),
		`UPDATE payment_links SET status = 'paid' WHERE id = $1`, link2.ID); err != nil {
		t.Fatalf("simulate settlement: %v", err)
	}
	resp = doJSON(t, srv.URL, "POST", "/v1/payment_links/"+link2.ID+"/void", key, "", "")
	if resp.status != http.StatusConflict {
		t.Fatalf("void on paid link: expected 409, got %d body=%s", resp.status, resp.body)
	}
}

// TestAmountBounds: open/open_with_suggested amounts outside [min,max] are
// rejected; in-bounds amounts succeed.
func TestAmountBounds(t *testing.T) {
	srv, key, _ := newLinkTestServer(t, 15505)

	resp := doJSON(t, srv.URL, "POST", "/v1/payment_links", key,
		`{"amount_mode":"open","min_amount":1000,"max_amount":100000,"settle_currency":"USD","settle_address":"0x0000000000000000000000000000000000000009"}`, "")
	if resp.status != http.StatusCreated {
		t.Fatalf("create open link: status=%d body=%s", resp.status, resp.body)
	}
	var link struct {
		ID string `json:"id"`
	}
	json.Unmarshal([]byte(resp.body), &link)

	// Below min
	resp = doJSON(t, srv.URL, "POST", "/v1/payment_links/"+link.ID+"/pay", "", `{"amount":500}`, "")
	if resp.status != http.StatusUnprocessableEntity {
		t.Fatalf("below-min pay: expected 422, got %d body=%s", resp.status, resp.body)
	}
	if code := errCode(t, resp.body); code != "payment_link_amount_out_of_bounds" {
		t.Errorf("expected payment_link_amount_out_of_bounds, got %s", code)
	}

	// Above max
	resp = doJSON(t, srv.URL, "POST", "/v1/payment_links/"+link.ID+"/pay", "", `{"amount":200000}`, "")
	if resp.status != http.StatusUnprocessableEntity {
		t.Fatalf("above-max pay: expected 422, got %d body=%s", resp.status, resp.body)
	}

	// In bounds -> succeeds
	resp = doJSON(t, srv.URL, "POST", "/v1/payment_links/"+link.ID+"/pay", "", `{"amount":5000}`, "")
	if resp.status != http.StatusCreated {
		t.Fatalf("in-bounds pay: expected 201, got %d body=%s", resp.status, resp.body)
	}

	// open with no amount at all is a required-field error, not a bounds error
	resp2 := doJSON(t, srv.URL, "POST", "/v1/payment_links", key,
		`{"amount_mode":"open","settle_currency":"USD","settle_address":"0x0000000000000000000000000000000000000009","reuse_policy":"multi_use"}`, "")
	var link2 struct {
		ID string `json:"id"`
	}
	json.Unmarshal([]byte(resp2.body), &link2)
	resp = doJSON(t, srv.URL, "POST", "/v1/payment_links/"+link2.ID+"/pay", "", `{}`, "")
	if resp.status != http.StatusBadRequest {
		t.Fatalf("open link paid with no amount: expected 400, got %d body=%s", resp.status, resp.body)
	}
	if code := errCode(t, resp.body); code != "payment_link_amount_required" {
		t.Errorf("expected payment_link_amount_required, got %s", code)
	}
}
