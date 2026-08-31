package server

// Sending income straight to a treasury, and what has to be true first.
//
// This is the one setting that points every FUTURE payment somewhere Conduit
// cannot withdraw from. The properties worth holding down are therefore: it
// cannot be aimed at an address nobody proved, it cannot happen by mis-click,
// it does not disturb payments already agreed, and it can be undone.

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

// setExternalBody is the request, built once so a test cannot accidentally omit
// the confirmation and pass for the wrong reason.
func setExternalBody(destinationID, confirmName string) string {
	b, _ := json.Marshal(map[string]string{
		"destination_id": destinationID,
		"confirm_name":   confirmName,
	})
	return string(b)
}

// The whole flow rests on this. An unproven address is indistinguishable from a
// typo, and here the cost is not one wrong withdrawal but every payment after.
func TestExternalSettlementRefusesAnUnverifiedDestination(t *testing.T) {
	srv, key, pool := newLinkTestServer(t, 15591)
	_, address := newSigner(t)
	d := addDestination(t, srv.URL, key, address)

	var name, before string
	if err := pool.QueryRow(context.Background(),
		`SELECT name, settle_address FROM accounts WHERE parent_id IS NULL ORDER BY created_at LIMIT 1`,
	).Scan(&name, &before); err != nil {
		t.Fatalf("read account: %v", err)
	}

	resp := doJSON(t, srv.URL, "POST", "/v1/accounts/me/settlement_address/external", key,
		setExternalBody(d.ID, name), "")
	if resp.status != http.StatusConflict {
		t.Fatalf("status=%d, want 409; body=%s", resp.status, resp.body)
	}
	if got := errCode(t, resp.body); got != "payout_destination_unverified" {
		t.Errorf("code=%s, want payout_destination_unverified", got)
	}

	var after string
	_ = pool.QueryRow(context.Background(),
		`SELECT settle_address FROM accounts WHERE parent_id IS NULL ORDER BY created_at LIMIT 1`).Scan(&after)
	if after != before {
		t.Fatalf("a refused request still moved settlement: %s -> %s", before, after)
	}
}

// Typing the name is friction, not security -- anyone who can make this call can
// read the name. Friction is the right tool: this must not be possible by
// mis-clicking.
func TestExternalSettlementRequiresTheAccountNameTyped(t *testing.T) {
	srv, key, pool := newLinkTestServer(t, 15592)
	signer, address := newSigner(t)
	d := addDestination(t, srv.URL, key, address)
	message := challengeFor(t, srv.URL, key, d.ID)
	sig, _ := json.Marshal(map[string]string{"signature": signPersonal(t, signer, message)})
	doJSON(t, srv.URL, "POST", "/v1/payout_destinations/"+d.ID+"/verify", key, string(sig), "")

	resp := doJSON(t, srv.URL, "POST", "/v1/accounts/me/settlement_address/external", key,
		setExternalBody(d.ID, "not the account name"), "")
	if resp.status != http.StatusBadRequest {
		t.Fatalf("status=%d, want 400; body=%s", resp.status, resp.body)
	}

	// Asserted on the ADDRESS, not the source. An API-key account's source is
	// legitimately 'external' from the moment it is created -- it supplied its
	// own address -- so the source cannot tell "unchanged" from "changed" here.
	// Where the money goes can.
	var settle string
	_ = pool.QueryRow(context.Background(),
		`SELECT settle_address FROM accounts WHERE parent_id IS NULL ORDER BY created_at LIMIT 1`).Scan(&settle)
	if equalFold(settle, address) {
		t.Fatal("settlement moved to the destination without the confirmation")
	}
}

