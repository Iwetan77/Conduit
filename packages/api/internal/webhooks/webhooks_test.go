package webhooks

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/kzn-labs/conduit/api/internal/db"
	"github.com/kzn-labs/conduit/api/internal/models"
)

func TestSignVerify_RoundTrip(t *testing.T) {
	secret := "whsec_test123"
	body := []byte(`{"type":"settlement.succeeded"}`)
	sig := Sign(secret, time.Now(), body)
	if err := Verify(secret, sig, body, time.Now()); err != nil {
		t.Fatalf("Verify failed on a signature we just signed: %v", err)
	}
}

func TestVerify_RejectsWrongSecret(t *testing.T) {
	body := []byte(`{"type":"x"}`)
	sig := Sign("whsec_a", time.Now(), body)
	if err := Verify("whsec_b", sig, body, time.Now()); err == nil {
		t.Fatal("expected Verify to reject a signature made with a different secret")
	}
}

func TestVerify_RejectsStaleTimestamp(t *testing.T) {
	secret := "whsec_test"
	body := []byte(`{"type":"x"}`)
	old := time.Now().Add(-10 * time.Minute)
	sig := Sign(secret, old, body)
	if err := Verify(secret, sig, body, time.Now()); err == nil {
		t.Fatal("expected Verify to reject a timestamp older than 300s")
	}
}

func TestVerify_RejectsTamperedBody(t *testing.T) {
	secret := "whsec_test"
	sig := Sign(secret, time.Now(), []byte(`{"amount":100}`))
	if err := Verify(secret, sig, []byte(`{"amount":999}`), time.Now()); err == nil {
		t.Fatal("expected Verify to reject a tampered body")
	}
}

// TestDispatcher_Enqueue_RealDelivery is a real, no-mocks test: real embedded
// Postgres, a real local HTTP listener standing in for "the merchant's
// webhook endpoint" (the one thing that's legitimately a local stand-in here
// -- we can't deliver to a URL we don't control in a test, but the HMAC
// verification on the receiving end is real code, the same Verify() a real
// merchant would run), and independently verifies the signature exactly like
// a receiver would.
func TestDispatcher_Enqueue_RealDelivery(t *testing.T) {
	ctx := context.Background()
	pool, cleanup, err := db.StartTestDB(ctx, 15436)
	if err != nil {
		t.Fatalf("StartTestDB: %v", err)
	}
	defer cleanup()

	received := make(chan struct {
		body []byte
		sig  string
	}, 1)
	listener := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		received <- struct {
			body []byte
			sig  string
		}{body, r.Header.Get("Conduit-Signature")}
		w.WriteHeader(http.StatusOK)
	}))
	defer listener.Close()

	accountID := models.NewID("acct")
	_, err = pool.Exec(ctx, `INSERT INTO accounts (id, name, settle_currency, settle_address, livemode) VALUES ($1,$2,$3,$4,$5)`,
		accountID, "Test", "USDC", "0x0000000000000000000000000000000000000001", false)
	if err != nil {
		t.Fatalf("insert account: %v", err)
	}

	secret, _ := NewSecret()
	endpointID := models.NewID("we")
	_, err = pool.Exec(ctx,
		`INSERT INTO webhook_endpoints (id, account_id, url, secret, enabled_events) VALUES ($1,$2,$3,$4,$5)`,
		endpointID, accountID, listener.URL, secret, []string{"settlement.succeeded"},
	)
	if err != nil {
		t.Fatalf("insert endpoint: %v", err)
	}

	d := NewDispatcher(pool)
	if err := d.Enqueue(ctx, accountID, "settlement.succeeded", map[string]any{"intent_id": "si_test", "tx_hash": "0xabc"}); err != nil {
		t.Fatalf("Enqueue: %v", err)
	}

	select {
	case got := <-received:
		// Independently verify the HMAC exactly like a real receiver would.
		if err := Verify(secret, got.sig, got.body, time.Now()); err != nil {
			t.Fatalf("received webhook failed independent HMAC verification: %v", err)
		}
		var payload map[string]any
		if err := json.Unmarshal(got.body, &payload); err != nil {
			t.Fatalf("payload not valid JSON: %v", err)
		}
		if payload["type"] != "settlement.succeeded" {
			t.Errorf("expected type=settlement.succeeded, got %v", payload["type"])
		}
	case <-time.After(5 * time.Second):
		t.Fatal("webhook was not delivered within 5s")
	}

	var delivered bool
	err = pool.QueryRow(ctx, `SELECT (delivered_at IS NOT NULL) FROM webhook_deliveries WHERE endpoint_id = $1`, endpointID).Scan(&delivered)
	if err != nil {
		t.Fatalf("query delivery row: %v", err)
	}
	if !delivered {
		t.Error("expected webhook_deliveries.delivered_at to be set after a successful delivery")
	}
}

func TestDispatcher_RetryOnFailure(t *testing.T) {
	ctx := context.Background()
	pool, cleanup, err := db.StartTestDB(ctx, 15437)
	if err != nil {
		t.Fatalf("StartTestDB: %v", err)
	}
	defer cleanup()

	failingServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer failingServer.Close()

	accountID := models.NewID("acct")
	pool.Exec(ctx, `INSERT INTO accounts (id, name, settle_currency, settle_address, livemode) VALUES ($1,$2,$3,$4,$5)`,
		accountID, "Test", "USDC", "0x0000000000000000000000000000000000000001", false)

	secret, _ := NewSecret()
	endpointID := models.NewID("we")
	pool.Exec(ctx, `INSERT INTO webhook_endpoints (id, account_id, url, secret, enabled_events) VALUES ($1,$2,$3,$4,$5)`,
		endpointID, accountID, failingServer.URL, secret, []string{"settlement.succeeded"})

	d := NewDispatcher(pool)
	if err := d.Enqueue(ctx, accountID, "settlement.succeeded", map[string]any{"x": 1}); err != nil {
		t.Fatalf("Enqueue: %v", err)
	}

	var attempt int
	var deliveredAt *time.Time
	var nextRetryAt *time.Time
	err = pool.QueryRow(ctx, `SELECT attempt, delivered_at, next_retry_at FROM webhook_deliveries WHERE endpoint_id = $1`, endpointID).
		Scan(&attempt, &deliveredAt, &nextRetryAt)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if deliveredAt != nil {
		t.Error("expected delivered_at to be NULL after a failed delivery")
	}
	if nextRetryAt == nil {
		t.Fatal("expected next_retry_at to be set for a retry per RetryLadder")
	}
	// RetryLadder[1] = 5s
	expectedNext := time.Now().Add(5 * time.Second)
	if nextRetryAt.After(expectedNext.Add(2*time.Second)) || nextRetryAt.Before(expectedNext.Add(-2*time.Second)) {
		t.Errorf("expected next_retry_at ~5s from now, got %v (now=%v)", nextRetryAt, time.Now())
	}
}
