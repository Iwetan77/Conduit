// e2e-solana-signer plays "the payer's Solana wallet" for
// scripts/e2e-crosschain.sh -- in production this signing happens
// client-side (Phase 4's /pay/[id] UI, a real browser wallet); this exists
// only so the e2e test can exercise the full real burn without one. Mirrors
// packages/contracts/script/sign-typed-data.mjs's role for the Arc side of
// the same test. Reuses exactly the PartialSign + submit pattern already
// proven against real devnet in internal/bridge/solana_arc_live_test.go --
// deliberately not a second implementation to debug from scratch.
//
// Usage: e2e-solana-signer <solanaKeypairJsonPath> < unsignedTxBase64
// Prints the burn transaction signature (base58) to stdout.
package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"time"

	solanago "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	sendandconfirmtransaction "github.com/gagliardetto/solana-go/rpc/sendAndConfirmTransaction"
	"github.com/gagliardetto/solana-go/rpc/ws"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: e2e-solana-signer <solanaKeypairJsonPath> < unsignedTxBase64")
		os.Exit(1)
	}
	keypairPath := os.Args[1]

	unsignedTxBytes, err := io.ReadAll(os.Stdin)
	fatalIf(err, "read stdin")
	unsignedTxBase64 := trimNewline(string(unsignedTxBytes))

	payerKey, err := solanago.PrivateKeyFromSolanaKeygenFile(keypairPath)
	fatalIf(err, "load Solana keypair")

	tx, err := solanago.TransactionFromBase64(unsignedTxBase64)
	fatalIf(err, "decode unsigned burn tx")

	if _, err := tx.PartialSign(func(key solanago.PublicKey) *solanago.PrivateKey {
		if key.Equals(payerKey.PublicKey()) {
			return &payerKey
		}
		return nil
	}); err != nil {
		fatalIf(err, "payer sign burn tx")
	}
	fatalIf(tx.VerifySignatures(), "verify signatures after payer signs")

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	rpcClient := rpc.New("https://api.devnet.solana.com")
	wsClient, err := ws.Connect(ctx, "wss://api.devnet.solana.com")
	fatalIf(err, "connect Solana ws")
	defer wsClient.Close()

	sig, err := sendandconfirmtransaction.SendAndConfirmTransaction(ctx, rpcClient, wsClient, tx)
	fatalIf(err, "submit+confirm burn tx")

	fmt.Print(sig.String())
}

func trimNewline(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r') {
		s = s[:len(s)-1]
	}
	return s
}

func fatalIf(err error, context string) {
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s: %v\n", context, err)
		os.Exit(1)
	}
}
