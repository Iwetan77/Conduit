// devserver runs the full API stack against a real, embedded (rootless)
// Postgres instance — for local development and scripts/e2e.sh in
// environments without a pre-existing Postgres or Docker install.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kzn-labs/conduit/api/internal/db"
	"github.com/kzn-labs/conduit/api/internal/server"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// CONDUIT_DB_DATA_DIR, if set, points at a fixed (non-random,
	// not-removed-on-exit) Postgres data directory instead of a fresh
	// temp one. scripts/e2e-crosschain.sh uses this to hard-kill devserver
	// mid-bridge and restart it against the SAME database, so the orphan
	// reconciler has something real to recover -- see db.StartTestDBAt's
	// doc comment.
	var pool *pgxpool.Pool
	var cleanup func()
	var err error
	if dataDir := os.Getenv("CONDUIT_DB_DATA_DIR"); dataDir != "" {
		pool, cleanup, err = db.StartTestDBAt(ctx, 15999, dataDir)
	} else {
		pool, cleanup, err = db.StartTestDB(ctx, 15999)
	}
	if err != nil {
		log.Fatalf("start embedded postgres: %v", err)
	}
	defer cleanup()

	staleAfter := 45 * time.Second
	if v := os.Getenv("CONDUIT_BRIDGE_STALE_AFTER_SECONDS"); v != "" {
		if secs, convErr := strconv.Atoi(v); convErr == nil {
			staleAfter = time.Duration(secs) * time.Second
		}
	}

	cfg := server.Config{
		Pool:                 pool,
		StableFXKey:          loadStableFXKey(),
		StableFXBase:         envOr("STABLEFX_BASE_URL", "https://api-sandbox.circle.com"),
		AppBaseURL:           envOr("CONDUIT_APP_BASE_URL", "http://localhost:3000"),
		ArcRPC:               envOr("ARC_RPC", "https://rpc.testnet.arc.network"),
		SolanaRPC:            envOr("SOLANA_RPC", "https://api.devnet.solana.com"),
		SolanaWS:             envOr("SOLANA_WS", "wss://api.devnet.solana.com"),
		ArcRelayerKey:        os.Getenv("ARC_RELAYER_KEY"),
		BridgeStaleAfter:     staleAfter,
		PrivyAppID:           os.Getenv("PRIVY_APP_ID"),
		PrivyVerificationKey: os.Getenv("PRIVY_VERIFICATION_KEY"),
		CircleAPIKey:         loadCircleKey(),
		CircleBaseURL:        os.Getenv("CIRCLE_BASE_URL"),
	}
	handler := server.New(cfg)

	server.StartBackgroundWorkers(ctx, pool, cfg.ArcRPC, os.Getenv("CONDUIT_ROUTER_ADDRESS"), cfg)

	addr := ":" + envOr("PORT", "8080")
	srv := &http.Server{Addr: addr, Handler: handler, ReadHeaderTimeout: 5 * time.Second}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(shutdownCtx)
	}()

	log.Printf("conduit-api (devserver, embedded postgres) listening on %s", addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func loadStableFXKey() string {
	if v := os.Getenv("STABLEFX_API_KEY"); v != "" {
		return v
	}
	_, thisFile, _, _ := runtime.Caller(0)
	envPath := filepath.Join(filepath.Dir(thisFile), "..", "..", ".env")
	data, err := os.ReadFile(envPath)
	if err != nil {
		log.Fatalf("STABLEFX_API_KEY not set and %s not found: %v", envPath, err)
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "STABLEFX_API_KEY=") {
			return strings.TrimPrefix(line, "STABLEFX_API_KEY=")
		}
	}
	log.Fatalf("STABLEFX_API_KEY not found in %s", envPath)
	return ""
}

// loadCircleKey mirrors loadStableFXKey: env var first, then packages/api/.env,
// so the devserver picks up Circle Wallets without anything exported. Never
// fatal -- Circle is opt-in, and without a key those routes simply report
// "not configured" instead of the server refusing to start.
func loadCircleKey() string {
	if v := os.Getenv("CIRCLE_API_KEY"); v != "" {
		return v
	}
	_, thisFile, _, _ := runtime.Caller(0)
	data, err := os.ReadFile(filepath.Join(filepath.Dir(thisFile), "..", "..", ".env"))
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "CIRCLE_API_KEY=") {
			return strings.TrimSpace(strings.TrimPrefix(line, "CIRCLE_API_KEY="))
		}
	}
	return ""
}