// The whole point, end to end: a proven destination, the name typed, income
// redirected — and then undone.
func TestExternalSettlementIsReversible(t *testing.T) {
	srv, key, pool := newLinkTestServer(t, 15593)
	ctx := context.Background()
	signer, address := newSigner(t)
	d := addDestination(t, srv.URL, key, address)
	message := challengeFor(t, srv.URL, key, d.ID)
	sig, _ := json.Marshal(map[string]string{"signature": signPersonal(t, signer, message)})
	doJSON(t, srv.URL, "POST", "/v1/payout_destinations/"+d.ID+"/verify", key, string(sig), "")

	var accountID, name, provisioned string
	if err := pool.QueryRow(ctx,
		`SELECT id, name, settle_address FROM accounts WHERE parent_id IS NULL ORDER BY created_at LIMIT 1`,
	).Scan(&accountID, &name, &provisioned); err != nil {
		t.Fatalf("read account: %v", err)
	}
	// Stand this account up as though it had been provisioned, which is the
	// state a merchant switching away from is actually in.
	if _, err := pool.Exec(ctx,
		`UPDATE accounts SET settle_wallet_id='w-ext', provisioned_address=$1,
		        settle_address_source='provisioned' WHERE id=$2`,
		provisioned, accountID,
	); err != nil {
		t.Fatalf("mark provisioned: %v", err)
	}

	resp := doJSON(t, srv.URL, "POST", "/v1/accounts/me/settlement_address/external", key,
		setExternalBody(d.ID, name), "")
	if resp.status != http.StatusOK {
		t.Fatalf("set external: status=%d body=%s", resp.status, resp.body)
	}

	var addr string
	var source string
	_ = pool.QueryRow(ctx,
		`SELECT settle_address, settle_address_source FROM accounts WHERE id=$1`, accountID).Scan(&addr, &source)
	if !equalFold(addr, address) || source != "external" {
		t.Fatalf("settlement did not move: addr=%s source=%s", addr, source)
	}

	// The wallet is remembered, not discarded. Forgetting it is what would make
	// this one-way, and the server cannot ask Circle for the address again.
	var walletID, remembered *string
	_ = pool.QueryRow(ctx,
		`SELECT settle_wallet_id, provisioned_address FROM accounts WHERE id=$1`,
		accountID).Scan(&walletID, &remembered)
	if walletID == nil || remembered == nil {
		t.Fatalf("switching away forgot the provisioned wallet: id=%v address=%v", walletID, remembered)
	}

	// One call, nothing typed. Asymmetric on purpose: the decision worth
	// slowing down is sending income somewhere we cannot reach.
	back := doJSON(t, srv.URL, "POST", "/v1/accounts/me/settlement_address/revert", key, "", "")
	if back.status != http.StatusOK {
		t.Fatalf("revert: status=%d body=%s", back.status, back.body)
	}
	_ = pool.QueryRow(ctx,
		`SELECT settle_address, settle_address_source FROM accounts WHERE id=$1`, accountID).Scan(&addr, &source)
	if !equalFold(addr, provisioned) || source != "provisioned" {
		t.Fatalf("revert did not restore the provisioned wallet: addr=%s source=%s", addr, source)
	}
}

// A payment somebody already agreed to cannot be redirected by a setting
// changed afterwards. This is the property that makes the whole feature safe to
// offer at all.
func TestExternalSettlementDoesNotMoveExistingLinks(t *testing.T) {
	srv, key, pool := newLinkTestServer(t, 15594)
	ctx := context.Background()
	signer, address := newSigner(t)

	created := doJSON(t, srv.URL, "POST", "/v1/payment_links", key,
		`{"amount_mode":"fixed","amount":50000,"settle_currency":"USD"}`, "")
	if created.status != http.StatusCreated {
		t.Fatalf("create link: status=%d body=%s", created.status, created.body)
	}
	var link struct {
		ID            string `json:"id"`
		SettleAddress string `json:"settle_address"`
	}
	_ = json.Unmarshal([]byte(created.body), &link)

	d := addDestination(t, srv.URL, key, address)
	message := challengeFor(t, srv.URL, key, d.ID)
	sig, _ := json.Marshal(map[string]string{"signature": signPersonal(t, signer, message)})
	doJSON(t, srv.URL, "POST", "/v1/payout_destinations/"+d.ID+"/verify", key, string(sig), "")

	var name string
	_ = pool.QueryRow(ctx,
		`SELECT name FROM accounts WHERE parent_id IS NULL ORDER BY created_at LIMIT 1`).Scan(&name)
	if resp := doJSON(t, srv.URL, "POST", "/v1/accounts/me/settlement_address/external", key,
		setExternalBody(d.ID, name), ""); resp.status != http.StatusOK {
		t.Fatalf("set external: status=%d body=%s", resp.status, resp.body)
	}

	var stored string
	if err := pool.QueryRow(ctx,
		`SELECT settle_address FROM payment_links WHERE id = $1`, link.ID).Scan(&stored); err != nil {
		t.Fatalf("read link: %v", err)
	}
	if !equalFold(stored, link.SettleAddress) {
		t.Fatalf("an existing link followed the account to %s; it must still say %s", stored, link.SettleAddress)
	}
	if equalFold(stored, address) {
		t.Fatal("a link created before the change now pays the new external address")
	}
}
