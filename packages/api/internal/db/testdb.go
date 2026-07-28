package db

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	embeddedpostgres "github.com/fergusstrange/embedded-postgres"
	"github.com/jackc/pgx/v5/pgxpool"
)

// StartTestDB boots a real, rootless Postgres instance (embedded-postgres —
// downloads and runs an actual postgres binary in user space, no system
// install or sudo required) on the given port, runs every migration against
// it, and returns a ready connection pool plus a shutdown func.
//
// This is what makes `go test ./...` and scripts/e2e.sh able to run against a
// real database without any pre-existing Postgres install — the constraint
// that blocked GATE 2 in this environment until this file existed.
func StartTestDB(ctx context.Context, port uint32) (*pgxpool.Pool, func(), error) {
	dbName := "conduit_test"

	// Each call gets its own runtime/data/binaries dir: go test runs different
	// packages' tests in parallel processes, and embedded-postgres's default
	// paths are shared/global — two instances racing on the same data
	// directory corrupts each other's cluster. Distinct ports alone aren't
	// enough to isolate them.
	tmpDir, err := os.MkdirTemp("", "conduit-embedded-pg-*")
	if err != nil {
		return nil, nil, fmt.Errorf("testdb: mkdir temp: %w", err)
	}

	// BinariesPath is left at its default (shared, downloaded once and cached
	// across runs) — only RuntimePath/DataPath need to be unique per instance,
	// since those are what two concurrent instances would otherwise collide on.
	pg := embeddedpostgres.NewDatabase(embeddedpostgres.DefaultConfig().
		Port(port).
		Username("conduit").
		Password("conduit").
		Database(dbName).
		RuntimePath(filepath.Join(tmpDir, "runtime")).
		DataPath(filepath.Join(tmpDir, "data")))

	if err := pg.Start(); err != nil {
		os.RemoveAll(tmpDir)
		return nil, nil, fmt.Errorf("testdb: start embedded postgres: %w", err)
	}

	databaseURL := fmt.Sprintf("postgres://conduit:conduit@localhost:%d/%s?sslmode=disable", port, dbName)

	if err := Migrate(databaseURL, migrationsDir()); err != nil {
		pg.Stop()
		os.RemoveAll(tmpDir)
		return nil, nil, fmt.Errorf("testdb: migrate: %w", err)
	}

	pool, err := Connect(ctx, databaseURL)
	if err != nil {
		pg.Stop()
		os.RemoveAll(tmpDir)
		return nil, nil, err
	}

	cleanup := func() {
		pool.Close()
		_ = pg.Stop()
		os.RemoveAll(tmpDir)
	}
	return pool, cleanup, nil
}

// migrationsDir resolves packages/api/migrations relative to this source
// file, so tests work regardless of the caller's working directory.
func migrationsDir() string {
	_, thisFile, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(thisFile), "..", "..", "migrations")
}
