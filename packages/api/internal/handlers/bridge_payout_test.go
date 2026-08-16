package handlers

import (
	"context"
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kzn-labs/conduit/api/internal/db"
)

// The bridge pays merchants out of the relayer's own USDC float, on routes that
// need no credential. Two invariants keep that from being a faucet, and both
// are asserted here:
//
//   - a payout is never larger than what the funding transfer actually
//     delivered, so the relayer never covers a shortfall out of its own balance
//   - one Gateway transfer id funds one intent, so a single real transfer
//     cannot be reported against many intents and paid out each time
//
// Neither was true before: the payout was sized from settlement_intents.amount
// with nothing comparing it to the bridge, and idempotency was keyed on
// (intent_id, attestation), which said nothing about the same id appearing
// under a different intent.

func bridgeTestDB(t *testing.T, port uint32) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	pool, cleanup, err := db.StartTestDB(ctx, port)
	if err != nil {
		t.Fatalf("StartTestDB: %v", err)
	}
	t.Cleanup(cleanup)
	return pool
}

// seedIntent creates the minimum rows settleBridgedIntent reads.
func seedIntent(t *testing.T, pool *pgxpool.Pool, intentID, amount string) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx,
		`INSERT INTO accounts (id, name, settle_currency, settle_address, livemode)
		 VALUES ('acct_bridgetest','Bridge Test','USD','0x0000000000000000000000000000000000000009', false)
		 ON CONFLICT (id) DO NOTHING`); err != nil {
		t.Fatalf("seed account: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO settlement_intents (id, account_id, amount, settle_currency, settle_address, status, expires_at, livemode)
		 VALUES ($1,'acct_bridgetest',$2,'USD','0x0000000000000000000000000000000000000009','funding', now() + interval '1 hour', false)`,
		intentID, amount); err != nil {
		t.Fatalf("seed intent: %v", err)
	}
}

// A funding transfer that delivered less than the intent requires must not be
// settled. The relayer holds real USDC; topping up the difference out of it is
// the whole drain.
func TestUnderfundedIntentIsNotPaidOut(t *testing.T) {
	pool := bridgeTestDB(t, 15520)
	ctx := context.Background()

	seedIntent(t, pool, "si_underfunded", "100000000") // 100 USDC required

	h := &Bridge{
		Pool: pool,
		// No ArcRPC on purpose. If the guard fails to stop this, the settle
		// path tries to move real USDC and fails on the missing RPC instead --
		// so a passing test cannot be a payout that merely could not be sent.
		RelayerAddr: common.HexToAddress("0x00000000000000000000000000000000000000A1"),
	}

	funded := big.NewInt(40000000) // 40 USDC actually arrived
	err := h.settleBridgedIntent(ctx, "si_underfunded", funded)
	if err == nil {
		t.Fatal("underfunded intent settled; the relayer would have covered the shortfall")
	}
	if !strings.Contains(err.Error(), "underfunded") {
		t.Errorf("expected an underfunded error, got: %v", err)
	}

	var status string
	if err := pool.QueryRow(ctx,
		`SELECT status FROM settlement_intents WHERE id = 'si_underfunded'`).Scan(&status); err != nil {
		t.Fatalf("read status: %v", err)
	}
	if status == "settled" {
		t.Error("intent marked settled despite being underfunded")
	}
}

// Belt and braces on the same guard: no verified amount at all must never
// settle either. A nil here would otherwise mean "unknown", and unknown must
// not be treated as sufficient.
func TestSettleRefusesWithoutAVerifiedAmount(t *testing.T) {
	pool := bridgeTestDB(t, 15521)
	ctx := context.Background()

	seedIntent(t, pool, "si_noamount", "100000000")

	h := &Bridge{Pool: pool, RelayerAddr: common.HexToAddress("0x00000000000000000000000000000000000000A1")}

	for _, amt := range []*big.Int{nil, big.NewInt(0), big.NewInt(-1)} {
		err := h.settleBridgedIntent(ctx, "si_noamount", amt)
		if err == nil {
			t.Errorf("settled with funding amount %v; want refusal", amt)
			continue
		}
		// The refusal must be ABOUT the funding amount. Asserting only that
		// some error came back would pass against a build with no guard at
		// all, which fails later and incidentally -- on the missing Arc RPC --
		// after the decision to pay has already been made.
		if !strings.Contains(err.Error(), "no verified funding amount") {
			t.Errorf("funding amount %v refused for the wrong reason: %v", amt, err)
		}
	}
}

// One Gateway transfer id funds one intent. Enforced in the database, because
// the check that matters has to hold across concurrent reports as well as
// sequential ones.
func TestGatewayTransferIDCannotFundTwoIntents(t *testing.T) {
	pool := bridgeTestDB(t, 15522)
	ctx := context.Background()

	seedIntent(t, pool, "si_first", "100000000")
	seedIntent(t, pool, "si_second", "100000000")

	const sharedTransferID = "gateway-transfer-reused-once"

	if _, err := pool.Exec(ctx,
		`INSERT INTO bridge_transfers (id, intent_id, source_domain, dest_domain, burn_amount, attestation, state)
		 VALUES ('brg_first','si_first',5,26,'100000000',$1,'attested')`, sharedTransferID); err != nil {
		t.Fatalf("first report should be accepted: %v", err)
	}

	_, err := pool.Exec(ctx,
		`INSERT INTO bridge_transfers (id, intent_id, source_domain, dest_domain, burn_amount, attestation, state)
		 VALUES ('brg_second','si_second',5,26,'100000000',$1,'attested')`, sharedTransferID)
	if err == nil {
		t.Fatal("the same Gateway transfer id funded a second intent; one real transfer could settle many")
	}
	if !strings.Contains(err.Error(), "idx_bridge_transfers_attestation_unique") {
		t.Errorf("rejected, but not by the uniqueness index: %v", err)
	}

	// A repeat report against the SAME intent is still fine -- that is a retry,
	// and the handler resolves it to the existing row rather than inserting.
	var rowID string
	if err := pool.QueryRow(ctx,
		`SELECT id FROM bridge_transfers WHERE intent_id = 'si_first' AND attestation = $1`,
		sharedTransferID).Scan(&rowID); err != nil {
		t.Fatalf("retry lookup should find the original row: %v", err)
	}
	if rowID != "brg_first" {
		t.Errorf("retry resolved to %q, want brg_first", rowID)
	}

	// NULLs must not collide: rows exist before a transfer id is known.
	for _, id := range []string{"brg_null_a", "brg_null_b"} {
		if _, err := pool.Exec(ctx,
			`INSERT INTO bridge_transfers (id, intent_id, source_domain, dest_domain, burn_amount, state)
			 VALUES ($1,'si_first',5,26,'1','initiated')`, id); err != nil {
			t.Fatalf("partial index must allow multiple NULL attestations: %v", err)
		}
	}
}
