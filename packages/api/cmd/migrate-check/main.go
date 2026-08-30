// migrate-check proves the migrations are reversible.
//
// Every .up.sql in this repo is run constantly — the API migrates on boot and
// every test boots a fresh database. The .down.sql files are run essentially
// never, which means they are the only SQL here that is not continuously
// tested, and the day one of them matters is a day nobody wants to discover
// that it drops the wrong thing or fails outright.
//
// So: against a throwaway Postgres, run every migration up, then every one
// down, then every one up again — and compare the schema after the first up
// with the schema after the second. A down migration that forgets a constraint,
// an index, or a column leaves a difference that the round trip surfaces here
// rather than in an incident.
//
//	cd packages/api && go run ./cmd/migrate-check
//
// Exits 0 when the round trip is clean, non-zero with the difference otherwise.
package main

import (
	"context"
	"fmt"
	"log"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kzn-labs/conduit/api/internal/db"
)

// A port nothing else in this repo uses, so a running devserver or a parallel
// test package cannot collide with it.
const port = 15987

func main() {
	if err := run(); err != nil {
		log.Fatalf("migrate-check: %v", err)
	}
	fmt.Println("migrate-check: up -> down -> up is clean")
}

func run() error {
	ctx := context.Background()
	dir := db.MigrationsDir()

	databaseURL, stop, err := db.StartEmptyTestDB(port)
	if err != nil {
		return err
	}
	defer stop()

	fmt.Println("up (from empty)...")
	if err := db.Migrate(databaseURL, dir); err != nil {
		return fmt.Errorf("first up: %w", err)
	}
	first, err := snapshot(ctx, databaseURL)
	if err != nil {
		return fmt.Errorf("snapshot after first up: %w", err)
	}
	fmt.Printf("  %d schema objects\n", strings.Count(first, "\n"))

	fmt.Println("down (all the way)...")
	if err := db.MigrateDown(databaseURL, dir); err != nil {
		return fmt.Errorf("down: %w", err)
	}
	empty, err := snapshot(ctx, databaseURL)
	if err != nil {
		return fmt.Errorf("snapshot after down: %w", err)
	}
	// schema_migrations is golang-migrate's own bookkeeping table and survives a
	// full down by design — it is how the tool knows where it is. Anything else
	// left behind is a down migration that did not finish its job.
	if leftovers := strings.TrimSpace(empty); leftovers != "" {
		return fmt.Errorf("down left objects behind:\n%s", leftovers)
	}
	fmt.Println("  clean")

	fmt.Println("up again...")
	if err := db.Migrate(databaseURL, dir); err != nil {
		return fmt.Errorf("second up: %w", err)
	}
	second, err := snapshot(ctx, databaseURL)
	if err != nil {
		return fmt.Errorf("snapshot after second up: %w", err)
	}

	if first != second {
		return fmt.Errorf("the schema after a down/up round trip differs from the original:\n%s", diff(first, second))
	}
	fmt.Printf("  %d schema objects, identical\n", strings.Count(second, "\n"))
	return nil
}

// snapshot renders the public schema as a sorted, line-per-object string:
// columns with their types and nullability, check constraints with their
// expressions, and indexes with their definitions.
//
// Deliberately not pg_dump — it is not guaranteed present on the machine
// running this, and its output carries ordering and formatting noise that would
// make a clean round trip look dirty.
func snapshot(ctx context.Context, databaseURL string) (string, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return "", err
	}
	defer pool.Close()

	var lines []string

	add := func(query string) error {
		rows, err := pool.Query(ctx, query)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var line string
			if err := rows.Scan(&line); err != nil {
				return err
			}
			lines = append(lines, line)
		}
		return rows.Err()
	}

	// Columns. Types and nullability included, because a down/up that
	// resurrects a column as the wrong type or drops a NOT NULL is exactly the
	// failure this is looking for.
	if err := add(`
		SELECT format('column %s.%s %s %s%s',
		              c.table_name, c.column_name, c.data_type,
		              CASE WHEN c.is_nullable = 'NO' THEN 'NOT NULL' ELSE 'NULL' END,
		              COALESCE(' DEFAULT ' || c.column_default, ''))
		  FROM information_schema.columns c
		  JOIN information_schema.tables t
		    ON t.table_schema = c.table_schema AND t.table_name = c.table_name
		 WHERE c.table_schema = 'public'
		   AND t.table_type = 'BASE TABLE'
		   AND c.table_name <> 'schema_migrations'`); err != nil {
		return "", err
	}

	// Constraints, by definition rather than by name, so a constraint that comes
	// back under a different name still compares equal while one that comes back
	// with a different expression does not.
	if err := add(`
		SELECT format('constraint %s %s', rel.relname, pg_get_constraintdef(con.oid))
		  FROM pg_constraint con
		  JOIN pg_class rel ON rel.oid = con.conrelid
		  JOIN pg_namespace ns ON ns.oid = rel.relnamespace
		 WHERE ns.nspname = 'public'
		   AND rel.relname <> 'schema_migrations'`); err != nil {
		return "", err
	}

	if err := add(`
		SELECT format('index %s', indexdef)
		  FROM pg_indexes
		 WHERE schemaname = 'public'
		   AND tablename <> 'schema_migrations'`); err != nil {
		return "", err
	}

	sort.Strings(lines)
	if len(lines) == 0 {
		return "", nil
	}
	return strings.Join(lines, "\n") + "\n", nil
}

// diff reports what each side has that the other does not. Enough to name the
// migration at fault without printing two whole schemas.
func diff(before, after string) string {
	inAfter := map[string]bool{}
	for _, l := range strings.Split(after, "\n") {
		inAfter[l] = true
	}
	inBefore := map[string]bool{}
	for _, l := range strings.Split(before, "\n") {
		inBefore[l] = true
	}

	var out []string
	for _, l := range strings.Split(before, "\n") {
		if l != "" && !inAfter[l] {
			out = append(out, "  lost after round trip:  "+l)
		}
	}
	for _, l := range strings.Split(after, "\n") {
		if l != "" && !inBefore[l] {
			out = append(out, "  gained after round trip: "+l)
		}
	}
	return strings.Join(out, "\n")
}

