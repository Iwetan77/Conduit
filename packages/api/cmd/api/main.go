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

	"github.com/kzn-labs/conduit/api/internal/db"
	"github.com/kzn-labs/conduit/api/internal/server"
)

func main() {
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

	handler := server.New(server.Config{
		Pool: pool, StableFXKey: stableFXKey, StableFXBase: stableFXBase, AppBaseURL: appBaseURL,
	})

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

func findMigrationsDir() string {
	_, thisFile, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(thisFile), "..", "..", "migrations")
}
