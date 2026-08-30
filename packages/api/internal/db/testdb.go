package db

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"

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
	// Each call gets its own runtime/data/binaries dir: go test runs different
	// packages' tests in parallel processes, and embedded-postgres's default
	// paths are shared/global — two instances racing on the same data
	// directory corrupts each other's cluster. Distinct ports alone aren't
	// enough to isolate them.
	tmpDir, err := os.MkdirTemp("", "conduit-embedded-pg-*")
	if err != nil {
		return nil, nil, fmt.Errorf("testdb: mkdir temp: %w", err)
	}
	return startTestDB(ctx, port, tmpDir, true)
}

// StartTestDBAt is StartTestDB with a caller-supplied, non-random data
// directory that is NOT removed on cleanup. This exists for
// scripts/e2e-crosschain.sh's orphan-recovery proof (GATE 3 step 7): it
// needs to hard-kill the devserver process mid-bridge and restart it
// pointed at the SAME database, so the bridge_transfers row a live session
// was driving is still there for the reconciler to find.
//
// A `kill -9` on the devserver process does NOT kill embedded-postgres's own
// postgres child process (it's a real forked OS process, not tied to the Go
// process's lifetime) -- it survives as an orphan, still bound to `port`,
// still holding the exact data a live session was writing. So on restart,
// this does NOT try to start a second embedded-postgres instance (which
// would collide on the port and either fail or, worse, silently reinit an
// empty cluster) -- it first checks whether something is already listening
// on `port` and, if so, just connects to that survivor instead. Found this
// the hard way running scripts/e2e-crosschain.sh for real: the first attempt
// at this function unconditionally called pg.Start(), which either failed
// outright ("process already listening on port 15999") or masked that the
// orphaned instance -- holding the actual in-flight state -- was the one
// that mattered, not a fresh one.
func StartTestDBAt(ctx context.Context, port uint32, dataDir string) (*pgxpool.Pool, func(), error) {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, nil, fmt.Errorf("testdb: mkdir %s: %w", dataDir, err)
	}
	if pool, err := tryConnectExisting(ctx, port); err == nil {
		// Reuse: don't touch the running postgres, don't remove dataDir.
		return pool, func() { pool.Close() }, nil
	}
	return startTestDB(ctx, port, dataDir, false)
}

// tryConnectExisting checks whether a Postgres instance is already up and
// reachable on `port` with our standard conduit_test credentials, returning
// a connected pool if so.
func tryConnectExisting(ctx context.Context, port uint32) (*pgxpool.Pool, error) {
	databaseURL := fmt.Sprintf("postgres://conduit:conduit@localhost:%d/conduit_test?sslmode=disable", port)
	pingCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	pool, err := Connect(pingCtx, databaseURL)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}

// StartEmptyTestDB boots a real Postgres with NO migrations applied, returning
// its URL and a shutdown func.
//
// Everything else here hands back an already-migrated database, which is what a
// test wants and exactly what cmd/migrate-check cannot use: it has to run the
// migrations itself, in both directions, to find out whether they work.
func StartEmptyTestDB(port uint32) (string, func(), error) {
	tmpDir, err := os.MkdirTemp("", "conduit-embedded-pg-*")
	if err != nil {
		return "", nil, fmt.Errorf("testdb: mkdir temp: %w", err)
	}
	return startEmptyPostgres(port, tmpDir, true)
}

// startEmptyPostgres boots the server and returns its URL. No migrations.
func startEmptyPostgres(port uint32, tmpDir string, removeOnCleanup bool) (string, func(), error) {
	const dbName = "conduit_test"

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

	removeIfConfigured := func() {
		if removeOnCleanup {
			os.RemoveAll(tmpDir)
		}
	}

	if err := pg.Start(); err != nil {
		removeIfConfigured()
		return "", nil, fmt.Errorf("testdb: start embedded postgres: %w", err)
	}

	databaseURL := fmt.Sprintf("postgres://conduit:conduit@localhost:%d/%s?sslmode=disable", port, dbName)
	stop := func() {
		_ = pg.Stop()
		removeIfConfigured()
	}
	return databaseURL, stop, nil
}

func startTestDB(ctx context.Context, port uint32, tmpDir string, removeOnCleanup bool) (*pgxpool.Pool, func(), error) {
	databaseURL, stop, err := startEmptyPostgres(port, tmpDir, removeOnCleanup)
	if err != nil {
		return nil, nil, err
	}

	if err := Migrate(databaseURL, MigrationsDir()); err != nil {
		stop()
		return nil, nil, fmt.Errorf("testdb: migrate: %w", err)
	}

	pool, err := Connect(ctx, databaseURL)
	if err != nil {
		stop()
		return nil, nil, err
	}

	cleanup := func() {
		pool.Close()
		stop()
	}
	return pool, cleanup, nil
}

// MigrationsDir resolves packages/api/migrations relative to this source
// file, so callers work regardless of their working directory.
func MigrationsDir() string {
	_, thisFile, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(thisFile), "..", "..", "migrations")
}
