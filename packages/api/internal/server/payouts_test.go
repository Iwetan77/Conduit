package server

// Withdrawing, and what has to be true before money can leave.
//
// The properties here are the ones that cost real money if they are wrong: a
// withdrawal cannot be authorised to an address nobody proved, cannot be
// recorded on a transaction that does not contain it, and cannot be recorded
// twice from one transaction.
//
// The chain is not reachable from these tests -- confirming needs a real
// transaction on Arc, which is what scripts/e2e-payout.sh exists for. So these
// cover authorisation and the ledger's own integrity, and say so rather than
// pretending to cover the on-chain half. Nothing about the chain is faked; the
// paths that would touch it are simply not the paths under test.

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestAWithdrawalToAnUnprovenAddressIsRefused(t *testing.T) {
	srv, key, _ := newLinkTestServer(t, 15581)
	_, address := newSigner(t)
	d := addDestination(t, srv.URL, key, address)

	body, _ := json.Marshal(map[string]string{
		"destination_id": d.ID, "currency": "USD", "amount": "1000000",
	})
	resp := doJSON(t, srv.URL, "POST", "/v1/payouts", key, string(body), "")
	if resp.status != http.StatusConflict {
		t.Fatalf("status=%d, want 409; body=%s", resp.status, resp.body)
	}
	if got := errCode(t, resp.body); got != "payout_destination_unverified" {
		t.Errorf("code=%s, want payout_destination_unverified", got)
	}
}

