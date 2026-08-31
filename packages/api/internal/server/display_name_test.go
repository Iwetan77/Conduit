package server

import (
	"encoding/json"
	"net/http"
	"testing"
)

// Who a payment request says it is FROM.
//
// This is the most-seen string in the product: it is what the share card puts
// under "PAYMENT REQUEST FROM", so it is what lands in a WhatsApp preview
// before anyone has opened anything. It said "Personal" for every payer-created
// link, because that is literally the name of a personal account (migration
// 0010) and nothing preferred the username over it.
func TestPublicIntentShowsTheUsernameNotTheAccountName(t *testing.T) {
	srv, key, _ := newLinkTestServer(t, 15527)

	if status, body := claimUsername(t, srv.URL, key, "sophia"); status != http.StatusOK {
		t.Fatalf("claim: status=%d body=%s", status, body)
	}

	resp := doJSON(t, srv.URL, "POST", "/v1/settlement_intents", key,
		`{"amount":"5000000","settle_currency":"USD"}`, "")
	if resp.status != http.StatusCreated {
		t.Fatalf("create intent: status=%d body=%s", resp.status, resp.body)
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal([]byte(resp.body), &created); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	pub := doJSON(t, srv.URL, "GET", "/v1/settlement_intents/"+created.ID+"/public", "", "", "")
	if pub.status != http.StatusOK {
		t.Fatalf("public view: status=%d body=%s", pub.status, pub.body)
	}
	var view struct {
		DisplayName string `json:"display_name"`
	}
	if err := json.Unmarshal([]byte(pub.body), &view); err != nil {
		t.Fatalf("unmarshal public: %v", err)
	}
	if view.DisplayName != "sophia" {
		t.Fatalf("display_name = %q, want the username %q -- the card would read "+
			"\"PAYMENT REQUEST FROM %s\"", view.DisplayName, "sophia", view.DisplayName)
	}
}

// With no username claimed there is nothing better to show, so the account's
// own name is correct rather than a bug. Pinned so a future change to the
// preference order cannot leave a nameless account with a blank card.
func TestPublicIntentFallsBackToTheAccountName(t *testing.T) {
	srv, key, _ := newLinkTestServer(t, 15528)

	resp := doJSON(t, srv.URL, "POST", "/v1/settlement_intents", key,
		`{"amount":"5000000","settle_currency":"USD"}`, "")
	if resp.status != http.StatusCreated {
		t.Fatalf("create intent: status=%d body=%s", resp.status, resp.body)
	}
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal([]byte(resp.body), &created)

	pub := doJSON(t, srv.URL, "GET", "/v1/settlement_intents/"+created.ID+"/public", "", "", "")
	var view struct {
		DisplayName string `json:"display_name"`
	}
	if err := json.Unmarshal([]byte(pub.body), &view); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if view.DisplayName == "" {
		t.Fatal("a card with no name on it at all")
	}
	if view.DisplayName != "Link Test Co" {
		t.Fatalf("display_name = %q, want the account's own name", view.DisplayName)
	}
}
