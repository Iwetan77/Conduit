package handlers

import (
	"crypto/ecdsa"
	"encoding/json"
	"fmt"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
)

// signTypedDataAsRelayer signs raw EIP-712 typed data (the same JSON shape a
// browser wallet's eth_signTypedData_v4 would consume) with a server-held
// key. Used ONLY for the bridged-intent handoff: once a payer's burn on
// Solana has minted USDC into Conduit's own Arc relayer address, that burn
// was itself the payer's final, irrevocable consent -- the relayer signs the
// two Arc-side StableFX authorizations (quote-ack, Permit2 funding) on the
// payer's behalf to push the already-theirs-in-substance funds through the
// existing settlement engine. See internal/bridge/README.md and Phase 3's
// commit message for the custody reasoning; this is a deliberate design
// choice, not a shortcut.
func signTypedDataAsRelayer(key *ecdsa.PrivateKey, rawTypedData []byte) (string, error) {
	var td apitypes.TypedData
	if err := json.Unmarshal(rawTypedData, &td); err != nil {
		return "", fmt.Errorf("bridge handoff: unmarshal typed data: %w", err)
	}
	digest, _, err := apitypes.TypedDataAndHash(td)
	if err != nil {
		return "", fmt.Errorf("bridge handoff: hash typed data: %w", err)
	}
	sig, err := crypto.Sign(digest, key)
	if err != nil {
		return "", fmt.Errorf("bridge handoff: sign typed data: %w", err)
	}
	// crypto.Sign's recovery id is 0/1; EIP-712/ecrecover expects 27/28 in the
	// v byte for the wire format most verifiers (including Circle's) expect.
	sig[64] += 27
	return "0x" + fmt.Sprintf("%x", sig), nil
}
