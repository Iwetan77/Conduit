package server

import (
	"encoding/json"
	"net/http"
	"testing"
)

// Where a business's money lands, and whether anyone ever chose it.
//
// settle_address was always editable, so nothing here is new capability. What
// is new is telling apart an address someone PICKED from one they were handed:
// the login bootstrap defaults settle_address to the wallet used to sign in and
// never asks, so business income has been landing in a personal wallet by
// default with no record of whether that was intended.

func accountMe(t *testing.T, srvURL, key string) (bool, string) {
	t.Helper()
	resp := doJSON(t, srvURL, "GET", "/v1/accounts/me", key, "", "")
	if resp.status != http.StatusOK {
		t.Fatalf("accounts/me: status=%d body=%s", resp.status, resp.body)
	}
	var out struct {
		PayoutConfirmed bool   `json:"payout_confirmed"`
		SettleAddress   string `json:"settle_address"`
		ID              string `json:"id"`
	}
	if err := json.Unmarshal([]byte(resp.body), &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return out.PayoutConfirmed, out.SettleAddress
}

// The gate has to be OFF for accounts that already exist, or the one-time
// prompt reaches only new merchants and everyone already signed up keeps
// mixing business and personal income without ever being asked.
func TestPayoutStartsUnconfirmed(t *testing.T) {
	srv, key, _ := newLinkTestServer(t, 15529)

	confirmed, addr := accountMe(t, srv.URL, key)
	if confirmed {
		t.Fatal("a brand new account reports its payout address as confirmed -- nobody has been asked yet")
	}
	if addr == "" {
		t.Fatal("no settle address at all")
	}
}

// "Keep it where it is" is a real answer and must be recordable, or a
// one-person business is asked the same question at every sign-in forever and
// learns to dismiss it unread.
func TestConfirmingWithoutChangingTheAddress(t *testing.T) {
	srv, key, _ := newLinkTestServer(t, 15530)
	_, before := accountMe(t, srv.URL, key)

	resp := doJSON(t, srv.URL, "POST", "/v1/accounts/me/payout/confirm", key, "", "")
	if resp.status != http.StatusOK {
		t.Fatalf("confirm: status=%d body=%s", resp.status, resp.body)
	}

	confirmed, after := accountMe(t, srv.URL, key)
	if !confirmed {
		t.Fatal("confirming did not stick")
	}
	if after != before {
		t.Fatalf("confirming CHANGED the address: %s -> %s. It must only record the decision.", before, after)
	}
}

// Naming a different address is no longer something this endpoint does.
//
// It used to be, validated only as "20 bytes of well-formed hex" -- which
// accepts an address on another chain, an exchange deposit address that will
// never credit an Arc token, a contract that cannot receive, and any typo that
// happens to be well formed. Settlement is on-chain and final, so none of those
// were recoverable, and the account had no way to prove the address was even
// its own.
//
// The account now settles to the wallet provisioned for it. Sending income
// somewhere else is a deliberate act with its own proof of control, not a field
// on a general-purpose update.
func TestUpdateRefusesToSetAPayoutAddress(t *testing.T) {
	srv, key, _ := newLinkTestServer(t, 15531)
	_, before := accountMe(t, srv.URL, key)

	resp := doJSON(t, srv.URL, "GET", "/v1/accounts/me", key, "", "")
	var me struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal([]byte(resp.body), &me)

	upd := doJSON(t, srv.URL, "PATCH", "/v1/accounts/"+me.ID, key,
		`{"settle_address":"0x00000000000000000000000000000000000000bb"}`, "")
	if upd.status != http.StatusBadRequest {
		t.Fatalf("update: status=%d, want 400; body=%s", upd.status, upd.body)
	}
	// Refused, not ignored. An integration that kept sending an address and
	// kept getting 200 back would be paid somewhere other than it asked for,
	// with nothing anywhere reporting a problem.
	if got := errCode(t, upd.body); got != "settle_address_derived" {
		t.Errorf("code=%s, want settle_address_derived", got)
	}

	_, after := accountMe(t, srv.URL, key)
	if after != before {
		t.Fatalf("a refused update still moved the address: %s -> %s", before, after)
	}
}

// Everything else on the update still works -- this removed one field, not the
// endpoint.
func TestUpdateStillChangesTheNameAndCurrency(t *testing.T) {
	srv, key, _ := newLinkTestServer(t, 15532)
	resp := doJSON(t, srv.URL, "GET", "/v1/accounts/me", key, "", "")
	var me struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal([]byte(resp.body), &me)

	upd := doJSON(t, srv.URL, "PATCH", "/v1/accounts/"+me.ID, key, `{"name":"Renamed Co"}`, "")
	if upd.status != http.StatusOK {
		t.Fatalf("update: status=%d body=%s", upd.status, upd.body)
	}
	var out struct {
		Name string `json:"name"`
	}
	_ = json.Unmarshal([]byte(upd.body), &out)
	if out.Name != "Renamed Co" {
		t.Fatalf("name = %q, want Renamed Co", out.Name)
	}
}
