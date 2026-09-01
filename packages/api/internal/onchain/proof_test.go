package onchain

// The point of Phase A2, as a test.
//
// A PaymentSettled log is a claim. These assert that the claim is worth nothing
// on its own: unless the same transaction contains an ERC-20 Transfer of the
// right token, to the right address, for the right amount, FindSettlementTransfer
// returns nil and the caller writes no settlement.

import (
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
)

var (
	token      = common.HexToAddress("0x3600000000000000000000000000000000000000")
	merchant   = common.HexToAddress("0x08894c27115a63063a710b152a441fffb43d90e3")
	payer      = common.HexToAddress("0x1111111111111111111111111111111111111111")
	settler    = common.HexToAddress("0x22eb1affd62b65D3F06Ce9Bd9c1EEabCc047CC0b")
	router     = common.HexToAddress("0x80f996e86C003AF309635B67A53dC6e63e623318")
	otherTok   = common.HexToAddress("0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a")
	oneHundred = big.NewInt(100_000000)
)

func transferLog(index uint, tok, from, to common.Address, amount *big.Int) *types.Log {
	return &types.Log{
		Address: tok,
		Index:   index,
		Topics: []common.Hash{
			ERC20TransferTopic,
			common.BytesToHash(from.Bytes()),
			common.BytesToHash(to.Bytes()),
		},
		Data: common.LeftPadBytes(amount.Bytes(), 32),
	}
}

func receiptWith(logs ...*types.Log) *types.Receipt {
	return &types.Receipt{Status: types.ReceiptStatusSuccessful, Logs: logs}
}

// The test this phase exists for.
func TestAnEventWithoutATransferProvesNothing(t *testing.T) {
	t.Run("a receipt with no transfers at all", func(t *testing.T) {
		if p := FindSettlementTransfer(receiptWith(), token, merchant, oneHundred); p != nil {
			t.Fatal("accepted a settlement with no corroborating transfer")
		}
	})

	t.Run("a transfer of the wrong token", func(t *testing.T) {
		r := receiptWith(transferLog(0, otherTok, payer, merchant, oneHundred))
		if p := FindSettlementTransfer(r, token, merchant, oneHundred); p != nil {
			t.Fatal("matched a transfer of a token this intent does not settle in")
		}
	})

	t.Run("a transfer to somebody else", func(t *testing.T) {
		r := receiptWith(transferLog(0, token, payer, router, oneHundred))
		if p := FindSettlementTransfer(r, token, merchant, oneHundred); p != nil {
			t.Fatal("matched a transfer that never reached the merchant")
		}
	})

	// The forgery in miniature: the attacker moves one unit and emits an event
	// claiming a hundred.
	t.Run("dust, with an event claiming the full amount", func(t *testing.T) {
		r := receiptWith(transferLog(0, token, payer, merchant, big.NewInt(1)))
		if p := FindSettlementTransfer(r, token, merchant, oneHundred); p != nil {
			t.Fatal("a dust transfer was accepted as payment of the full amount")
		}
	})

	// Exactly, not at least. More than the intent asked for is not this
	// payment, and recording it as the intent amount leaves the excess
	// unaccounted for.
	t.Run("more than the amount is not a match", func(t *testing.T) {
		r := receiptWith(transferLog(0, token, payer, merchant, big.NewInt(150_000000)))
		if p := FindSettlementTransfer(r, token, merchant, oneHundred); p != nil {
			t.Fatal("matched a transfer for more than the intent amount")
		}
	})

	t.Run("a reverted transaction", func(t *testing.T) {
		r := receiptWith(transferLog(0, token, payer, merchant, oneHundred))
		r.Status = types.ReceiptStatusFailed
		if p := FindSettlementTransfer(r, token, merchant, oneHundred); p != nil {
			t.Fatal("accepted logs from a reverted transaction")
		}
	})
}

func TestAMatchingTransferIsAccepted(t *testing.T) {
	r := receiptWith(transferLog(3, token, payer, merchant, oneHundred))
	p := FindSettlementTransfer(r, token, merchant, oneHundred)
	if p == nil {
		t.Fatal("rejected a genuine settlement")
	}
	if p.LogIndex != 3 {
		t.Errorf("log index = %d, want 3", p.LogIndex)
	}
	if p.Amount.Cmp(oneHundred) != 0 {
		t.Errorf("amount = %s, want %s", p.Amount, oneHundred)
	}
}

// The payer bug this extraction had to not carry forward.
//
// execute() pulls amount+fee from the payer to the router, the router forwards
// to AtomicSettler, and the settler pays the merchant. The log that pays the
// merchant has the SETTLER as its sender -- so reading Topics[1] off it, which
// is what the old code did and called "the payer, straight from the chain",
// records a contract address as the person who paid.
func TestThePayerIsTheSourceNotTheLastHop(t *testing.T) {
	withFee := big.NewInt(101_000000)
	r := receiptWith(
		transferLog(0, token, payer, router, withFee),        // payer funds the router
		transferLog(1, token, router, settler, oneHundred),   // router forwards
		transferLog(2, token, settler, merchant, oneHundred), // settler pays out
	)
	p := FindSettlementTransfer(r, token, merchant, oneHundred)
	if p == nil {
		t.Fatal("rejected a genuine three-hop settlement")
	}
	if p.Payer == settler.Hex() {
		t.Fatal("recorded the AtomicSettler as the payer -- the original bug")
	}
	if p.Payer != router.Hex() && p.Payer != "" {
		t.Errorf("payer = %s, want the funding source or empty, never the last hop", p.Payer)
	}
}

// A single-hop payment -- what Phase A3 makes every payment -- has no ambiguity:
// the sender of the transfer that paid the merchant IS the payer.
func TestASingleHopPayerIsTheSender(t *testing.T) {
	r := receiptWith(transferLog(0, token, payer, merchant, oneHundred))
	p := FindSettlementTransfer(r, token, merchant, oneHundred)
	if p == nil {
		t.Fatal("rejected a genuine single-hop settlement")
	}
	if p.Payer != payer.Hex() {
		t.Errorf("payer = %s, want %s", p.Payer, payer.Hex())
	}
}
