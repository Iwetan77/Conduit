package bridge

import (
	"context"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	solanago "github.com/gagliardetto/solana-go"
)

// BurnRequest is what a payer signs on the source chain to fund a bridge.
// UnsignedTxBase64 already carries every required signature except the
// payer's own -- any ephemeral accounts the burn instruction needs (CCTP's
// message-log account) are pre-signed server-side before this is returned,
// since the payer has no reason to control those keys.
type BurnRequest struct {
	TransferID       string // bridge_transfers.id
	UnsignedTxBase64 string // partially-signed Solana transaction, payer signature missing
	RecentBlockhash  string // for the caller to know how long this is valid for
}

// Attestation is Iris's signed message for one burn, plus enough to submit
// the destination-side mint without the payer present. Persist Message and
// AttestationBytes to the DB the moment they're available (state -> attested)
// -- see README.md's orphaned-burn section for why.
type Attestation struct {
	SourceTxHash     string
	Message          []byte
	AttestationBytes []byte
	Status           string
}

// BridgeProvider is a source-chain-specific CCTP implementation. Kept
// provider-shaped so other source chains slot in later (Ethereum, Base, ...)
// without touching callers -- Phase 3's handlers/reconciler depend only on
// this interface, never on SolanaArcProvider directly.
type BridgeProvider interface {
	Name() string
	SourceDomain() uint32

	// InitiateBurn builds the unsigned depositForBurn transaction for the
	// payer to countersign and submit themselves on the source chain. It does
	// NOT submit anything -- Conduit never holds the payer's source-chain
	// funds or signing key.
	InitiateBurn(ctx context.Context, payer solanago.PublicKey, amount *big.Int, destRecipient common.Address) (BurnRequest, error)

	// PollAttestation blocks (with timeout) until Iris signs the message for
	// sourceTxHash, or returns an error. Callers should persist the result
	// immediately on success -- it's what makes orphan recovery possible.
	PollAttestation(ctx context.Context, sourceTxHash string) (Attestation, error)

	// Mint submits receiveMessage on Arc. Idempotent on sourceTxHash: safe to
	// call from a live payer session and the orphan reconciler without
	// coordination between them. CCTP's own nonce-consumption on
	// MessageTransmitterV2 rejects a second receiveMessage for the same
	// message, so a genuine double-submit fails cleanly on-chain rather than
	// double-minting; callers (Phase 3) additionally guard with the DB's
	// unique partial indexes on bridge_transfers.source_tx_hash/mint_tx_hash
	// so the loser of the race never even reaches this call.
	Mint(ctx context.Context, att Attestation) (mintTxHash string, minted *big.Int, err error)
}
