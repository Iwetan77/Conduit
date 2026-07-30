package bridge

import (
	"context"
	"math/big"
	"os"
	"strings"
	"testing"
	"time"

	ethereum "github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	solanago "github.com/gagliardetto/solana-go"
	sendandconfirmtransaction "github.com/gagliardetto/solana-go/rpc/sendAndConfirmTransaction"
	"github.com/gagliardetto/solana-go/rpc/ws"
)

const balanceOfABIJSON = `[{
	"type": "function",
	"name": "balanceOf",
	"stateMutability": "view",
	"inputs": [{"name": "account", "type": "address"}],
	"outputs": [{"name": "", "type": "uint256"}]
}]`

func mustUSDCBalance(t *testing.T, ctx context.Context, client *ethclient.Client, usdc, account common.Address) *big.Int {
	t.Helper()
	parsedABI, err := abi.JSON(strings.NewReader(balanceOfABIJSON))
	if err != nil {
		t.Fatalf("parse balanceOf ABI: %v", err)
	}
	calldata, err := parsedABI.Pack("balanceOf", account)
	if err != nil {
		t.Fatalf("pack balanceOf calldata: %v", err)
	}
	result, err := client.CallContract(ctx, ethereum.CallMsg{To: &usdc, Data: calldata}, nil)
	if err != nil {
		t.Fatalf("call balanceOf: %v", err)
	}
	var out *big.Int
	if err := parsedABI.UnpackIntoInterface(&out, "balanceOf", result); err != nil {
		t.Fatalf("unpack balanceOf result: %v", err)
	}
	return out
}

// TestSolanaArcFastTransfer_Live performs a REAL Solana devnet -> Arc
// testnet CCTP V2 Fast Transfer through this package's BridgeProvider --
// not mocked, not stubbed. Requires funded devnet SOL/USDC on the keypair at
// SOLANA_KEYPAIR_PATH and an Arc-funded signer at ARC_SIGNER_PRIVATE_KEY.
// Skips (does not fail) if that funding isn't configured, so this doesn't
// break CI runs without live credentials -- but per the spec, GATE 2 is only
// satisfied by actually running this with real funds and real tx hashes.
func TestSolanaArcFastTransfer_Live(t *testing.T) {
	solanaKeypairPath := os.Getenv("SOLANA_KEYPAIR_PATH")
	arcSignerKey := os.Getenv("ARC_SIGNER_PRIVATE_KEY")
	if solanaKeypairPath == "" || arcSignerKey == "" {
		t.Skip("SOLANA_KEYPAIR_PATH and ARC_SIGNER_PRIVATE_KEY not set -- skipping live CCTP transfer test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	payerKey, err := solanago.PrivateKeyFromSolanaKeygenFile(solanaKeypairPath)
	if err != nil {
		t.Fatalf("load Solana keypair: %v", err)
	}

	arcRPCURL := os.Getenv("ARC_TESTNET_RPC")
	if arcRPCURL == "" {
		arcRPCURL = "https://rpc.testnet.arc.network"
	}

	provider, err := NewSolanaArcProvider(
		"https://api.devnet.solana.com",
		"wss://api.devnet.solana.com",
		arcRPCURL,
		5042002, // Arc testnet chain id, deployments/arc-testnet.json
		arcSignerKey,
	)
	if err != nil {
		t.Fatalf("construct SolanaArcProvider: %v", err)
	}

	arcClient, err := ethclient.Dial(arcRPCURL)
	if err != nil {
		t.Fatalf("dial Arc RPC for balance checks: %v", err)
	}
	usdc := common.HexToAddress(ArcUSDC)
	// Recipient must be a DIFFERENT address than the Arc signer that pays for
	// the mint transaction. Arc's native gas token is USDC itself, so if
	// recipient == gas payer, the balance-delta assertion below would be
	// confounded by the mint tx's own gas cost -- confirmed this the hard way
	// on a real transfer (minted 499950, observed delta only 495545, the
	// missing 4405 was gas). A fresh throwaway keypair needs no funding to
	// receive a mint.
	recipientKey, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("generate recipient key: %v", err)
	}
	recipient := crypto.PubkeyToAddress(recipientKey.PublicKey)

	balanceBefore := mustUSDCBalance(t, ctx, arcClient, usdc, recipient)
	t.Logf("Arc USDC balance before: %s", balanceBefore.String())

	amount := big.NewInt(500_000) // 0.5 USDC -- conserve devnet funds across repeated test runs

	burnReq, err := provider.InitiateBurn(ctx, payerKey.PublicKey(), amount, recipient)
	if err != nil {
		t.Fatalf("InitiateBurn: %v", err)
	}

	tx, err := solanago.TransactionFromBase64(burnReq.UnsignedTxBase64)
	if err != nil {
		t.Fatalf("decode unsigned burn tx: %v", err)
	}
	// Simulate the payer countersigning client-side -- the ephemeral
	// message-log account is already signed by InitiateBurn, and the payer
	// (like any real client) only has their own key, so this must be a
	// PartialSign, not Sign (which demands every signer key up front).
	if _, err := tx.PartialSign(func(key solanago.PublicKey) *solanago.PrivateKey {
		if key.Equals(payerKey.PublicKey()) {
			return &payerKey
		}
		return nil
	}); err != nil {
		t.Fatalf("payer sign burn tx: %v", err)
	}
	if err := tx.VerifySignatures(); err != nil {
		t.Fatalf("burn tx missing a required signature after payer signs: %v", err)
	}

	wsClient, err := ws.Connect(ctx, "wss://api.devnet.solana.com")
	if err != nil {
		t.Fatalf("connect Solana ws: %v", err)
	}
	defer wsClient.Close()

	sig, err := sendandconfirmtransaction.SendAndConfirmTransaction(ctx, provider.solanaRPC, wsClient, tx)
	if err != nil {
		t.Fatalf("submit+confirm burn tx: %v", err)
	}
	t.Logf("Burn tx (Solana devnet): %s", sig.String())

	attestation, err := provider.PollAttestation(ctx, sig.String())
	if err != nil {
		t.Fatalf("PollAttestation: %v", err)
	}
	t.Logf("Attestation received for burn %s", sig.String())

	mintTxHash, minted, err := provider.Mint(ctx, attestation)
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	t.Logf("Mint tx (Arc testnet): %s, minted=%s", mintTxHash, minted.String())

	if minted.Cmp(big.NewInt(0)) <= 0 {
		t.Fatalf("minted amount must be positive, got %s", minted.String())
	}
	if minted.Cmp(amount) > 0 {
		t.Fatalf("minted amount %s exceeds burned amount %s -- CCTP fee should only ever subtract", minted.String(), amount.String())
	}

	balanceAfter := mustUSDCBalance(t, ctx, arcClient, usdc, recipient)
	t.Logf("Arc USDC balance after: %s", balanceAfter.String())

	delta := new(big.Int).Sub(balanceAfter, balanceBefore)
	if delta.Cmp(minted) != 0 {
		t.Fatalf("Arc USDC balance delta %s does not equal Mint()'s reported minted amount %s", delta.String(), minted.String())
	}

	// Idempotency: submitting the same attestation twice must not double-mint.
	// CCTP's nonce-consumption on MessageTransmitterV2 rejects the replay.
	if _, _, err := provider.Mint(ctx, attestation); err == nil {
		t.Fatal("Mint() called twice with the same attestation must fail on the second call (CCTP nonce reuse) -- got nil error, possible double-mint")
	} else {
		t.Logf("Confirmed idempotent: second Mint() call for the same attestation correctly failed: %v", err)
	}
}
