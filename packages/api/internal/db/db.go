package db

import (
	"context"
	"fmt"
	"time"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	_ "github.com/golang-migrate/migrate/v4/source/file"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Connect opens a pgx connection pool. NUMERIC(78,0) columns are read back as
// pgtype.Numeric — callers must convert through our internal/models amount
// helpers rather than reading numbers directly, or precision silently drops.
func Connect(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("db: parse config: %w", err)
	}
	// Tuned for a serverless Postgres that bills for compute UPTIME rather than
	// for queries. Such a database suspends after a few minutes with no
	// connections, and pgx's 30-minute default idle time would hold one open
	// long past that window -- so an API doing nothing at all would keep the
	// compute awake and billing around the clock. Idle connections are dropped
	// well inside the suspend window, and MinConns stays 0 so an idle API holds
	// nothing open.
	//
	// This is not free: every first request after an idle period pays for the
	// database to wake, a few hundred milliseconds. That is the right trade
	// while uptime is the thing being billed. On a host that does NOT bill for
	// uptime (a fixed-size instance, or Supabase's free tier), raise MinConns to
	// 2 instead -- there the idle connection costs nothing and removes the wake
	// from the first request.
	//
	// CONNECTION STRING, if pointing this at Supabase: use the SESSION pooler
	// (port 5432 on the pooler host). The transaction pooler on 6543 does not
	// support prepared statements, which pgx uses by default, so the second
	// query on a connection fails with "prepared statement already exists". The
	// direct host is IPv6-only and may be unreachable from the API host.
	cfg.MaxConnIdleTime = 3 * time.Minute
	cfg.MaxConnLifetime = 30 * time.Minute
	cfg.HealthCheckPeriod = 1 * time.Minute
	cfg.MinConns = 0
	// Render's free instance is small; an unbounded pool would let a burst
	// open more server-side connections than either side handles well.
	cfg.MaxConns = 10

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("db: connect: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("db: ping: %w", err)
	}
	return pool, nil
}

// Migrate runs every pending migration in migrationsDir against databaseURL.
// Idempotent — safe to call on every boot.
func Migrate(databaseURL, migrationsDir string) error {
	m, err := migrate.New("file://"+migrationsDir, databaseURL)
	if err != nil {
		return fmt.Errorf("db: migrate init: %w", err)
	}
	defer m.Close()

	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		return fmt.Errorf("db: migrate up: %w", err)
	}
	return nil
}
