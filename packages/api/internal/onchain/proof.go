package onchain

// What proves a payment landed.
//
// An event is corroboration. A token transfer is proof. Two callers need that
// distinction and must never disagree about it:
//
//   - RecordDirectSettlement, when a browser reports the transaction it just
//     sent.
//   - the indexer, when it sees a PaymentSettled log go past.
//
// The indexer used to have no version of this at all: it inserted a settlement
// row, flipped the intent to settled and fired settlement.succeeded on the
// strength of the log alone, never fetching the receipt and never looking for a
// transfer. Every field it trusted (recipient, amount, declarationId) comes out
// of a caller-supplied struct, and the router had an external entry point that
// emitted the event without moving the money it described. So a merchant's
// checkout could say "payment received" over a transaction that moved dust.
//
// Extracted here rather than copied, because two implementations of "was this
// actually paid" is one implementation and one liability. The one that drifts
// is always the one nobody is looking at.

import (
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
)

// ERC20TransferTopic is keccak256("Transfer(address,address,uint256)") — the
// topic[0] of every ERC-20 Transfer log.
var ERC20TransferTopic = crypto.Keccak256Hash([]byte("Transfer(address,address,uint256)"))

// Proof is a matched ERC-20 Transfer: the evidence that a specific
// amount of a specific token reached a specific address in a specific tx.
type Proof struct {
	// LogIndex of the matched Transfer. Half of the (tx_hash, log_index)
	// uniqueness that makes recording idempotent across both callers.
	LogIndex uint
	// Amount actually transferred. Equal to the expected amount by
	// construction — carried so a caller records what the chain said rather
	// than what it asked for.
	Amount *big.Int
	// Payer is the ORIGIN of the funds, not the address that made the final
	// hop.
	//
	// This is the bug the extraction had to not carry forward. The old code
	// took Topics[1] of the matched transfer and called it "the payer, straight
	// from the chain". But the router used to pay out through a separate
	// settler contract, so the log that reached the merchant had that
	// CONTRACT as its sender — and every settlement recorded before Phase A3
	// has a contract address in its payer column.
	//
	// Phase A3 removed that hop: the router now pays the recipient directly, so
	// for any payment made after it the transfer's own sender IS the payer.
	// The walk-back below is kept for the settlements made before that, which
	// the reconciler can still re-read, and for any future path that routes
	// through an intermediary.
	//
	// Empty when it cannot be determined honestly. A blank payer is a gap
	// somebody can notice; a contract address sitting in that column looks like
	// an answer and is not one.
	Payer string
}

// FindSettlementTransfer looks for an ERC-20 Transfer of `token`, to
// `recipient`, for EXACTLY `amount`, among a receipt's logs.
//
// Exactly, not at least. A router payment delivers instruction.amount and
// nothing else, so ">=" only ever admits transfers this payment did not cause,
// while still recording the intent's amount — leaving the excess unaccounted.
//
// Returns nil when there is no such transfer. A nil result is the whole point
// of this function: it means the transaction did not pay this, whatever any
// event in it claims.
func FindSettlementTransfer(
	receipt *types.Receipt,
	token, recipient common.Address,
	amount *big.Int,
) *Proof {
	if receipt == nil || receipt.Status != types.ReceiptStatusSuccessful {
		return nil
	}
	for _, lg := range receipt.Logs {
		if lg.Address != token || len(lg.Topics) != 3 || lg.Topics[0] != ERC20TransferTopic {
			continue
		}
		if common.BytesToAddress(lg.Topics[2].Bytes()) != recipient {
			continue
		}
		value := new(big.Int).SetBytes(lg.Data)
		if value.Cmp(amount) != 0 {
			continue
		}
		return &Proof{
			LogIndex: lg.Index,
			Amount:   value,
			Payer:    originatingPayer(receipt, token, amount, lg),
		}
	}
	return nil
}

// originatingPayer walks BACK from the transfer that paid the merchant to the
// transfer that funded it, and returns the sender of that one.
//
// The shape it is unwinding: the router pulls `amount + fee` from the payer,
// then (before Phase A3) forwarded `amount` to a settler contract which paid
// the recipient. The last hop's sender was that contract, which is what the old
// code recorded. The FIRST hop's sender is the person who paid.
//
// Post-A3 there is only one hop and this returns its sender immediately.
//
// Matched by value rather than by position, since a receipt may carry unrelated
// logs. An earlier transfer of the same token, for at least this amount, to a
// contract that later paid the recipient is the funding leg — and if no such
// transfer exists, the paying transfer's own sender is already the payer (a
// single-hop payment, which is what Phase A3 makes every payment).
//
// Returns "" rather than a guess when neither reading is safe. See
// Proof.Payer.
func originatingPayer(
	receipt *types.Receipt,
	token common.Address,
	amount *big.Int,
	paying *types.Log,
) string {
	payingFrom := common.BytesToAddress(paying.Topics[1].Bytes())

	// Is the address that paid the merchant itself a recipient earlier in this
	// same transaction? If so it was a conduit, not the source.
	var funded bool
	var source common.Address
	for _, lg := range receipt.Logs {
		if lg.Index >= paying.Index {
			break
		}
		if lg.Address != token || len(lg.Topics) != 3 || lg.Topics[0] != ERC20TransferTopic {
			continue
		}
		if common.BytesToAddress(lg.Topics[2].Bytes()) != payingFrom {
			continue
		}
		// At least the amount: the funding leg carries the protocol fee too.
		if new(big.Int).SetBytes(lg.Data).Cmp(amount) < 0 {
			continue
		}
		funded = true
		source = common.BytesToAddress(lg.Topics[1].Bytes())
	}

	if !funded {
		// Single hop. The sender paid the merchant directly.
		return payingFrom.Hex()
	}
	// Walk one more level only if the source was itself funded here — a payer
	// is an EOA and will not appear as a recipient in its own payment.
	for _, lg := range receipt.Logs {
		if lg.Index >= paying.Index {
			break
		}
		if lg.Address != token || len(lg.Topics) != 3 || lg.Topics[0] != ERC20TransferTopic {
			continue
		}
		if common.BytesToAddress(lg.Topics[2].Bytes()) == source {
			// More hops than this function models. Rather than record the
			// wrong address confidently, record nothing.
			return ""
		}
	}
	return source.Hex()
}
