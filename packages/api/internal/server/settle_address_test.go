package server

import (
	"encoding/json"
	"net/http"
	"testing"
)

// Where a business's money lands, and who may change it.
//
// These once covered a one-time prompt asking the merchant to choose an address,
// which existed because settle_address defaulted to the sign-in wallet and
// nothing ever asked. Accounts are now given an address of their own, so the
// question is gone rather than deferred -- and what is left worth testing is
// that nobody can set one through a general-purpose update.

func accountMe(t *testing.T, srvURL, key string) (bool, string) {
	t.Helper()
	resp := doJSON(t, srvURL, "GET", "/v1/accounts/me", key, "", "")
	if resp.status != http.StatusOK {
		t.Fatalf("accounts/me: status=%d body=%s", resp.status, resp.body)
	}
	var out struct {
		Ready         bool   `json:"settlement_wallet_ready"`
		SettleAddress string `json:"settle_address"`
		ID            string `json:"id"`
	}
	if err := json.Unmarshal([]byte(resp.body), &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return out.Ready, out.SettleAddress
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
