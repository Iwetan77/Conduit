package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/kzn-labs/conduit/api/internal/auth"
	"github.com/kzn-labs/conduit/api/internal/db"
	"github.com/kzn-labs/conduit/api/internal/server"
)

func main() {
	// Resolve the session secret first, so a weak or missing one is a startup
	// failure rather than something discovered at the first sign-in.
	auth.CheckSessionSecret()

	databaseURL := requireEnv("DATABASE_URL")
	stableFXKey := loadStableFXKey()
	appBaseURL := envOr("CONDUIT_APP_BASE_URL", "http://localhost:3000")
	stableFXBase := envOr("STABLEFX_BASE_URL", "https://api-sandbox.circle.com")
	addr := envOr("PORT", "8080")

	migrationsDir := findMigrationsDir()
	if err := db.Migrate(databaseURL, migrationsDir); err != nil {
		log.Fatalf("migrate: %v", err)
	}

	ctx := context.Background()
	pool, err := db.Connect(ctx, databaseURL)
	if err != nil {
		log.Fatalf("db connect: %v", err)
	}
	defer pool.Close()

	cfg := server.Config{
		Pool: pool, StableFXKey: stableFXKey, StableFXBase: stableFXBase, AppBaseURL: appBaseURL,
		ArcRPC:        envOr("ARC_RPC", "https://rpc.testnet.arc.network"),
		SolanaRPC:     envOr("SOLANA_RPC", "https://api.devnet.solana.com"),
		SolanaWS:      envOr("SOLANA_WS", "wss://api.devnet.solana.com"),
		ArcRelayerKey: os.Getenv("ARC_RELAYER_KEY"),
		CircleAPIKey:  loadCircleKey(),
		CircleBaseURL: os.Getenv("CIRCLE_BASE_URL"),
	}
	handler := server.New(cfg)

	server.StartBackgroundWorkers(ctx, pool, cfg.ArcRPC, os.Getenv("CONDUIT_ROUTER_ADDRESS"), cfg)

	log.Printf("conduit-api listening on :%s", addr)
	srv := &http.Server{Addr: ":" + addr, Handler: handler, ReadHeaderTimeout: 5 * time.Second}
	log.Fatal(srv.ListenAndServe())
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

// loadStableFXKey checks the env var first, then packages/api/.env directly —
// same pattern as scripts/stablefx-probe.ts and internal/fx's test loader, so
// `go run ./cmd/api` works without requiring the shell to export it first.
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

// runtime.Caller returns the path this file had at BUILD time, which does
// not exist inside a container image — migrations would fail to load on any
// real deployment. CONDUIT_MIGRATIONS_DIR is the deployment override (the
// Dockerfile copies migrations to /migrations); the source-relative path
// stays as the local-development default.
func findMigrationsDir() string {
	if dir := strings.TrimSpace(os.Getenv("CONDUIT_MIGRATIONS_DIR")); dir != "" {
		return dir
	}
	_, thisFile, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(thisFile), "..", "..", "migrations")
}

// loadCircleKey mirrors loadStableFXKey: env var first, then packages/api/.env,
// so `go run ./cmd/api` works without exporting anything. Unlike StableFX this
// never fatals — Circle Wallets are opt-in, and a deployment without the key
// simply doesn't serve those routes.
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
