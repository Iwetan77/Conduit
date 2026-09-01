package handlers

// Phase A5's central finding, as a test.
//
// The API used to verify one aggregate PayrollRun event -- run id, token, total
// -- and then mark EVERY pending item in that currency as paid. Those two facts
// do not add up to each other. A caller could disperse the correct total to a
// single address of their choosing and every employee in the group would be
// recorded as paid, with payroll.run.completed fired and nothing anywhere
// saying otherwise.

import (
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
)

var (
	payrollContract = common.HexToAddress("0xcC4b99a2B74DA98695d4136FB7F20988621BeB11")
	usdcToken       = common.HexToAddress("0x3600000000000000000000000000000000000000")
	treasury        = "0x08894c27115a63063a710b152a441fffb43d90e3"
	runHash         = common.HexToHash("0xabc123")
)

func word(n *big.Int) []byte { return common.LeftPadBytes(n.Bytes(), 32) }

func runLog(payer common.Address, recipients int, total *big.Int) *types.Log {
	return &types.Log{
		Address: payrollContract,
		Topics: []common.Hash{
			payrollRunTopic,
			runHash,
			common.BytesToHash(usdcToken.Bytes()),
			common.BytesToHash(payer.Bytes()),
		},
		Data: append(word(big.NewInt(int64(recipients))), word(total)...),
	}
}

func paidLog(to common.Address, amount *big.Int) *types.Log {
	return &types.Log{
		Address: payrollContract,
		Topics: []common.Hash{
			payrollPaidTopic,
			runHash,
			common.BytesToHash(usdcToken.Bytes()),
			common.BytesToHash(to.Bytes()),
		},
		Data: word(amount),
	}
}

func receipt(logs ...*types.Log) *types.Receipt {
	return &types.Receipt{Status: 1, Logs: logs}
}

// The test this phase exists for: the total is right and one address got
// everything.
func TestPayrollATotalIsNotProofThatFivePeopleWerePaid(t *testing.T) {
	attacker := common.HexToAddress("0x000000000000000000000000000000000000dEaD")
	total := big.NewInt(500)

	r := receipt(
		runLog(common.HexToAddress(treasury), 5, total),
		// One recipient, the whole total. Four employees are not in here.
		paidLog(attacker, total),
	)

	paid := payrollPayments(r, payrollContract, runHash, usdcToken, treasury, total)

	if len(paid) != 1 {
		t.Fatalf("expected exactly the one payment that happened, got %d", len(paid))
	}
	if paid[0].to != strings.ToLower(attacker.Hex()) {
		t.Errorf("payment recorded against %s, want %s", paid[0].to, attacker.Hex())
	}

	// The point: five employees, each owed 100, match nothing here.
	for i := 0; i < 5; i++ {
		employee := common.HexToAddress("0x1111111111111111111111111111111111111111")
		key := payment{to: strings.ToLower(employee.Hex()), amount: "100"}
		for _, p := range paid {
			if p == key {
				t.Fatal("an employee was matched to a payment that never reached them")
			}
		}
	}
}

func TestPayrollEachRecipientIsReturnedSeparately(t *testing.T) {
	a := common.HexToAddress("0xa11ce00000000000000000000000000000000000")
	b := common.HexToAddress("0xb0b0000000000000000000000000000000000000")

	r := receipt(
		runLog(common.HexToAddress(treasury), 2, big.NewInt(300)),
		paidLog(a, big.NewInt(100)),
		paidLog(b, big.NewInt(200)),
	)
	paid := payrollPayments(r, payrollContract, runHash, usdcToken, treasury, big.NewInt(300))
	if len(paid) != 2 {
		t.Fatalf("got %d payments, want 2", len(paid))
	}
}

// The contract deliberately allows one address twice -- salary and expenses as
// two arrangements. Both lines must consume their own log, or one payment marks
// two rows paid.
func TestPayrollADuplicateAddressYieldsTwoPayments(t *testing.T) {
	a := common.HexToAddress("0xa11ce00000000000000000000000000000000000")
	r := receipt(
		runLog(common.HexToAddress(treasury), 2, big.NewInt(300)),
		paidLog(a, big.NewInt(100)),
		paidLog(a, big.NewInt(200)),
	)
	paid := payrollPayments(r, payrollContract, runHash, usdcToken, treasury, big.NewInt(300))
	if len(paid) != 2 {
		t.Fatalf("got %d payments, want 2 — a duplicate address is two lines, not one", len(paid))
	}
}

// A merchant's payroll comes out of the merchant's own treasury. Nothing said
// so before this phase.
func TestPayrollAStrangersWalletDoesNotPayThisAccountsPayroll(t *testing.T) {
	stranger := common.HexToAddress("0x9999999999999999999999999999999999999999")
	a := common.HexToAddress("0xa11ce00000000000000000000000000000000000")

	r := receipt(
		runLog(stranger, 1, big.NewInt(100)),
		paidLog(a, big.NewInt(100)),
	)
	if paid := payrollPayments(r, payrollContract, runHash, usdcToken, treasury, big.NewInt(100)); paid != nil {
		t.Fatal("accepted a payroll paid from a wallet that is not this account's treasury")
	}
}

func TestPayrollARevertedTransactionPaidNobody(t *testing.T) {
	a := common.HexToAddress("0xa11ce00000000000000000000000000000000000")
	r := receipt(
		runLog(common.HexToAddress(treasury), 1, big.NewInt(100)),
		paidLog(a, big.NewInt(100)),
	)
	r.Status = 0
	if paid := payrollPayments(r, payrollContract, runHash, usdcToken, treasury, big.NewInt(100)); paid != nil {
		t.Fatal("read logs out of a reverted transaction")
	}
}

func TestPayrollAWrongTotalIsNotThisRun(t *testing.T) {
	a := common.HexToAddress("0xa11ce00000000000000000000000000000000000")
	r := receipt(
		runLog(common.HexToAddress(treasury), 1, big.NewInt(99)),
		paidLog(a, big.NewInt(99)),
	)
	if paid := payrollPayments(r, payrollContract, runHash, usdcToken, treasury, big.NewInt(100)); paid != nil {
		t.Fatal("matched a run whose total was not the one being claimed")
	}
}

func TestPayrollLogsFromAnotherContractAreIgnored(t *testing.T) {
	a := common.HexToAddress("0xa11ce00000000000000000000000000000000000")
	impostor := runLog(common.HexToAddress(treasury), 1, big.NewInt(100))
	impostor.Address = common.HexToAddress("0x000000000000000000000000000000000000bEEF")
	if paid := payrollPayments(receipt(impostor, paidLog(a, big.NewInt(100))),
		payrollContract, runHash, usdcToken, treasury, big.NewInt(100)); paid != nil {
		t.Fatal("trusted a PayrollRun event emitted by some other contract")
	}
}
