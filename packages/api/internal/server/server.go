// Package server assembles the chi router from handlers — extracted from
// cmd/api/main.go so integration tests can build the exact same router
// in-process against a test database, without spawning a subprocess.
package server

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/cors"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kzn-labs/conduit/api/internal/auth"
	bridgepkg "github.com/kzn-labs/conduit/api/internal/bridge"
	"github.com/kzn-labs/conduit/api/internal/fx"
	"github.com/kzn-labs/conduit/api/internal/handlers"
	"github.com/kzn-labs/conduit/api/internal/idempotency"
	"github.com/kzn-labs/conduit/api/internal/indexer"
	"github.com/kzn-labs/conduit/api/internal/webhooks"
)

type Config struct {
	Pool         *pgxpool.Pool
	StableFXKey  string
	StableFXBase string
	AppBaseURL   string

	// CCTP cross-chain inbound config. All optional -- if ArcRelayerKey is
	// empty, the bridge routes are not registered (same as before this
	// feature existed) rather than panicking on missing config.
	ArcRPC           string
	SolanaRPC        string
	SolanaWS         string
	ArcChainID       int64
	ArcRelayerKey    string
	BridgeStaleAfter time.Duration

	// Privy merchant auth. Both optional -- if either is empty, Privy login
	// is disabled and the dashboard falls back to sk_/pk_ key auth only
	// (same opt-in pattern as the bridge feature above).
	PrivyAppID           string
	PrivyVerificationKey string // ES256 public key, PEM
}

func New(cfg Config) http.Handler {
	stableFX := fx.NewStableFXProvider(cfg.StableFXBase, cfg.StableFXKey)
	dispatcher := webhooks.NewDispatcher(cfg.Pool)

	var privyVerifier *auth.PrivyVerifier
	if cfg.PrivyAppID != "" && cfg.PrivyVerificationKey != "" {
		var err error
		privyVerifier, err = auth.NewPrivyVerifier(cfg.PrivyAppID, cfg.PrivyVerificationKey)
		if err != nil {
			log.Printf("auth: Privy login disabled: %v", err)
		}
	}

	accountsH := &handlers.Accounts{Pool: cfg.Pool, PrivyVerifier: privyVerifier}
	apiKeysH := &handlers.ApiKeys{Pool: cfg.Pool}
	intentsH := &handlers.SettlementIntents{Pool: cfg.Pool, StableFX: stableFX, AppBaseURL: cfg.AppBaseURL, Webhooks: dispatcher}
	currenciesH := &handlers.Currencies{}
	webhookEndpointsH := &handlers.WebhookEndpoints{Pool: cfg.Pool, Dispatcher: dispatcher}
	balanceTxH := &handlers.BalanceTransactions{Pool: cfg.Pool}
	settlementsH := &handlers.Settlements{Pool: cfg.Pool}
	bridgeH, err := newBridgeHandler(cfg, stableFX, dispatcher)
	if err != nil {
		log.Printf("bridge: CCTP cross-chain inbound disabled: %v", err)
	}

	r := chi.NewRouter()
	// The app (packages/app) calls this API directly from browser JS on a
	// different origin/port -- a genuinely cross-origin request browsers
	// block without CORS headers. Most acute for the public payer-facing
	// routes (bridge/*, settlement_intents/:id/public), which by definition
	// are hit from a browser with no prior same-origin context at all. Found
	// this live-testing the payer page for real, not caught by any static
	// check. AllowedOrigins is a wildcard here because this is a testnet
	// product with no cookie-based auth to leak (API keys are bearer tokens
	// in a header, never sent implicitly) -- tighten to an explicit
	// allowlist before any mainnet/production deployment.
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Authorization", "Content-Type", "Idempotency-Key", "Conduit-Account"},
		AllowCredentials: false,
		MaxAge:           300,
	}))
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
		// Privy-authenticated account bootstrap: verifies the bearer token
		// itself (not gated by auth.Middleware, since a brand-new Privy user
		// has no account yet for the middleware to resolve) and upserts by
		// privy_user_id. Registered only when Privy is configured.
		if privyVerifier != nil {
			r.Post("/accounts/privy", accountsH.CreateFromPrivy)
		}

		// Public, minimal intent details for the payer surface (/pay/[id]) --
		// a payer landing on a bare payment link has no API key. Deliberately
		// exposes only amount/currency/status/source_chain/expiry, never
		// account_id/settle_address/reference/metadata.
		r.Get("/settlement_intents/{id}/public", intentsH.GetPublic)

		// Cross-chain bridge endpoints are deliberately unauthenticated: this
		// is the payer surface (see spec), and a Solana-side payer has no
		// Conduit API key or Arc wallet at all. Only registered when
		// ArcRelayerKey is configured -- see newBridgeHandler.
		if bridgeH != nil {
			r.Post("/settlement_intents/{id}/bridge/initiate", bridgeH.Initiate)
			r.Get("/settlement_intents/{id}/bridge/status", bridgeH.Status)
		}

		r.Group(func(r chi.Router) {
			r.Use(auth.Middleware(cfg.Pool, privyVerifier))
			r.Use(idempotency.Middleware(cfg.Pool))

			r.Get("/accounts", accountsH.List)
			r.Get("/accounts/{id}", accountsH.Get)
			r.Post("/accounts/sub", accountsH.CreateSub)
			r.Get("/api_keys", apiKeysH.List)

			r.Post("/settlement_intents", intentsH.Create)
			r.Get("/settlement_intents", intentsH.List)
			r.Get("/settlement_intents/{id}", intentsH.Get)
			r.Post("/settlement_intents/{id}/quote", intentsH.Quote)
			r.Post("/settlement_intents/{id}/prepare", intentsH.Prepare)
			r.Post("/settlement_intents/{id}/confirm", intentsH.Confirm)
			r.Post("/settlement_intents/{id}/cancel", intentsH.Cancel)

			r.Post("/webhook_endpoints", webhookEndpointsH.Create)
			r.Get("/webhook_endpoints", webhookEndpointsH.List)
			r.Get("/webhook_endpoints/{id}/deliveries", webhookEndpointsH.Deliveries)
			r.Post("/webhook_deliveries/{id}/replay", webhookEndpointsH.ReplayDelivery)

			r.Get("/settlements", settlementsH.List)
			r.Get("/settlements/{id}", settlementsH.Get)
			r.Get("/balance_transactions", balanceTxH.List)
			r.Get("/balance_transactions/export", balanceTxH.Export)
		})
	})

	return r
}

