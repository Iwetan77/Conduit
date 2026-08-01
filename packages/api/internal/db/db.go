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
	// Tuned for a serverless Postgres that bills for compute uptime (Neon
	// scales to zero after ~5 minutes idle, and the free plan is capped at
	// 100 CU-hours/month -- exceeding it suspends the database until the
	// next billing month). pgx's 30-minute default idle time would hold a
	// connection open long past that window and keep compute billing, so
	// idle connections are dropped well inside it. MinConns stays 0 so an
	// idle API holds nothing open at all.
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
