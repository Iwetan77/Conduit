package handlers

import (
	"os"
	"strings"
	"testing"
)

// The contract-execution route builds a transaction from a caller-supplied
// target and calldata. Circle still requires the user's PIN, so it cannot move
// funds by itself -- but it will construct approve(attacker, max) and show it
// to the user inside a Conduit prompt, which is the entire attack against a
// stolen user token.
func TestApprovalsAreOnlyBuiltForConduitContracts(t *testing.T) {
	const router = "0x80f996e86C003AF309635B67A53dC6e63e623318"
	const payroll = "0xcC4b99a2B74DA98695d4136FB7F20988621BeB11"
	os.Setenv("CONDUIT_ROUTER_ADDRESS", router)
	os.Setenv("CONDUIT_PAYROLL_ADDRESS", payroll)

	approve := func(spender string) string {
		return "0x095ea7b3" +
			strings.Repeat("0", 24) + strings.TrimPrefix(strings.ToLower(spender), "0x") +
			strings.Repeat("f", 64) // amount: max
	}

	t.Run("an approval to an attacker is refused", func(t *testing.T) {
		spender, isApprove := approvalSpender(approve("0x000000000000000000000000000000000000dEaD"))
		if !isApprove {
			t.Fatal("failed to recognise an approve call")
		}
		if allowedApprovalSpender(spender) {
			t.Error("would have built an approval in favour of an arbitrary address")
		}
	})

	for _, ok := range []struct{ name, spender string }{
		{"our router", router},
		// Was missing, and every payroll run failed at its approve with
		// "approvals are only built for Conduit's own contracts" -- a refusal
		// that was correct about the list and wrong about the contract.
		{"our payroll contract", payroll},
		{"permit2", "0x000000000022D473030F116dDEE9F6B43aC78BA3"},
		{"gateway wallet", "0x0077777d7EBA4688BDeF3E311b846F25870A19B9"},
		{"stablefx escrow", "0x867650F5eAe8df91445971f14d89fd84F0C9a9f8"},
	} {
		t.Run(ok.name+" is allowed", func(t *testing.T) {
			spender, isApprove := approvalSpender(approve(ok.spender))
			if !isApprove {
				t.Fatal("failed to recognise an approve call")
			}
			// Checksummed input, lowercase table: the comparison must not care.
			if !allowedApprovalSpender(spender) {
				t.Errorf("refused a legitimate approval to %s (%s)", ok.name, ok.spender)
			}
		})
	}

	t.Run("non-approve calldata is left alone", func(t *testing.T) {
		// transfer(address,uint256) and the router's own execute must pass
		// through untouched -- this guard is targeted, not a calldata filter.
		for _, data := range []string{
			"0xa9059cbb" + strings.Repeat("0", 128),
			"0x", "", "0x1234",
		} {
			if _, isApprove := approvalSpender(data); isApprove {
				t.Errorf("treated %q as an approve", data)
			}
		}
	})

	t.Run("a truncated approve is not parsed optimistically", func(t *testing.T) {
		if _, isApprove := approvalSpender("0x095ea7b3dead"); isApprove {
			t.Error("parsed a malformed approve rather than ignoring it")
		}
	})
}
