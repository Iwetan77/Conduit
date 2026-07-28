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
	"strings"
	"syscall"
	"time"

	"github.com/kzn-labs/conduit/api/internal/db"
	"github.com/kzn-labs/conduit/api/internal/server"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, cleanup, err := db.StartTestDB(ctx, 15999)
	if err != nil {
		log.Fatalf("start embedded postgres: %v", err)
	}
	defer cleanup()

	handler := server.New(server.Config{
		Pool:         pool,
		StableFXKey:  loadStableFXKey(),
		StableFXBase: envOr("STABLEFX_BASE_URL", "https://api-sandbox.circle.com"),
		AppBaseURL:   envOr("CONDUIT_APP_BASE_URL", "http://localhost:3000"),
	})

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
