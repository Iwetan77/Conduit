package server

// Proving you control an address before money can be sent to it.
//
// The property under test is narrow and the only one that matters: an address
// nobody has proven control of must not become payable. A withdrawal is an
// on-chain transfer and final, and twenty bytes of valid hex is not evidence of
// anything -- it covers a wallet on another chain, an exchange deposit address
// that will never credit an Arc token, and every typo that lands in range.
//
// The signatures here are real ECDSA signatures over the server's own challenge
// message, produced with a key generated in the test. Nothing about the
// verification is stubbed: if the recovery is wrong, these fail.

import (
	"crypto/ecdsa"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/crypto"
)

type destination struct {
	ID       string `json:"id"`
	Address  string `json:"address"`
	Verified bool   `json:"verified"`
}

func newSigner(t *testing.T) (*ecdsa.PrivateKey, string) {
	t.Helper()
	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	return key, strings.ToLower(crypto.PubkeyToAddress(key.PublicKey).Hex())
}

// signPersonal produces exactly what a wallet's personal_sign produces: an
// EIP-191 prefixed digest, signed, with the recovery id shifted to 27/28 the
// way every wallet reports it.
func signPersonal(t *testing.T, key *ecdsa.PrivateKey, message string) string {
	t.Helper()
	prefixed := []byte(fmt.Sprintf("\x19Ethereum Signed Message:\n%d%s", len(message), message))
	sig, err := crypto.Sign(crypto.Keccak256(prefixed), key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	sig[64] += 27
	return "0x" + fmt.Sprintf("%x", sig)
}

func addDestination(t *testing.T, srvURL, key, address string) destination {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"address": address, "label": "Treasury"})
	resp := doJSON(t, srvURL, "POST", "/v1/payout_destinations", key, string(body), "")
	if resp.status != http.StatusCreated {
		t.Fatalf("create destination: status=%d body=%s", resp.status, resp.body)
	}
	var d destination
	if err := json.Unmarshal([]byte(resp.body), &d); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return d
}

func challengeFor(t *testing.T, srvURL, key, id string) string {
	t.Helper()
	resp := doJSON(t, srvURL, "POST", "/v1/payout_destinations/"+id+"/challenge", key, "", "")
	if resp.status != http.StatusOK {
		t.Fatalf("challenge: status=%d body=%s", resp.status, resp.body)
	}
	var out struct {
		Message string `json:"message"`
	}
	_ = json.Unmarshal([]byte(resp.body), &out)
	if out.Message == "" {
		t.Fatal("challenge returned no message to sign")
	}
	return out.Message
}

// A destination is added unpayable and only its owner's signature changes that.
func TestPayoutDestinationIsUnverifiedUntilProven(t *testing.T) {
	srv, key, _ := newLinkTestServer(t, 15571)
	signer, address := newSigner(t)

	d := addDestination(t, srv.URL, key, address)
	if d.Verified {
		t.Fatal("a freshly added destination reports itself verified")
	}

	message := challengeFor(t, srv.URL, key, d.ID)
	// The message must name the address and be readable, not opaque hex -- a
	// signing prompt nobody can read teaches people to approve anything.
	if !strings.Contains(strings.ToLower(message), strings.ToLower(address)) {
		t.Errorf("the challenge does not name the address being proven: %q", message)
	}

	body, _ := json.Marshal(map[string]string{"signature": signPersonal(t, signer, message)})
	resp := doJSON(t, srv.URL, "POST", "/v1/payout_destinations/"+d.ID+"/verify", key, string(body), "")
	if resp.status != http.StatusOK {
		t.Fatalf("verify: status=%d body=%s", resp.status, resp.body)
	}

	list := doJSON(t, srv.URL, "GET", "/v1/payout_destinations", key, "", "")
	var out struct {
		Data []destination `json:"data"`
	}
	_ = json.Unmarshal([]byte(list.body), &out)
	if len(out.Data) != 1 || !out.Data[0].Verified {
		t.Fatalf("destination did not come back verified: %+v", out.Data)
	}
}

// The signature has to be from the address being proven. A valid signature from
// SOME key is not evidence about THIS address -- that is the whole check.
func TestAValidSignatureFromTheWrongKeyIsRefused(t *testing.T) {
	srv, key, _ := newLinkTestServer(t, 15572)
	_, address := newSigner(t)
	impostor, _ := newSigner(t)

	d := addDestination(t, srv.URL, key, address)
	message := challengeFor(t, srv.URL, key, d.ID)

	body, _ := json.Marshal(map[string]string{"signature": signPersonal(t, impostor, message)})
	resp := doJSON(t, srv.URL, "POST", "/v1/payout_destinations/"+d.ID+"/verify", key, string(body), "")
	if resp.status == http.StatusOK {
		t.Fatal("a signature from a different key verified the destination")
	}
}

