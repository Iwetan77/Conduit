package arcrpc

// Asking a contract wallet whether a signature is its own.
//
// A Safe, or any other smart-contract account, holds no private key of its own,
// so there is no ECDSA signature that recovers to its address. The only entity
// that can answer "is this signature valid for me" is the contract, and EIP-1271
// is how it answers.
//
// This matters for payouts specifically: a business whose treasury is a multisig
// is exactly the business most likely to want its income withdrawn somewhere
// other than the wallet it signs in with, and an ECDSA-only check would tell it
// to prove control of an address that cannot sign.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// isValidSignature(bytes32,bytes) -> bytes4
//
// The magic value a conforming contract returns for a valid signature. Anything
// else -- including a successful call returning zeroes -- is a no.
var (
	erc1271Selector = crypto.Keccak256([]byte("isValidSignature(bytes32,bytes)"))[:4]
	erc1271Magic    = []byte{0x16, 0x26, 0xba, 0x7e}
)

// IsValidERC1271Signature asks `address` whether `signature` is valid for `hash`.
//
// Returns (false, nil) for a definite no, and an error when the question could
// not be put at all. Callers must treat an error as a no: this is an
// authorization decision and "we could not tell" is not permission.
func IsValidERC1271Signature(ctx context.Context, rpcURL, address string, hash, signature []byte) (bool, error) {
	if len(hash) != 32 {
		return false, fmt.Errorf("arcrpc: hash must be 32 bytes, got %d", len(hash))
	}
	client, err := Get(ctx, rpcURL)
	if err != nil {
		return false, err
	}

	// An address with no code cannot answer, and asking anyway would return
	// empty data that must not be mistaken for a reply. Checked explicitly so
	// "not a contract" is distinguishable from "the contract said no".
	callCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	code, err := client.CodeAt(callCtx, common.HexToAddress(address), nil)
	if err != nil {
		return false, err
	}
	if len(code) == 0 {
		return false, errors.New("arcrpc: address has no contract code")
	}

	data := append([]byte{}, erc1271Selector...)
	data = append(data, hash...)
	// The dynamic `bytes` argument: offset, then length, then the padded value.
	// Written out rather than pulled through abi.Pack for one two-argument call
	// -- the encoding is four lines and the dependency is not.
	data = append(data, common.LeftPadBytes([]byte{0x40}, 32)...)
	data = append(data, common.LeftPadBytes(big(len(signature)), 32)...)
	data = append(data, common.RightPadBytes(signature, ((len(signature)+31)/32)*32)...)

	to := common.HexToAddress(address)
	out, err := client.CallContract(callCtx, ethereum.CallMsg{To: &to, Data: data}, nil)
	if err != nil {
		// A revert is a definite no rather than a failure to ask: a conforming
		// contract that rejects a signature is entitled to revert, and several
		// do. Reported as (false, nil) so a caller does not treat a clear
		// refusal as an outage.
		return false, nil
	}
	if len(out) < 4 {
		return false, nil
	}
	return bytes.Equal(out[:4], erc1271Magic), nil
}

func big(n int) []byte {
	if n == 0 {
		return []byte{0}
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte(n & 0xff)}, b...)
		n >>= 8
	}
	return b
}
