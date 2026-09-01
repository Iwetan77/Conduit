package handlers

// One user, TWO wallets. That is the whole feature.
//
// Signing in with Google gives a person their own Circle wallet. Running a
// business gives that same person a SECOND one, and the business's income,
// sends and settlement history all belong to the second. Personal money and
// business money are different products sharing a login, and if the two
// addresses are equal none of that separation exists.
//
// The predicates below decide whether a business "has its own address". Each
// checked source and wallet id, and none checked the thing that actually
// matters: that the address is not the one its owner signs in with. So a row
// marked 'provisioned' while still pointing at the login wallet read as ready
// forever — the dashboard gates provisioning on that answer, so it never ran
// again, and the merchant saw one address in /send and in the merchant
// dashboard with business income landing in a personal wallet.

import "testing"

func ptr(s string) *string { return &s }

func TestABusinessIsNotReadyWhileItSharesTheOwnersWallet(t *testing.T) {
	const login = "0x08894c27115a63063a710b152a441fffb43d90e3"
	provisioned := sourceProvisioned

	same := &settlementAccount{
		loginWallet:    ptr(login),
		settleWalletID: ptr("wal_123"),
		settleAddress:  login, // the bug: provisioned, but to the login wallet
		source:         &provisioned,
	}
	if same.ready() {
		t.Fatal("an account settling to its owner's own sign-in wallet reported ready — " +
			"this is what traps it, because the provisioner never runs again")
	}

	// Case differs; it is the same address. Two casings of one address must
	// never read as two wallets.
	sameUpper := &settlementAccount{
		loginWallet:    ptr("0x08894C27115A63063A710B152A441FFFB43D90E3"),
		settleWalletID: ptr("wal_123"),
		settleAddress:  login,
		source:         &provisioned,
	}
	if sameUpper.ready() {
		t.Fatal("checksum casing was treated as a different address")
	}
}

func TestABusinessWithItsOwnWalletIsReady(t *testing.T) {
	provisioned := sourceProvisioned
	ok := &settlementAccount{
		loginWallet:    ptr("0x08894c27115a63063a710b152a441fffb43d90e3"),
		settleWalletID: ptr("wal_456"),
		settleAddress:  "0x1f38f7A2e5Cb55d6AfbF44934BC62cF791015C99", // a second Circle wallet
		source:         &provisioned,
	}
	if !ok.ready() {
		t.Fatal("a business with a genuinely separate wallet reported not ready")
	}
}

func TestTheDefaultStateIsNotReady(t *testing.T) {
	login := sourceLoginWallet
	def := &settlementAccount{
		loginWallet:    ptr("0x08894c27115a63063a710b152a441fffb43d90e3"),
		settleWalletID: nil,
		settleAddress:  "0x08894c27115a63063a710b152a441fffb43d90e3",
		source:         &login,
	}
	if def.ready() {
		t.Fatal("a brand new Google account reported ready before provisioning ran")
	}
}

// A payer's own account settles to the wallet they signed in with by
// definition. This predicate is only ever asked about businesses, but it must
// not claim a personal account is broken.
func TestAnAccountWithNoLoginWalletIsJudgedOnSourceAlone(t *testing.T) {
	provisioned := sourceProvisioned
	external := &settlementAccount{
		loginWallet:    nil,
		settleWalletID: ptr("wal_789"),
		settleAddress:  "0x1f38f7A2e5Cb55d6AfbF44934BC62cF791015C99",
		source:         &provisioned,
	}
	if !external.ready() {
		t.Fatal("an account with no login wallet was reported not ready")
	}
}
