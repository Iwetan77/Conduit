// Package fx implements FX provider selection. Provider selection is a Go
// concern (per the architecture delta §VOID — no Solidity IFXProvider
// abstraction): StableFX is off-chain REST RFQ with no view function, AMM
// quoting is an eth_call. They cannot share one on-chain interface, so they
// don't try to; this interface is the actual unification point.
package fx

import (
	"context"
	"math/big"
)

type Quote struct {
	Provider       string // "stablefx" | "amm" | "direct"
	QuoteID        string // provider's own quote identifier, empty for amm/direct
	FromCurrency   string // token symbol
	ToCurrency     string // token symbol
	FromAmount     *big.Int
	ToAmount       *big.Int
	Rate           string
	ExpiresAt      int64 // unix seconds
	RawTypedData   []byte
}

type Preparation struct {
	Provider          string
	ContractTradeID   string
	Witness           string // bytes32 hex
	WitnessTypeString string
	FundingTypedData  []byte // EIP-712 typed data for the PAYER to sign
}

// Provider is implemented per FX rail. Quote and Prepare never move funds —
// only Submit does, and only after the payer has signed FundingTypedData.
type Provider interface {
	Name() string
	// Quote requests a rate for settling `settleAmount` of `to`, paid in `from`.
	Quote(ctx context.Context, from, to string, settleAmount *big.Int, recipientAddress string) (Quote, error)
	// Prepare turns an unexpired Quote into signable funding typed data. For
	// StableFX this creates the trade and presigns; for AMM it's a no-op that
	// just re-shapes the quote (there's nothing to presign — see Submit).
	Prepare(ctx context.Context, q Quote, payer, recipient string) (Preparation, error)
	// Submit takes the payer's signature over Preparation.FundingTypedData and
	// settles on-chain, returning the transaction hash.
	Submit(ctx context.Context, p Preparation, signature string) (txHash string, err error)
}