// NewBridgeHandler is newBridgeHandler exported for cmd/e2e-reconcile-once,
// which needs to build the exact same Bridge handler this package uses
// internally without spinning up a full HTTP server -- it only calls
// ReconcileOrphanedBridges once and exits. Builds its own StableFXProvider
// and Dispatcher from cfg rather than requiring the caller to construct them.
func NewBridgeHandler(cfg Config) (*handlers.Bridge, error) {
	stableFX := fx.NewStableFXProvider(cfg.StableFXBase, cfg.StableFXKey)
	dispatcher := webhooks.NewDispatcher(cfg.Pool)
	return newBridgeHandler(cfg, stableFX, dispatcher)
}

// newBridgeHandler builds the Circle Gateway funding handler. Returns a nil
// handler (and a descriptive error, logged not fatal) if ArcRelayerKey isn't
// configured -- cross-chain inbound is opt-in infrastructure, not required
// for the rest of the API to run.
func newBridgeHandler(cfg Config, stableFX *fx.StableFXProvider, dispatcher *webhooks.Dispatcher) (*handlers.Bridge, error) {
	if cfg.ArcRelayerKey == "" {
		return nil, errNoRelayerKey
	}
	key, err := crypto.HexToECDSA(strings.TrimPrefix(cfg.ArcRelayerKey, "0x"))
	if err != nil {
		return nil, err
	}
	solanaRPC := cfg.SolanaRPC
	if solanaRPC == "" {
		solanaRPC = "https://api.devnet.solana.com"
	}
	provider := bridgepkg.NewGatewayProvider(solanaRPC, crypto.PubkeyToAddress(key.PublicKey))
	return &handlers.Bridge{
		Pool: cfg.Pool, Provider: provider, StableFX: stableFX, Webhooks: dispatcher,
		RelayerKey: key, RelayerAddr: crypto.PubkeyToAddress(key.PublicKey),
		StaleAfter: cfg.BridgeStaleAfter,
	}, nil
}

var errNoRelayerKey = errors.New("ARC_RELAYER_KEY not configured")

// StartBackgroundWorkers runs the webhook retry sweeper (every 10s), the CCTP
// orphan reconciler (every 10s, if bridging is configured), and, if
// arcRPC/routerAddress are provided, the on-chain indexer — all block until
// ctx is cancelled. Call in a goroutine from cmd/api and cmd/devserver.
func StartBackgroundWorkers(ctx context.Context, pool *pgxpool.Pool, arcRPC, routerAddress string, bridgeCfg Config) {
	dispatcher := webhooks.NewDispatcher(pool)
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := dispatcher.RunRetrySweeper(ctx); err != nil {
					log.Printf("webhooks: retry sweeper error: %v", err)
				}
			}
		}
	}()

	if bridgeH, err := newBridgeHandler(bridgeCfg, fx.NewStableFXProvider(bridgeCfg.StableFXBase, bridgeCfg.StableFXKey), dispatcher); err == nil {
		go func() {
			ticker := time.NewTicker(10 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					bridgeH.ReconcileOrphanedBridges(ctx)
				}
			}
		}()
	}

	if arcRPC == "" || routerAddress == "" {
		return
	}
	go func() {
		client, err := ethclient.Dial(arcRPC)
		if err != nil {
			log.Printf("indexer: dial %s: %v — indexer disabled", arcRPC, err)
			return
		}
		ix, err := indexer.New(pool, client, common.HexToAddress(routerAddress))
		if err != nil {
			log.Printf("indexer: init: %v — indexer disabled", err)
			return
		}
		if err := ix.Run(ctx); err != nil && ctx.Err() == nil {
			log.Printf("indexer: Run exited: %v", err)
		}
	}()
}
