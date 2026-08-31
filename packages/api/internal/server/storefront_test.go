package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/kzn-labs/conduit/api/internal/links"
)

// storefrontLink is the subset of the link response these tests assert on.
type storefrontLink struct {
	ID             string `json:"id"`
	AmountMode     string `json:"amount_mode"`
	ReusePolicy    string `json:"reuse_policy"`
	Status         string `json:"status"`
	SettleCurrency string `json:"settle_currency"`
	SettleAddress  string `json:"settle_address"`
	Description    string `json:"description"`
	HostedURL      string `json:"hosted_url"`
}

// TestStorefrontLink: the QR a storefront prints resolves to a reusable,
// open-amount link bound to that storefront -- not to its raw settle address,
// which a phone camera can't act on and which would bypass Conduit entirely.
func TestStorefrontLink(t *testing.T) {
	srv, key, _ := newLinkTestServer(t, 15506)

	resp := doJSON(t, srv.URL, "POST", "/v1/accounts/sub", key,
		`{"name":"Shibuya store","settle_currency":"EUR"}`, "")
	if resp.status != http.StatusCreated {
		t.Fatalf("create storefront: status=%d body=%s", resp.status, resp.body)
	}
	var sub struct {
		ID string `json:"id"`
	}
	json.Unmarshal([]byte(resp.body), &sub)

	resp = doJSON(t, srv.URL, "POST", "/v1/accounts/"+sub.ID+"/storefront_link", key, ``, "")
	if resp.status != http.StatusOK {
		t.Fatalf("storefront_link: status=%d body=%s", resp.status, resp.body)
	}
	var link storefrontLink
	json.Unmarshal([]byte(resp.body), &link)

	// Open amount: a sticker at a till can't know the sale total, so the payer
	// types it. Multi-use: it is a standing QR, not a one-shot invoice.
	if link.AmountMode != "open" {
		t.Errorf("amount_mode = %q, want open", link.AmountMode)
	}
	if link.ReusePolicy != "multi_use" {
		t.Errorf("reuse_policy = %q, want multi_use", link.ReusePolicy)
	}
	// Currency is the storefront's own; the ADDRESS is its parent's, inherited
	// when the storefront was created.
	//
	// A storefront is a place the same business takes money, not a different
	// business, so it has never needed an address of its own -- and letting one
	// be typed per till was five separate chances to point a location's takings
	// somewhere unrecoverable. Attribution comes from the account the link is
	// bound to, which is what the settlement row records, not from the address.
	if link.SettleCurrency != "EUR" {
		t.Errorf("settle_currency = %q, want the storefront's own EUR", link.SettleCurrency)
	}
	if !strings.EqualFold(link.SettleAddress, "0x0000000000000000000000000000000000000009") {
		t.Errorf("link settles to %s, want the parent's address it inherited", link.SettleAddress)
	}
	if link.Description != "Shibuya store" {
		t.Errorf("description = %q, want the storefront name", link.Description)
	}
	// The QR encodes this: a real URL a phone camera can open.
	if !strings.HasSuffix(link.HostedURL, "/pay/"+link.ID) || !strings.HasPrefix(link.HostedURL, "https://") {
		t.Errorf("hosted_url = %q, want an absolute /pay/<id> URL", link.HostedURL)
	}

	// Get-or-create: the Storefronts page calls this for every card on every
	// load, so a second call must return the same link, never mint another.
	resp = doJSON(t, srv.URL, "POST", "/v1/accounts/"+sub.ID+"/storefront_link", key, ``, "")
	var again storefrontLink
	json.Unmarshal([]byte(resp.body), &again)
	if again.ID != link.ID {
		t.Fatalf("not idempotent: first %s, second %s", link.ID, again.ID)
	}

	// Still the same link once a customer has opened checkout against it --
	// Pay() moves the link to 'viewed', which must not orphan the printed QR.
	resp = doJSON(t, srv.URL, "POST", "/v1/payment_links/"+link.ID+"/pay", "", `{"amount":1250}`, "")
	if resp.status != http.StatusCreated {
		t.Fatalf("pay storefront link: status=%d body=%s", resp.status, resp.body)
	}
	resp = doJSON(t, srv.URL, "POST", "/v1/accounts/"+sub.ID+"/storefront_link", key, ``, "")
	var midSale storefrontLink
	json.Unmarshal([]byte(resp.body), &midSale)
	if midSale.ID != link.ID {
		t.Fatalf("mid-sale lookup minted a second link: %s vs %s", midSale.ID, link.ID)
	}

	// An open-amount link with no amount is a client error, not a 0-value sale.
	resp = doJSON(t, srv.URL, "POST", "/v1/payment_links/"+link.ID+"/pay", "", `{}`, "")
	if resp.status == http.StatusCreated {
		t.Error("paying an open-amount link without an amount should fail")
	}
}

