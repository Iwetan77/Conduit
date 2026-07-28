package db

import (
	"context"
	"testing"
)

func TestMigrate_CreatesSchema(t *testing.T) {
	ctx := context.Background()
	pool, cleanup, err := StartTestDB(ctx, 15433)
	if err != nil {
		t.Fatalf("StartTestDB: %v", err)
	}
	defer cleanup()

	tables := []string{
		"accounts", "api_keys", "settlement_intents", "fx_trades",
		"settlements", "balance_transactions", "webhook_endpoints",
		"webhook_deliveries", "idempotency_keys", "indexer_checkpoint",
	}
	for _, table := range tables {
		var exists bool
		err := pool.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1)`,
			table,
		).Scan(&exists)
		if err != nil {
			t.Fatalf("query table %s: %v", table, err)
		}
		if !exists {
			t.Errorf("expected table %s to exist after migration", table)
		}
	}

	// NUMERIC(78,0) sanity: insert an 18-decimal-token-sized raw amount that
	// would silently overflow/truncate as a BIGINT, confirm it round-trips exactly.
	_, err = pool.Exec(ctx, `INSERT INTO accounts (id, name, settle_currency, settle_address, livemode) VALUES ($1,$2,$3,$4,$5)`,
		"acct_test", "Test Co", "USDC", "0x0000000000000000000000000000000000000001", false)
	if err != nil {
		t.Fatalf("insert account: %v", err)
	}

	hugeAmount := "123456789012345678901234567890123456789012345678901234567890" // 60 digits, well beyond int64
	_, err = pool.Exec(ctx,
		`INSERT INTO settlement_intents (id, account_id, amount, settle_currency, settle_address, status, expires_at, livemode)
		 VALUES ($1,$2,$3,$4,$5,'created', now() + interval '1 hour', false)`,
		"si_test", "acct_test", hugeAmount, "USDC", "0x0000000000000000000000000000000000000001",
	)
	if err != nil {
		t.Fatalf("insert settlement_intent with 60-digit amount: %v", err)
	}

	var readBack string
	err = pool.QueryRow(ctx, `SELECT amount::text FROM settlement_intents WHERE id = $1`, "si_test").Scan(&readBack)
	if err != nil {
		t.Fatalf("read back amount: %v", err)
	}
	if readBack != hugeAmount {
		t.Errorf("amount round-trip failed: got %s, want %s (this is exactly the bug BIGINT would cause)", readBack, hugeAmount)
	}
}
