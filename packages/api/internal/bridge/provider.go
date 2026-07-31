package bridge

import (
	"context"
	"math/big"
)

// Address is a chain-agnostic account identifier -- a 0x-prefixed hex string
// for EVM chains, a base58 string for Solana. Callers know which shape to
// expect from the source chain they're dealing with; FundingProvider itself
// never type-asserts on chain-specific address formats.
type Address string

// UnifiedBalance is the payer's already-deposited Gateway balance, read via
// GET .../v1/balances across every domain Gateway knows about for this payer.
type UnifiedBalance struct {
	TotalAvailable *big.Int // sum across all domains, USDC minor units
	ByDomain       map[uint32]*big.Int
}

// FundRequest is what the payer signs to authorize a spend. Unlike raw CCTP's
// on-chain depositForBurn transaction, a Gateway "burn intent" is an
// off-chain message signature -- gasless, not a transaction -- IF the payer
// already has a deposited Gateway balance covering the amount. DepositTx is
// only populated when the payer's deposited balance is insufficient and a
// real on-chain deposit transaction must happen first; see
// docs/ubk-capability.md's "deposit-then-spend" section for why both exist.
type FundRequest struct {
	TransferID          string // bridge_transfers.id
	NeedsDeposit        bool   // true if DepositTx must be signed+submitted before BurnIntentMessage
	DepositTxBase64     string // unsigned deposit transaction, payer signature missing (only if NeedsDeposit)
	BurnIntentMessage   []byte // raw bytes for the payer to sign (ed25519 for Solana, EIP-712 digest for EVM)
	BurnIntentSignature []byte // filled in by the caller once the payer signs, then passed to Fund
}

// FundingStatus is the current bridging-stage state for polling, mapped from
// GET .../v1/transfer/{id}.
type FundingStatus struct {
	State         State
	MintTxHash    string
	MintedAmount  *big.Int
	FailureReason string
}

// FundingProvider gets USDC onto Arc from wherever the payer holds it.
// Backed by Circle Unified Balance Kit / Gateway. Chain-agnostic by design:
// which source chain a given payer's funds live on is detected, not
// hardcoded -- an implementation may serve every Gateway-supported chain
// through the same REST calls (only account/signature encoding differs per
// chain family, entirely inside the implementation, never in this
// interface). See docs/ubk-capability.md for the real API this is built
// against.
type FundingProvider interface {
	Name() string

	// UnifiedBalance reads the payer's already-deposited Gateway balance
	// across every domain Gateway tracks for them (POST /v1/balances).
	UnifiedBalance(ctx context.Context, payer Address) (UnifiedBalance, error)

	// PrepareFund builds the artifact(s) the payer must sign to fund `amount`
	// USDC to destArcAddress: a deposit transaction if their Gateway balance
	// is insufficient, and always a burn-intent message. Conduit never holds
	// the payer's source-chain signing key.
	PrepareFund(ctx context.Context, payer Address, amount *big.Int, destArcAddress Address) (FundRequest, error)

	// Fund submits the payer's signed burn intent (POST /v1/transfer) once
	// PrepareFund's artifacts are signed and any required deposit has landed.
	// Idempotent on the FundRequest's TransferID -- safe to call from a live
	// session and the orphan reconciler without coordination between them.
	Fund(ctx context.Context, req FundRequest) (transferID string, err error)

	// Status returns the current bridging-stage state for polling
	// (GET /v1/transfer/{id}). Arc is a confirmed Gateway forwarder
	// destination, so Conduit never submits its own destination-side mint --
	// Status purely observes Circle's own relayer completing it.
	Status(ctx context.Context, transferID string) (FundingStatus, error)
}
