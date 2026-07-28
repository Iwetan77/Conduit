// Package handlers implements the public API endpoints (v2 spec §2.5).
package handlers

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	apierrors "github.com/kzn-labs/conduit/api/internal/errors"
	"github.com/kzn-labs/conduit/api/internal/idempotency"
)

// dbtx is the common subset of *pgxpool.Pool and pgx.Tx that handlers need.
// queryable(ctx, pool) returns the idempotency middleware's transaction when
// this request carried an Idempotency-Key, otherwise the plain pool — so a
// handler's writes always participate in that middleware's atomic
// execute+record transaction without every handler needing to know whether
// one is active.
type dbtx interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func queryable(ctx context.Context, pool *pgxpool.Pool) dbtx {
	if tx, ok := idempotency.TxFromContext(ctx); ok {
		return tx
	}
	return pool
}

func pathParam(r *http.Request, name string) string {
	return chi.URLParam(r, name)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, e *apierrors.APIError) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(e.Status)
	json.NewEncoder(w).Encode(map[string]any{"error": e})
}