// TestStorefrontLinkTenancy: one merchant cannot provision or read a link
// against another merchant's account id.
func TestStorefrontLinkTenancy(t *testing.T) {
	srv, key, _ := newLinkTestServer(t, 15507)

	resp := doJSON(t, srv.URL, "POST", "/v1/accounts", "",
		`{"name":"Other Co","settle_currency":"USD","settle_address":"0x0000000000000000000000000000000000000009"}`, "")
	var other struct {
		ID string `json:"id"`
	}
	json.Unmarshal([]byte(resp.body), &other)

	resp = doJSON(t, srv.URL, "POST", "/v1/accounts/"+other.ID+"/storefront_link", key, ``, "")
	if resp.status != http.StatusNotFound {
		t.Fatalf("cross-tenant storefront_link: expected 404, got %d body=%s", resp.status, resp.body)
	}
}

// TestMultiUseSurvivesSettlement is the regression test for the bug that made
// storefronts impossible: every settlement path closed the link outright,
// ignoring reuse_policy, so the FIRST customer to actually pay retired the
// printed QR for everyone behind them. Runs the real statement those paths run.
func TestMultiUseSurvivesSettlement(t *testing.T) {
	srv, key, pool := newLinkTestServer(t, 15508)
	ctx := context.Background()

	pay := func(linkID, body string) string {
		t.Helper()
		r := doJSON(t, srv.URL, "POST", "/v1/payment_links/"+linkID+"/pay", "", body, "")
		if r.status != http.StatusCreated {
			t.Fatalf("pay %s: status=%d body=%s", linkID, r.status, r.body)
		}
		var out struct {
			ID string `json:"id"`
		}
		json.Unmarshal([]byte(r.body), &out)
		return out.ID
	}
	status := func(linkID string) string {
		t.Helper()
		var s string
		if err := pool.QueryRow(ctx, `SELECT status FROM payment_links WHERE id = $1`, linkID).Scan(&s); err != nil {
			t.Fatalf("read status: %v", err)
		}
		return s
	}

	mk := func(reuse string) string {
		t.Helper()
		r := doJSON(t, srv.URL, "POST", "/v1/payment_links", key,
			`{"amount_mode":"fixed","amount":5000,"settle_currency":"USD","reuse_policy":"`+reuse+`"}`, "")
		var l struct {
			ID string `json:"id"`
		}
		json.Unmarshal([]byte(r.body), &l)
		return l.ID
	}

	multi := mk("multi_use")
	single := mk("single_use")

	multiIntent := pay(multi, `{}`)
	singleIntent := pay(single, `{}`)

	// Settlement lands on both, via the exact statement the confirm handler and
	// the indexer run.
	for _, intentID := range []string{multiIntent, singleIntent} {
		if _, err := pool.Exec(ctx, links.SettleByIntentSQL, intentID); err != nil {
			t.Fatalf("settle %s: %v", intentID, err)
		}
	}

	if got := status(single); got != "paid" {
		t.Errorf("single_use link after settlement = %q, want paid", got)
	}
	if got := status(multi); got != "active" {
		t.Errorf("multi_use link after settlement = %q, want active (it must stay live)", got)
	}

	// The point of all of it: the next customer can still pay.
	pay(multi, `{}`)

	r := doJSON(t, srv.URL, "POST", "/v1/payment_links/"+single+"/pay", "", `{}`, "")
	if r.status != http.StatusConflict {
		t.Errorf("single_use link must stay closed after settlement: got %d", r.status)
	}
}