// A signature is the answer to one question, asked once. Replaying it after the
// challenge is answered must not work, or a captured signature is a standing
// key to somebody's payout list.
func TestAUsedChallengeCannotBeReplayed(t *testing.T) {
	srv, key, pool := newLinkTestServer(t, 15573)
	signer, address := newSigner(t)

	d := addDestination(t, srv.URL, key, address)
	message := challengeFor(t, srv.URL, key, d.ID)
	signature := signPersonal(t, signer, message)
	body, _ := json.Marshal(map[string]string{"signature": signature})

	first := doJSON(t, srv.URL, "POST", "/v1/payout_destinations/"+d.ID+"/verify", key, string(body), "")
	if first.status != http.StatusOK {
		t.Fatalf("first verify: status=%d body=%s", first.status, first.body)
	}

	// The nonce is gone rather than flagged used: a used value still sitting in
	// the row is a value somebody can replay against.
	var nonce *string
	if err := pool.QueryRow(t.Context(),
		`SELECT verification_nonce FROM payout_destinations WHERE id = $1`, d.ID,
	).Scan(&nonce); err != nil {
		t.Fatalf("read nonce: %v", err)
	}
	if nonce != nil {
		t.Fatalf("the challenge nonce survived being answered: %q", *nonce)
	}
}

// Re-adding an address somebody already proved must not quietly un-prove it.
// People re-add when they are not sure it saved.
func TestReAddingADestinationKeepsItsVerification(t *testing.T) {
	srv, key, _ := newLinkTestServer(t, 15574)
	signer, address := newSigner(t)

	d := addDestination(t, srv.URL, key, address)
	message := challengeFor(t, srv.URL, key, d.ID)
	body, _ := json.Marshal(map[string]string{"signature": signPersonal(t, signer, message)})
	if resp := doJSON(t, srv.URL, "POST", "/v1/payout_destinations/"+d.ID+"/verify", key, string(body), ""); resp.status != http.StatusOK {
		t.Fatalf("verify: status=%d body=%s", resp.status, resp.body)
	}

	again := addDestination(t, srv.URL, key, address)
	if again.ID != d.ID {
		t.Fatalf("re-adding created a second row: %s then %s", d.ID, again.ID)
	}
	if !again.Verified {
		t.Fatal("re-adding an address dropped a verification its owner had already completed")
	}
}

// One account's destinations are not another's to read, prove or remove.
func TestDestinationsAreScopedToTheirAccount(t *testing.T) {
	srv, keyA, _ := newLinkTestServer(t, 15575)
	_, address := newSigner(t)
	d := addDestination(t, srv.URL, keyA, address)

	resp := doJSON(t, srv.URL, "POST", "/v1/accounts", "",
		`{"name":"Other Co","settle_currency":"USD","settle_address":"0x00000000000000000000000000000000000000b7"}`, "")
	var other struct {
		APIKey struct {
			Key string `json:"key"`
		} `json:"api_key"`
	}
	_ = json.Unmarshal([]byte(resp.body), &other)

	if got := doJSON(t, srv.URL, "POST", "/v1/payout_destinations/"+d.ID+"/challenge", other.APIKey.Key, "", ""); got.status != http.StatusNotFound {
		t.Errorf("another account could request a challenge for it: status=%d", got.status)
	}
	if got := doJSON(t, srv.URL, "DELETE", "/v1/payout_destinations/"+d.ID, other.APIKey.Key, "", ""); got.status != http.StatusNotFound {
		t.Errorf("another account could delete it: status=%d", got.status)
	}

	list := doJSON(t, srv.URL, "GET", "/v1/payout_destinations", other.APIKey.Key, "", "")
	var out struct {
		Data []destination `json:"data"`
	}
	_ = json.Unmarshal([]byte(list.body), &out)
	if len(out.Data) != 0 {
		t.Errorf("another account can see it: %+v", out.Data)
	}
}

// Verifying without asking for a challenge first is a conflict, not a signature
// failure -- there is nothing to have signed.
func TestVerifyingWithoutAChallengeIsRefused(t *testing.T) {
	srv, key, _ := newLinkTestServer(t, 15576)
	signer, address := newSigner(t)
	d := addDestination(t, srv.URL, key, address)

	body, _ := json.Marshal(map[string]string{
		"signature": signPersonal(t, signer, challengeMessageForTest(address, "made-up-nonce")),
	})
	resp := doJSON(t, srv.URL, "POST", "/v1/payout_destinations/"+d.ID+"/verify", key, string(body), "")
	if resp.status != http.StatusConflict {
		t.Fatalf("status=%d, want 409; body=%s", resp.status, resp.body)
	}
}

// Mirrors handlers.challengeMessage. Deliberately a copy: if the real one
// changes shape, the test above must stop passing rather than follow it.
func challengeMessageForTest(address, nonce string) string {
	return fmt.Sprintf(
		"Conduit: confirm this payout address\n\nAddress: %s\nNonce: %s",
		strings.ToLower(address), nonce,
	)
}
