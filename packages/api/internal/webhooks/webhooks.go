// Package webhooks implements HMAC-signed event delivery per the v2 spec §2.8:
// Conduit-Signature: t=<unix>,v1=<hex> where v1 = HMAC-SHA256(secret, "<t>.<body>").
package webhooks

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kzn-labs/conduit/api/internal/httpx"
	"github.com/kzn-labs/conduit/api/internal/models"
)

// RetryLadder is the spec's exact retry schedule (§2.8): 0s, 5s, 30s, 2m,
// 10m, 1h, 6h, then dead-letter.
var RetryLadder = []time.Duration{
	0, 5 * time.Second, 30 * time.Second, 2 * time.Minute,
	10 * time.Minute, 1 * time.Hour, 6 * time.Hour,
}

func NewSecret() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return "whsec_" + hex.EncodeToString(buf), nil
}

// Sign returns the Conduit-Signature header value for a given body at time t.
func Sign(secret string, t time.Time, body []byte) string {
	ts := fmt.Sprintf("%d", t.Unix())
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts))
	mac.Write([]byte("."))
	mac.Write(body)
	v1 := hex.EncodeToString(mac.Sum(nil))
	return fmt.Sprintf("t=%s,v1=%s", ts, v1)
}

// Verify is what a webhook RECEIVER runs (also used by scripts/e2e.sh's local
// listener to independently check our own delivery). Rejects if |now-t| > 300s
// per spec, or if the HMAC doesn't match.
func Verify(secret string, header string, body []byte, now time.Time) error {
	var ts int64
	var v1 string
	if _, err := fmt.Sscanf(header, "t=%d,v1=%s", &ts, &v1); err != nil {
		return fmt.Errorf("malformed signature header")
	}
	age := now.Unix() - ts
	if age > 300 || age < -300 {
		return fmt.Errorf("signature timestamp outside 300s tolerance (age=%ds)", age)
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(fmt.Sprintf("%d", ts)))
	mac.Write([]byte("."))
	mac.Write(body)
	expected := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(expected), []byte(v1)) {
		return fmt.Errorf("signature mismatch")
	}
	return nil
}

type Dispatcher struct {
	pool   *pgxpool.Pool
	client *http.Client
}

func NewDispatcher(pool *pgxpool.Pool) *Dispatcher {
	return &Dispatcher{pool: pool, client: httpx.Client(10 * time.Second)}
}

// Enqueue creates a webhook_deliveries row for every endpoint on accountID
// subscribed to eventType, and attempts immediate delivery (attempt 0, the
// ladder's 0s entry). Failures are left for the retry sweeper (RunRetrySweeper)
// to pick up via next_retry_at.
func (d *Dispatcher) Enqueue(ctx context.Context, accountID, eventType string, payload any) error {
	body, err := json.Marshal(map[string]any{"type": eventType, "data": payload, "created": time.Now().Unix()})
	if err != nil {
		return err
	}

	rows, err := d.pool.Query(ctx,
		`SELECT id, url, secret FROM webhook_endpoints WHERE account_id = $1 AND $2 = ANY(enabled_events)`,
		accountID, eventType,
	)
	if err != nil {
		return err
	}
	defer rows.Close()

	type endpoint struct{ id, url, secret string }
	var endpoints []endpoint
	for rows.Next() {
		var e endpoint
		if err := rows.Scan(&e.id, &e.url, &e.secret); err != nil {
			return err
		}
		endpoints = append(endpoints, e)
	}

	for _, e := range endpoints {
		deliveryID := models.NewID("whd")
		_, err := d.pool.Exec(ctx,
			`INSERT INTO webhook_deliveries (id, endpoint_id, event_type, payload, attempt) VALUES ($1,$2,$3,$4,0)`,
			deliveryID, e.id, eventType, body,
		)
		if err != nil {
			return err
		}
		d.attempt(ctx, deliveryID, e.url, e.secret, body, 0)
	}
	return nil
}

// attempt performs a single delivery attempt and records the outcome. On
// failure, schedules the next attempt per RetryLadder (or dead-letters past
// the ladder's end).
func (d *Dispatcher) attempt(ctx context.Context, deliveryID, url, secret string, body []byte, attemptN int) {
	sig := Sign(secret, time.Now(), body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Conduit-Signature", sig)

	resp, err := d.client.Do(req)
	var statusCode int
	var respBody string
	if err == nil {
		statusCode = resp.StatusCode
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096)) // truncated, per spec
		respBody = string(b)
		resp.Body.Close()
	}

	delivered := err == nil && statusCode >= 200 && statusCode < 300
	if delivered {
		d.pool.Exec(ctx,
			`UPDATE webhook_deliveries SET attempt = $1, response_code = $2, response_body = $3, delivered_at = now() WHERE id = $4`,
			attemptN, statusCode, respBody, deliveryID,
		)
		return
	}

	nextAttempt := attemptN + 1
	if nextAttempt >= len(RetryLadder) {
		// Dead-letter: record the failed attempt, leave delivered_at NULL,
		// next_retry_at NULL — RunRetrySweeper won't pick it up again.
		d.pool.Exec(ctx,
			`UPDATE webhook_deliveries SET attempt = $1, response_code = $2, response_body = $3 WHERE id = $4`,
			attemptN, statusCode, respBody, deliveryID,
		)
		return
	}
	nextRetryAt := time.Now().Add(RetryLadder[nextAttempt])
	d.pool.Exec(ctx,
		`UPDATE webhook_deliveries SET attempt = $1, response_code = $2, response_body = $3, next_retry_at = $4 WHERE id = $5`,
		attemptN, statusCode, respBody, nextRetryAt, deliveryID,
	)
}

// Replay re-delivers a specific webhook_deliveries row on demand (manual
// replay endpoint, spec §2.5's POST /v1/webhook_deliveries/:id/replay).
func (d *Dispatcher) Replay(ctx context.Context, deliveryID string) error {
	var url, secret string
	var body []byte
	var attempt int
	err := d.pool.QueryRow(ctx,
		`SELECT we.url, we.secret, wd.payload, wd.attempt
		 FROM webhook_deliveries wd JOIN webhook_endpoints we ON we.id = wd.endpoint_id
		 WHERE wd.id = $1`,
		deliveryID,
	).Scan(&url, &secret, &body, &attempt)
	if err != nil {
		return err
	}
	d.attempt(ctx, deliveryID, url, secret, body, attempt)
	return nil
}

// RunRetrySweeper polls for deliveries past their next_retry_at and retries
// them. Call periodically (e.g. every 10s) from a goroutine in main.
func (d *Dispatcher) RunRetrySweeper(ctx context.Context) error {
	rows, err := d.pool.Query(ctx,
		`SELECT wd.id, we.url, we.secret, wd.payload, wd.attempt
		 FROM webhook_deliveries wd JOIN webhook_endpoints we ON we.id = wd.endpoint_id
		 WHERE wd.delivered_at IS NULL AND wd.next_retry_at IS NOT NULL AND wd.next_retry_at <= now()`,
	)
	if err != nil {
		return err
	}
	type job struct {
		id, url, secret string
		body            []byte
		attempt         int
	}
	var jobs []job
	for rows.Next() {
		var j job
		if err := rows.Scan(&j.id, &j.url, &j.secret, &j.body, &j.attempt); err != nil {
			rows.Close()
			return err
		}
		jobs = append(jobs, j)
	}
	rows.Close()

	for _, j := range jobs {
		d.attempt(ctx, j.id, j.url, j.secret, j.body, j.attempt)
	}
	return nil
}
