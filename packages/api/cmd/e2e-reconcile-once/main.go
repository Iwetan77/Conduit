// e2e-reconcile-once is the "reconcile command" GATE 3 step 7 calls for
// real: connects to an already-running Postgres (the one
// scripts/e2e-crosschain.sh's restarted devserver is using), runs
// ReconcileOrphanedBridges exactly once, and exits. This is what proves a
// bridge_transfers row left in attestation_pending/attested by a killed
// server process still gets completed server-side, without waiting on a
// production-sized staleness window or a background ticker's next tick.
package main

import (
	"context"
	"log"
	"os"
	"strconv"
	"time"

	"github.com/kzn-labs/conduit/api/internal/db"
	"github.com/kzn-labs/conduit/api/internal/server"
)

func main() {
	databaseURL := requireEnv("DATABASE_URL")
	arcRelayerKey := requireEnv("ARC_RELAYER_KEY")

	// 1s, not 0: ReconcileOrphanedBridges treats <=0 as "use the 45s
	// production default" (see bridge_reconciler.go), so this has to be a
	// small positive value to mean "reconcile anything that's had even a
	// moment without progress" rather than accidentally falling back to the
	// production window.
	staleAfter := 1 * time.Second
	if v := os.Getenv("CONDUIT_BRIDGE_STALE_AFTER_SECONDS"); v != "" {
		if secs, err := strconv.Atoi(v); err == nil {
			staleAfter = time.Duration(secs) * time.Second
		}
	}

	ctx := context.Background()
	pool, err := db.Connect(ctx, databaseURL)
	if err != nil {
		log.Fatalf("db connect: %v", err)
	}
	defer pool.Close()

	cfg := server.Config{
		Pool:             pool,
		StableFXKey:      envOr("STABLEFX_API_KEY", ""),
		StableFXBase:     envOr("STABLEFX_BASE_URL", "https://api-sandbox.circle.com"),
		ArcRPC:           envOr("ARC_RPC", "https://rpc.testnet.arc.network"),
		SolanaRPC:        envOr("SOLANA_RPC", "https://api.devnet.solana.com"),
		SolanaWS:         envOr("SOLANA_WS", "wss://api.devnet.solana.com"),
		ArcRelayerKey:    arcRelayerKey,
		BridgeStaleAfter: staleAfter,
	}
	bridgeH, err := server.NewBridgeHandler(cfg)
	if err != nil {
		log.Fatalf("build bridge handler: %v", err)
	}

	log.Printf("reconciling orphaned bridges (stale_after=%s)...", staleAfter)
	bridgeH.ReconcileOrphanedBridges(ctx)
	log.Printf("reconcile pass complete")
}

func requireEnv(name string) string {
	v := os.Getenv(name)
	if v == "" {
		log.Fatalf("missing required env var %s", name)
	}
	return v
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
