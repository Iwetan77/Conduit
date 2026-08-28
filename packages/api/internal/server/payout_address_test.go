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

// Naming a different address is itself the answer. Asking again afterwards is
// the kind of prompt people click through without reading.
func TestSettingAnAddressConfirmsItImplicitly(t *testing.T) {
	srv, key, _ := newLinkTestServer(t, 15531)
	_, _ = accountMe(t, srv.URL, key)

	// The account's own id is needed for the update route.
	resp := doJSON(t, srv.URL, "GET", "/v1/accounts/me", key, "", "")
	var me struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal([]byte(resp.body), &me)

	business := "0x00000000000000000000000000000000000000bb"
	upd := doJSON(t, srv.URL, "PATCH", "/v1/accounts/"+me.ID, key,
		`{"settle_address":"`+business+`"}`, "")
	if upd.status != http.StatusOK {
		t.Fatalf("update: status=%d body=%s", upd.status, upd.body)
	}

	confirmed, addr := accountMe(t, srv.URL, key)
	if !confirmed {
		t.Fatal("setting a payout address did not count as confirming it")
	}
	if addr != business {
		t.Fatalf("settle_address = %s, want %s", addr, business)
	}
}

// A payout address is where money goes and settlement is final, so a malformed
// one must never be stored however it arrived. We cannot undo an on-chain
// transfer to a typo.
func TestAMalformedPayoutAddressIsRefused(t *testing.T) {
	srv, key, _ := newLinkTestServer(t, 15532)
	resp := doJSON(t, srv.URL, "GET", "/v1/accounts/me", key, "", "")
	var me struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal([]byte(resp.body), &me)
	_, before := accountMe(t, srv.URL, key)

	for _, bad := range []string{"not-an-address", "0x123", "", "0xZZZZ2c8b0d4089b883d7b9e5a7986ba33ff51125"} {
		body, _ := json.Marshal(map[string]string{"settle_address": bad})
		upd := doJSON(t, srv.URL, "PATCH", "/v1/accounts/"+me.ID, key, string(body), "")
		// An empty string is COALESCE'd away rather than rejected, which is the
		// existing "field omitted" behaviour and is fine -- what must never
		// happen is a bad value being written.
		if bad != "" && upd.status == http.StatusOK {
			t.Fatalf("stored %q as a payout address", bad)
		}
	}

	_, after := accountMe(t, srv.URL, key)
	if after != before {
		t.Fatalf("a refused update still changed the address: %s -> %s", before, after)
	}
}
