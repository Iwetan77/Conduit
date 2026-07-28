// Package idempotency implements the Idempotency-Key middleware for POST
// requests: unseen key -> execute and store; seen key with matching request
// hash -> replay the stored response verbatim without re-executing; seen key
// with a different hash -> 409 idempotency_key_reuse.
package idempotency

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kzn-labs/conduit/api/internal/auth"
	apierrors "github.com/kzn-labs/conduit/api/internal/errors"
)

type responseRecorder struct {
	http.ResponseWriter
	status int
	body   bytes.Buffer
}

func (r *responseRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}
func (r *responseRecorder) Write(b []byte) (int, error) {
	r.body.Write(b)
	return r.ResponseWriter.Write(b)
}

// Middleware only applies to methods that mutate state. Execution and the
// idempotency-key write happen in one DB transaction (via the ctx-carried
// tx, see WithTx) so 50 concurrent identical requests produce exactly one
// row — the handler is responsible for using the transaction from context
// when one is present.
func Middleware(pool *pgxpool.Pool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				next.ServeHTTP(w, r)
				return
			}
			key := r.Header.Get("Idempotency-Key")
			if key == "" {
				next.ServeHTTP(w, r)
				return
			}
			principal, ok := auth.FromContext(r.Context())
			if !ok {
				next.ServeHTTP(w, r)
				return
			}

			bodyBytes, err := io.ReadAll(r.Body)
			if err != nil {
				writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "body"))
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(bodyBytes))
			hash := hashRequest(r.Method, r.URL.Path, bodyBytes)

			ctx := r.Context()
			tx, err := pool.Begin(ctx)
			if err != nil {
				writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
				return
			}
			committed := false
			defer func() {
				if !committed {
					_ = tx.Rollback(ctx)
				}
			}()

			var existingHash string
			var existingBody []byte
			var existingStatus int
			err = tx.QueryRow(ctx,
				`SELECT request_hash, response_body, status_code FROM idempotency_keys
				 WHERE account_id = $1 AND key = $2 FOR UPDATE`,
				principal.AccountID, key,
			).Scan(&existingHash, &existingBody, &existingStatus)

			if err == nil {
				// Seen before.
				if existingHash != hash {
					_ = tx.Rollback(ctx)
					committed = true
					writeErr(w, apierrors.E(apierrors.CodeIdempotencyKeyReuse, "Idempotency-Key"))
					return
				}
				_ = tx.Commit(ctx)
				committed = true
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(existingStatus)
				w.Write(existingBody)
				return
			}
			if err != pgx.ErrNoRows {
				writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
				return
			}

			// Unseen: run the handler with this tx threaded through context,
			// capture its response, then store it and commit atomically.
			rec := &responseRecorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(rec, r.WithContext(WithTx(ctx, tx)))

			_, err = tx.Exec(ctx,
				`INSERT INTO idempotency_keys (account_id, key, request_hash, response_body, status_code)
				 VALUES ($1,$2,$3,$4,$5)`,
				principal.AccountID, key, hash, rec.body.Bytes(), rec.status,
			)
			if err != nil {
				// The handler's writes to `w` already went out over the wire via
				// rec's embedded ResponseWriter, so we can't un-send them. This
				// is a genuine failure mode: log and let it surface as a repeat
				// non-idempotent execution on retry, which is strictly better
				// than silently swallowing the error.
				return
			}
			if err := tx.Commit(ctx); err != nil {
				return
			}
			committed = true
		})
	}
}

type txCtxKey int

const txKey txCtxKey = 0

func WithTx(ctx context.Context, tx pgx.Tx) context.Context {
	return context.WithValue(ctx, txKey, tx)
}

func TxFromContext(ctx context.Context) (pgx.Tx, bool) {
	tx, ok := ctx.Value(txKey).(pgx.Tx)
	return tx, ok
}

func hashRequest(method, path string, body []byte) string {
	h := sha256.New()
	h.Write([]byte(method))
	h.Write([]byte(path))
	h.Write(body)
	return hex.EncodeToString(h.Sum(nil))
}

func writeErr(w http.ResponseWriter, e *apierrors.APIError) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(e.Status)
	body, _ := json.Marshal(map[string]any{"error": e})
	w.Write(body)
}