// Once proven, the withdrawal is authorised -- and every field of the transfer
// comes from the server. A client that could name the token or the recipient
// would be choosing where the money goes, which is the whole thing this design
// takes away from it.
func TestAnAuthorisedWithdrawalDescribesATransferTheServerChose(t *testing.T) {
	srv, key, pool := newLinkTestServer(t, 15582)
	signer, address := newSigner(t)
	d := addDestination(t, srv.URL, key, address)

	message := challengeFor(t, srv.URL, key, d.ID)
	sig, _ := json.Marshal(map[string]string{"signature": signPersonal(t, signer, message)})
	if r := doJSON(t, srv.URL, "POST", "/v1/payout_destinations/"+d.ID+"/verify", key, string(sig), ""); r.status != http.StatusOK {
		t.Fatalf("verify: status=%d body=%s", r.status, r.body)
	}

	body, _ := json.Marshal(map[string]string{
		"destination_id": d.ID, "currency": "USD", "amount": "1000000",
	})
	resp := doJSON(t, srv.URL, "POST", "/v1/payouts", key, string(body), "")
	if resp.status != http.StatusCreated {
		t.Fatalf("status=%d, want 201; body=%s", resp.status, resp.body)
	}
	var out struct {
		ID       string `json:"id"`
		Status   string `json:"status"`
		From     string `json:"from_address"`
		Transfer struct {
			Token  string `json:"token"`
			To     string `json:"to"`
			Amount string `json:"amount"`
		} `json:"transfer"`
	}
	if err := json.Unmarshal([]byte(resp.body), &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Status != "pending" {
		t.Errorf("status=%q; nothing has moved yet, so it must be pending", out.Status)
	}
	if !equalFold(out.Transfer.To, address) {
		t.Errorf("transfer.to = %s, want the verified destination %s", out.Transfer.To, address)
	}
	if out.Transfer.Token == "" {
		t.Error("no token address: the browser cannot build the transfer without one")
	}
	if out.Transfer.Amount != "1000000" {
		t.Errorf("transfer.amount = %s, want the authorised 1000000", out.Transfer.Amount)
	}

	// It withdraws FROM the account's own settlement address, not anywhere the
	// caller could name.
	var settle string
	if err := pool.QueryRow(t.Context(),
		`SELECT settle_address FROM accounts WHERE id = (SELECT account_id FROM payouts WHERE id = $1)`,
		out.ID,
	).Scan(&settle); err != nil {
		t.Fatalf("read account: %v", err)
	}
	if !equalFold(out.From, settle) {
		t.Errorf("from_address = %s, want the account's settlement address %s", out.From, settle)
	}

	// And nothing is on the ledger yet: authorising is not moving.
	var ledger int
	if err := pool.QueryRow(t.Context(),
		`SELECT count(*) FROM balance_transactions WHERE type = 'payout'`).Scan(&ledger); err != nil {
		t.Fatalf("count ledger: %v", err)
	}
	if ledger != 0 {
		t.Fatalf("%d payout ledger rows before anything was confirmed", ledger)
	}
}

// A hash is a claim. Confirming has to look at the chain, and when it cannot
// find the transfer it must refuse -- a ledger built from what a client says
// happened is a ledger that can be told anything.
func TestConfirmingRefusesATransactionThatDoesNotContainTheTransfer(t *testing.T) {
	srv, key, pool := newLinkTestServer(t, 15583)
	signer, address := newSigner(t)
	d := addDestination(t, srv.URL, key, address)
	message := challengeFor(t, srv.URL, key, d.ID)
	sig, _ := json.Marshal(map[string]string{"signature": signPersonal(t, signer, message)})
	doJSON(t, srv.URL, "POST", "/v1/payout_destinations/"+d.ID+"/verify", key, string(sig), "")

	body, _ := json.Marshal(map[string]string{
		"destination_id": d.ID, "currency": "USD", "amount": "1000000",
	})
	created := doJSON(t, srv.URL, "POST", "/v1/payouts", key, string(body), "")
	var out struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal([]byte(created.body), &out)

	// A well-formed hash for a transaction that is not this transfer. The
	// handler reaches the real Arc RPC to find that out; either answer it gets
	// -- "no such transaction" or "not that transfer" -- must leave the payout
	// unpaid, which is what this asserts.
	confirm, _ := json.Marshal(map[string]string{
		"tx_hash": "0x1111111111111111111111111111111111111111111111111111111111111111",
	})
	resp := doJSON(t, srv.URL, "POST", "/v1/payouts/"+out.ID+"/confirm", key, string(confirm), "")
	if resp.status == http.StatusOK {
		t.Fatalf("a made-up transaction confirmed a withdrawal: %s", resp.body)
	}

	var status string
	var txHash *string
	if err := pool.QueryRow(t.Context(),
		`SELECT status, tx_hash FROM payouts WHERE id = $1`, out.ID).Scan(&status, &txHash); err != nil {
		t.Fatalf("read payout: %v", err)
	}
	if status != "pending" || txHash != nil {
		t.Fatalf("payout moved off pending on an unverified claim: status=%s tx=%v", status, txHash)
	}
	var ledger int
	_ = pool.QueryRow(t.Context(), `SELECT count(*) FROM balance_transactions WHERE type='payout'`).Scan(&ledger)
	if ledger != 0 {
		t.Fatalf("%d ledger rows written for a withdrawal that was never proven", ledger)
	}
}

// One account cannot withdraw against another's destination, even a verified one.
func TestWithdrawalsAreScopedToTheirAccount(t *testing.T) {
	srv, keyA, _ := newLinkTestServer(t, 15584)
	signer, address := newSigner(t)
	d := addDestination(t, srv.URL, keyA, address)
	message := challengeFor(t, srv.URL, keyA, d.ID)
	sig, _ := json.Marshal(map[string]string{"signature": signPersonal(t, signer, message)})
	doJSON(t, srv.URL, "POST", "/v1/payout_destinations/"+d.ID+"/verify", keyA, string(sig), "")

	resp := doJSON(t, srv.URL, "POST", "/v1/accounts", "",
		`{"name":"Other Co","settle_currency":"USD","settle_address":"0x00000000000000000000000000000000000000c9"}`, "")
	var other struct {
		APIKey struct {
			Key string `json:"key"`
		} `json:"api_key"`
	}
	_ = json.Unmarshal([]byte(resp.body), &other)

	body, _ := json.Marshal(map[string]string{
		"destination_id": d.ID, "currency": "USD", "amount": "1000000",
	})
	got := doJSON(t, srv.URL, "POST", "/v1/payouts", other.APIKey.Key, string(body), "")
	if got.status != http.StatusNotFound {
		t.Fatalf("another account withdrew against it: status=%d body=%s", got.status, got.body)
	}
}

func equalFold(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		ca, cb := a[i], b[i]
		if 'A' <= ca && ca <= 'Z' {
			ca += 'a' - 'A'
		}
		if 'A' <= cb && cb <= 'Z' {
			cb += 'a' - 'A'
		}
		if ca != cb {
			return false
		}
	}
	return true
}
