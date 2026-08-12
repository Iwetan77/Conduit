package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/kzn-labs/conduit/api/internal/links"
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

// TestSettledWebhookPayloadIdentifiesTheBill: settlement.succeeded must be
// mappable back to the bill that was printed.
//
// The payload used to carry only intent_id, and a till has never seen that id:
// it creates a payment link when the bill prints, and the intent is minted
// later, when the diner opens checkout. So a webhook could not be matched to a
// table without a second API call, which made polling the only workable
// integration. payment_link_id and merchant_reference close that; amount and
// settle_currency let the till assert the money that arrived is the money it
// asked for, rather than assuming it.
func TestSettledWebhookPayloadIdentifiesTheBill(t *testing.T) {
	srv, key, pool := newLinkTestServer(t, 15511)
	ctx := context.Background()

	resp := doJSON(t, srv.URL, "POST", "/v1/payment_links", key,
		`{"amount_mode":"fixed","amount":11099,"settle_currency":"EUR","settle_address":"0x00000000000000000000000000000000000000EE","reuse_policy":"single_use","merchant_reference":"table-14/bill-8871"}`, "")
	if resp.status != http.StatusCreated {
		t.Fatalf("create bill link: status=%d body=%s", resp.status, resp.body)
	}
	var link struct {
		ID string `json:"id"`
	}
	json.Unmarshal([]byte(resp.body), &link)

	resp = doJSON(t, srv.URL, "POST", "/v1/payment_links/"+link.ID+"/pay", "",
		`{"payer_reference":"diner-ref-1"}`, "")
	if resp.status != http.StatusCreated {
		t.Fatalf("pay: status=%d body=%s", resp.status, resp.body)
	}
	var intent struct {
		ID string `json:"id"`
	}
	json.Unmarshal([]byte(resp.body), &intent)

	// The exact payload every settlement path now sends.
	payload := links.SettledPayload(ctx, pool, intent.ID, "0xdeadbeef")

	if payload["payment_link_id"] != link.ID {
		t.Errorf("payment_link_id = %v, want %s", payload["payment_link_id"], link.ID)
	}
	if payload["merchant_reference"] != "table-14/bill-8871" {
		t.Errorf("merchant_reference = %v, want the bill number", payload["merchant_reference"])
	}
	if payload["payer_reference"] != "diner-ref-1" {
		t.Errorf("payer_reference = %v", payload["payer_reference"])
	}
	if payload["amount"] != "11099" {
		t.Errorf("amount = %v, want the bill total in minor units", payload["amount"])
	}
	if payload["settle_currency"] != "EUR" {
		t.Errorf("settle_currency = %v", payload["settle_currency"])
	}
	// Core fields must survive alongside the new ones.
	if payload["intent_id"] != intent.ID || payload["status"] != "settled" || payload["tx_hash"] != "0xdeadbeef" {
		t.Errorf("core fields altered: %#v", payload)
	}

	// A settlement with no link behind it (a direct send) must still produce a
	// valid payload rather than failing enrichment.
	bare := links.SettledPayload(ctx, pool, "si_does_not_exist", "0xabc")
	if bare["intent_id"] != "si_does_not_exist" || bare["status"] != "settled" {
		t.Errorf("unenrichable payload lost its core fields: %#v", bare)
	}
	if _, ok := bare["payment_link_id"]; ok {
		t.Error("payment_link_id should be absent, not empty, when there is no link")
	}
}

// TestLinkGetIncludesSettlements: polling a link tells a till not just THAT it
// was paid but WHAT was received, in one call.
//
// Without this, `status: "paid"` was the whole answer, and verifying the amount
// billed against the amount received — the check that actually protects a
// restaurant — needed a second request the till had no obvious way to make.
func TestLinkGetIncludesSettlements(t *testing.T) {
	srv, key, pool := newLinkTestServer(t, 15512)
	ctx := context.Background()

	resp := doJSON(t, srv.URL, "POST", "/v1/payment_links", key,
		`{"amount_mode":"fixed","amount":11099,"settle_currency":"EUR","settle_address":"0x00000000000000000000000000000000000000FF","reuse_policy":"single_use","merchant_reference":"table-9/bill-3"}`, "")
	var link struct {
		ID string `json:"id"`
	}
	json.Unmarshal([]byte(resp.body), &link)

	// Unpaid: the key is absent, not an empty list pretending to be an answer.
	resp = doJSON(t, srv.URL, "GET", "/v1/payment_links/"+link.ID, key, ``, "")
	if strings.Contains(resp.body, "settlements") {
		t.Errorf("unpaid link should omit settlements; body=%s", resp.body)
	}

	resp = doJSON(t, srv.URL, "POST", "/v1/payment_links/"+link.ID+"/pay", "", `{}`, "")
	var intent struct {
		ID string `json:"id"`
	}
	json.Unmarshal([]byte(resp.body), &intent)

	// A settlement lands, exactly as the confirm handler and indexer record it.
	if _, err := pool.Exec(ctx,
		`INSERT INTO settlements (id, intent_id, tx_hash, receipt_id, pay_currency, pay_amount,
		                          settle_amount, fee, block_number, log_index, settled_at)
		 VALUES ('stl_test1', $1, '0xfeed', '0xreceipt', 'USDC', 12345, 11099, 0, 1, 0, now())`,
		intent.ID,
	); err != nil {
		t.Fatalf("record settlement: %v", err)
	}

	resp = doJSON(t, srv.URL, "GET", "/v1/payment_links/"+link.ID, key, ``, "")
	if resp.status != http.StatusOK {
		t.Fatalf("get link: status=%d body=%s", resp.status, resp.body)
	}
	var got struct {
		Settlements []struct {
			IntentID       string `json:"intent_id"`
			TxHash         string `json:"tx_hash"`
			PayCurrency    string `json:"pay_currency"`
			PayAmount      string `json:"pay_amount"`
			SettleAmount   string `json:"settle_amount"`
			SettleCurrency string `json:"settle_currency"`
		} `json:"settlements"`
	}
	json.Unmarshal([]byte(resp.body), &got)
	if len(got.Settlements) != 1 {
		t.Fatalf("expected 1 settlement, got %d; body=%s", len(got.Settlements), resp.body)
	}
	s := got.Settlements[0]
	// The whole point: the till can compare this against the bill it printed.
	if s.SettleAmount != "11099" || s.SettleCurrency != "EUR" {
		t.Errorf("settle_amount/currency = %s/%s, want 11099/EUR", s.SettleAmount, s.SettleCurrency)
	}
	if s.PayAmount != "12345" || s.PayCurrency != "USDC" {
		t.Errorf("pay side = %s %s, want 12345 USDC", s.PayAmount, s.PayCurrency)
	}
	if s.IntentID != intent.ID || s.TxHash != "0xfeed" {
		t.Errorf("wrong settlement echoed back: %#v", s)
	}
}
