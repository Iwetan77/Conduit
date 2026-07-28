// Package server assembles the chi router from handlers — extracted from
// cmd/api/main.go so integration tests can build the exact same router
// in-process against a test database, without spawning a subprocess.
package server

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kzn-labs/conduit/api/internal/auth"
	"github.com/kzn-labs/conduit/api/internal/fx"
	"github.com/kzn-labs/conduit/api/internal/handlers"
	"github.com/kzn-labs/conduit/api/internal/idempotency"
)

type Config struct {
	Pool          *pgxpool.Pool
	StableFXKey   string
	StableFXBase  string
	AppBaseURL    string
}

func New(cfg Config) http.Handler {
	stableFX := fx.NewStableFXProvider(cfg.StableFXBase, cfg.StableFXKey)

	accountsH := &handlers.Accounts{Pool: cfg.Pool}
	intentsH := &handlers.SettlementIntents{Pool: cfg.Pool, StableFX: stableFX, AppBaseURL: cfg.AppBaseURL}
	currenciesH := &handlers.Currencies{}

	r := chi.NewRouter()
	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })

	r.Route("/v1", func(r chi.Router) {
		// Unauthenticated: GET /v1/currencies is public reference data; POST
		// /v1/accounts is how you get your FIRST key (bootstrap) — the spec
		// doesn't say how account #0 is created without already having a key,
		// so this is a deliberate, documented choice: account creation is open,
		// everything else needs the key that creates it. Subaccounts (spec's
		// "Conduit-Account" header flow) still require an authenticated parent
		// account key — this only covers creating a brand new top-level account.
		r.Get("/currencies", currenciesH.List)
		r.Post("/accounts", accountsH.Create)

		r.Group(func(r chi.Router) {
			r.Use(auth.Middleware(cfg.Pool))
			r.Use(idempotency.Middleware(cfg.Pool))

			r.Get("/accounts", accountsH.List)
			r.Get("/accounts/{id}", accountsH.Get)

			r.Post("/settlement_intents", intentsH.Create)
			r.Get("/settlement_intents/{id}", intentsH.Get)
			r.Post("/settlement_intents/{id}/quote", intentsH.Quote)
			r.Post("/settlement_intents/{id}/cancel", intentsH.Cancel)
		})
	})

	return r
}
