package server

// A direct send goes to SOMEBODY ELSE.
//
// /v1/settlement_intents/direct is the one intent route where settle_address is
// the recipient rather than the caller. Everywhere else an intent is a merchant
// asking to be paid, so deriving the address from the account is right. Here a
// payer is sending money to another person, and the destination is the one
// thing only the caller can know.
//
// Rejecting it broke every cross-currency direct send with a 400. Silently
// dropping it would have been worse: the intent would settle back to the payer,
// with a 201 and a receipt and nothing saying the money went nowhere near where
// it was aimed.

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestDirectIntentSettlesToTheRecipientNotThePayer(t *testing.T) {
	srv, _, _ := newLinkTestServer(t, 15650)

	const payer = "0x1f38f7A2e5Cb55d6AfbF44934BC62cF791015C99"
	const recipient = "0x08894c27115a63063a710b152a441fffb43d90e3"

	body := `{"payer_wallet":"` + payer + `","amount":"2000000",` +
		`"settle_currency":"EURC","settle_address":"` + recipient + `",` +
		`"accept_currencies":["USDC"]}`

	res := doJSON(t, srv.URL, "POST", "/v1/settlement_intents/direct", "", body, "")
	if res.status != http.StatusCreated && res.status != http.StatusOK {
		t.Fatalf("direct intent refused: status=%d body=%s", res.status, res.body)
	}

	var out struct {
		ID            string `json:"id"`
		SettleAddress string `json:"settle_address"`
	}
	if err := json.Unmarshal([]byte(res.body), &out); err != nil {
		t.Fatalf("decoding: %v — %s", err, res.body)
	}

	if !strings.EqualFold(out.SettleAddress, recipient) {
		t.Fatalf("intent settles to %s, want the recipient %s", out.SettleAddress, recipient)
	}
	if strings.EqualFold(out.SettleAddress, payer) {
		t.Fatal("the payment would settle back to the person sending it")
	}
}

// Omitted still means "pay me" — the payroll conversion leg converts a
// merchant's own funds and settles to their own address.
func TestDirectIntentWithoutAnAddressSettlesToTheCaller(t *testing.T) {
	srv, _, _ := newLinkTestServer(t, 15651)

	const payer = "0x1f38f7A2e5Cb55d6AfbF44934BC62cF791015C99"
	body := `{"payer_wallet":"` + payer + `","amount":"2000000",` +
		`"settle_currency":"EURC","accept_currencies":["USDC"]}`

	res := doJSON(t, srv.URL, "POST", "/v1/settlement_intents/direct", "", body, "")
	if res.status != http.StatusCreated && res.status != http.StatusOK {
		t.Fatalf("status=%d body=%s", res.status, res.body)
	}
	var out struct {
		SettleAddress string `json:"settle_address"`
	}
	_ = json.Unmarshal([]byte(res.body), &out)
	if !strings.EqualFold(out.SettleAddress, payer) {
		t.Fatalf("settles to %s, want the caller %s", out.SettleAddress, payer)
	}
}

// It decides where money goes, and nothing downstream can tell a typo from an
// address.
func TestDirectIntentRejectsAMalformedAddress(t *testing.T) {
	srv, _, _ := newLinkTestServer(t, 15652)

	body := `{"payer_wallet":"0x1f38f7A2e5Cb55d6AfbF44934BC62cF791015C99","amount":"2000000",` +
		`"settle_currency":"EURC","settle_address":"not-an-address","accept_currencies":["USDC"]}`

	res := doJSON(t, srv.URL, "POST", "/v1/settlement_intents/direct", "", body, "")
	if res.status == http.StatusCreated || res.status == http.StatusOK {
		t.Fatalf("accepted a malformed settle_address: %s", res.body)
	}
}
