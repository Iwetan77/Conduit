package server

import (
	"context"
	"testing"

	"github.com/kzn-labs/conduit/api/internal/db"
)

// Privy was removed from this codebase in Phase 7 of the Circle migration, but
// these tests stay. They cover the DATA, not the provider: accounts.auth_provider
// can still read 'privy' on rows created before the cutover, migration 0014's
// backfill is what put it there, and the lookup must keep resolving those rows
// by (auth_provider, auth_subject) rather than by subject alone. Deleting these
// with the Privy code would drop the only proof that existing merchants survive
// the migration.
//
// TestAuthIdentityBackfill: migration 0014 must move every existing Privy
// merchant onto the provider-agnostic columns without touching anything else.
//
// This runs the real migration set against a real Postgres, so it also proves
// 0014 applies cleanly on top of 0005 — which matters more than usual here,
// because migrations run on API boot and a bad one means the service does not
// start at all.
func TestAuthIdentityBackfill(t *testing.T) {
	ctx := context.Background()
	pool, cleanup, err := db.StartTestDB(ctx, 15513)
	if err != nil {
		t.Fatalf("StartTestDB: %v", err)
	}
	defer cleanup()

	// A merchant that existed before 0014, written the old way.
	if _, err := pool.Exec(ctx,
		`INSERT INTO accounts (id, name, settle_currency, settle_address, privy_user_id, login_wallet, livemode)
		 VALUES ('acct_old','Old Co','EUR','0x00000000000000000000000000000000000000A1','did:privy:legacy','0x00000000000000000000000000000000000000A1',false)`,
	); err != nil {
		t.Fatalf("seed legacy account: %v", err)
	}

	// Re-run the backfill exactly as the migration does. (The migration itself
	// already ran at StartTestDB, before this row existed — running the same
	// statement is what lets the assertion below test the STATEMENT rather than
	// the ordering of this test.)
	if _, err := pool.Exec(ctx,
		`UPDATE accounts SET auth_provider = 'privy', auth_subject = privy_user_id
		 WHERE privy_user_id IS NOT NULL AND auth_subject IS NULL`,
	); err != nil {
		t.Fatalf("backfill: %v", err)
	}

	var provider, subject string
	if err := pool.QueryRow(ctx,
		`SELECT auth_provider, auth_subject FROM accounts WHERE id = 'acct_old'`,
	).Scan(&provider, &subject); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if provider != "privy" || subject != "did:privy:legacy" {
		t.Errorf("backfill produced %s/%s, want privy/did:privy:legacy", provider, subject)
	}

	// API-key-only accounts never had a Privy identity and must not acquire one.
	if _, err := pool.Exec(ctx,
		`INSERT INTO accounts (id, name, settle_currency, settle_address, livemode)
		 VALUES ('acct_apikey','Key Co','USD','0x00000000000000000000000000000000000000A2',false)`,
	); err != nil {
		t.Fatalf("seed api-key account: %v", err)
	}
	var nullProvider, nullSubject *string
	if err := pool.QueryRow(ctx,
		`SELECT auth_provider, auth_subject FROM accounts WHERE id = 'acct_apikey'`,
	).Scan(&nullProvider, &nullSubject); err != nil {
		t.Fatalf("read api-key account: %v", err)
	}
	if nullProvider != nil || nullSubject != nil {
		t.Errorf("api-key account gained an identity: %v/%v", nullProvider, nullSubject)
	}
}

// TestAuthIdentityIsScopedByProvider is the reason the unique index is on the
// PAIR and not on the subject alone.
//
// During the cutover both providers are live. A subject string is only unique
// within the provider that issued it, so if two providers ever mint the same
// string, a lookup keyed on subject alone would hand a caller somebody else's
// account. That is the worst failure this migration could introduce, so it gets
// a test rather than a comment.
func TestAuthIdentityIsScopedByProvider(t *testing.T) {
	ctx := context.Background()
	pool, cleanup, err := db.StartTestDB(ctx, 15514)
	if err != nil {
		t.Fatalf("StartTestDB: %v", err)
	}
	defer cleanup()

	const collidingSubject = "user-123"

	for _, a := range []struct{ id, provider, addr string }{
		{"acct_p", "privy", "0x00000000000000000000000000000000000000B1"},
		{"acct_c", "circle", "0x00000000000000000000000000000000000000B2"},
	} {
		if _, err := pool.Exec(ctx,
			`INSERT INTO accounts (id, name, settle_currency, settle_address, auth_provider, auth_subject, livemode)
			 VALUES ($1,$1,'USD',$2,$3,$4,false)`,
			a.id, a.addr, a.provider, collidingSubject,
		); err != nil {
			t.Fatalf("insert %s: %v", a.provider, err)
		}
	}

	// Same subject, different providers: two distinct accounts, each resolving
	// only to its own.
	for _, tc := range []struct{ provider, wantID string }{
		{"privy", "acct_p"},
		{"circle", "acct_c"},
	} {
		var id string
		if err := pool.QueryRow(ctx,
			`SELECT id FROM accounts WHERE auth_provider = $1 AND auth_subject = $2`,
			tc.provider, collidingSubject,
		).Scan(&id); err != nil {
			t.Fatalf("lookup %s: %v", tc.provider, err)
		}
		if id != tc.wantID {
			t.Errorf("%s/%s resolved to %s, want %s", tc.provider, collidingSubject, id, tc.wantID)
		}
	}

	// And the pair itself is still unique — one account per identity.
	_, err = pool.Exec(ctx,
		`INSERT INTO accounts (id, name, settle_currency, settle_address, auth_provider, auth_subject, livemode)
		 VALUES ('acct_dup','Dup','USD','0x00000000000000000000000000000000000000B3','privy',$1,false)`,
		collidingSubject,
	)
	if err == nil {
		t.Error("duplicate (provider, subject) was accepted; the unique index is not doing its job")
	}
}
