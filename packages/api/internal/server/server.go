// Package server assembles the chi router from handlers — extracted from
// cmd/api/main.go so integration tests can build the exact same router
// in-process against a test database, without spawning a subprocess.
package server

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
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
	// Server-side balance reads with a short cache. Keeps N browsers from
	// each fanning out their own RPC calls and tripping Arc's rate limiter.
	arcRPCForBalances := cfg.ArcRPC
	if arcRPCForBalances == "" {
		arcRPCForBalances = "https://rpc.testnet.arc.network"
	}
	intentsH := &handlers.SettlementIntents{Pool: cfg.Pool, StableFX: stableFX, AppBaseURL: cfg.AppBaseURL, Webhooks: dispatcher, ArcRPC: arcRPCForBalances}
	currenciesH := &handlers.Currencies{}
	fxRatesH := &handlers.FxRates{StableFX: stableFX}
	balancesH := &handlers.Balances{ArcRPC: arcRPCForBalances}
	// Server-side JSON-RPC relay to Arc. The browser points its RPC transport
	// here so reads and the embedded wallet's broadcast don't hit Arc's
	// Cloudflare-fronted public endpoint directly (which bot-blocks browsers).
	rpcProxyH := handlers.NewRPCProxy(arcRPCForBalances)
	webhookEndpointsH := &handlers.WebhookEndpoints{Pool: cfg.Pool, Dispatcher: dispatcher}
	balanceTxH := &handlers.BalanceTransactions{Pool: cfg.Pool}
	settlementsH := &handlers.Settlements{Pool: cfg.Pool}
	walletHistoryH := &handlers.WalletHistory{Pool: cfg.Pool}
	paymentLinksH := &handlers.PaymentLinks{Pool: cfg.Pool, AppBaseURL: cfg.AppBaseURL}
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
	// Explicit allowlist when CONDUIT_ALLOWED_ORIGINS is set (comma-separated,
	// e.g. "https://conduit.vercel.app"); wildcard only as the local/testnet
	// default. Bearer tokens are sent in a header and AllowCredentials is
	// false, so a wildcard leaks no ambient credentials — but a public
	// deployment should still name its origins rather than accept every site.
	allowedOrigins := []string{"*"}
	if raw := strings.TrimSpace(os.Getenv("CONDUIT_ALLOWED_ORIGINS")); raw != "" {
		allowedOrigins = nil
		for _, o := range strings.Split(raw, ",") {
			if o = strings.TrimSpace(o); o != "" {
				allowedOrigins = append(allowedOrigins, o)
			}
		}
	}
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   allowedOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Authorization", "Content-Type", "Idempotency-Key", "Conduit-Account"},
		AllowCredentials: false,
		MaxAge:           300,
	}))
	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })

	// (deploy pipeline restored via deploy-api Action + Render Deploy Hook)
	// Reports the deployed git commit so a deploy can be verified over HTTP
	// instead of squinting at the dashboard. RENDER_GIT_COMMIT is injected
	// by Render at build+runtime; it's a bare SHA (safe to interpolate).
	r.Get("/version", func(w http.ResponseWriter, r *http.Request) {
		commit := os.Getenv("RENDER_GIT_COMMIT")
		if commit == "" {
			commit = "unknown"
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"commit":"` + commit + `"}`))
	})

	r.Route("/v1", func(r chi.Router) {
		// Unauthenticated: GET /v1/currencies is public reference data; POST
		// /v1/accounts is how you get your FIRST key (bootstrap) — the spec
		// doesn't say how account #0 is created without already having a key,
		// so this is a deliberate, documented choice: account creation is open,
		// everything else needs the key that creates it. Subaccounts (spec's
		// "Conduit-Account" header flow) still require an authenticated parent
		// account key — this only covers creating a brand new top-level account.
		r.Get("/currencies", currenciesH.List)
		// Indicative FX rates, no state touched. Public so any payer surface can
		// show "you'll receive ≈ X" — and whether the pair routes at all, and
		// whether the amount clears the provider's minimum — BEFORE the payer
		// commits to a checkout. See handlers.FxRates.
		r.Get("/fx/rates", fxRatesH.Get)
		// Public: a payer has no API key, and this is read-only chain data.
		r.Get("/balances", balancesH.List)
		// Public JSON-RPC relay to Arc (method-allowlisted, fixed upstream).
		// No API key: reads are public chain data and a broadcast carries an
		// already-signed transaction. See handlers.RPCProxy.
		r.Post("/rpc", rpcProxyH.Handle)
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

		// Payment links: same "no API key" reasoning as the settlement_intent
		// public route above -- a payer opening a bare link/QR has no
		// credentials. GetPublic and Pay are the two payer-facing calls.
		r.Get("/payment_links/{id}/public", paymentLinksH.GetPublic)
		r.Post("/payment_links/{id}/pay", paymentLinksH.Pay)

		// Cross-currency FX for the payer surface. Same "no API key" reasoning
		// as the routes above: a payer opening a link or QR has no
		// credentials, and Circle StableFX is the ONLY working cross-currency
		// path (the old on-chain AMM route had no USDC/EURC pool on Arc and
		// could never settle). Scoped by intent ID, which is the capability.
		// Authenticated callers are still restricted to their own account --
		// see resolveIntentAccount. No funds move without the payer's own
		// wallet signature on the quote and funding payloads.
		// Direct send: a payer with a connected wallet and no account at all.
		// Creating an intent moves no money -- the payer still signs both
		// StableFX payloads themselves -- so this is open for the same reason
		// the routes above are. See SettlementIntents.CreateDirect.
		r.Post("/settlement_intents/direct", intentsH.CreateDirect)

		r.Post("/settlement_intents/{id}/quote", intentsH.Quote)
		r.Post("/settlement_intents/{id}/prepare", intentsH.Prepare)
		r.Post("/settlement_intents/{id}/confirm", intentsH.Confirm)
		// Same-currency direct pays settle on-chain in the payer's browser and
		// have no server step to mark them settled (unlike /confirm above and
		// the bridge path). This is that step: verifies the tx on Arc, records
		// the settlement, and fires the settlement.succeeded webhook. Same
		// "payer has no API key, intent id is the capability" reasoning.
		r.Post("/settlement_intents/{id}/record", intentsH.RecordDirectSettlement)

		// A payer's own cross-currency history. Unauthenticated by API key for
		// the same reason as the routes above -- a payer has none -- but gated
		// by a wallet signature instead, since this reads that wallet's own
		// settlement history rather than acting on their behalf. See
		// handlers.WalletHistory's doc comment for why this can't come from
		// an on-chain read the way same-currency history does.
		r.Post("/wallet_settlements", walletHistoryH.List)

		// Cross-chain bridge endpoints are deliberately unauthenticated: this
		// is the payer surface (see spec), and a Solana-side payer has no
		// Conduit API key or Arc wallet at all. Only registered when
		// ArcRelayerKey is configured -- see newBridgeHandler.
		if bridgeH != nil {
			r.Post("/settlement_intents/{id}/bridge/initiate", bridgeH.Initiate)
			r.Get("/settlement_intents/{id}/bridge/status", bridgeH.Status)
			r.Get("/settlement_intents/{id}/bridge/balance", bridgeH.Balance)
			// Client-side UBK spend path (option B): the browser drives Circle's
			// SDK across any supported source chain, then reports the Gateway
			// transfer id here for the server to poll + settle.
			r.Get("/settlement_intents/{id}/bridge/plan", bridgeH.Plan)
			r.Post("/settlement_intents/{id}/bridge/report_spend", bridgeH.ReportClientSpend)
		}

		r.Group(func(r chi.Router) {
			r.Use(auth.Middleware(cfg.Pool, privyVerifier))
			r.Use(idempotency.Middleware(cfg.Pool))

			r.Get("/accounts", accountsH.List)
			r.Get("/accounts/me", accountsH.Me)
			r.Get("/accounts/{id}", accountsH.Get)
			r.Patch("/accounts/{id}", accountsH.Update)
			r.Post("/accounts/sub", accountsH.CreateSub)
			r.Get("/api_keys", apiKeysH.List)

			r.Post("/settlement_intents", intentsH.Create)
			r.Get("/settlement_intents", intentsH.List)
			r.Get("/settlement_intents/{id}", intentsH.Get)
			r.Post("/settlement_intents/{id}/cancel", intentsH.Cancel)

			r.Post("/webhook_endpoints", webhookEndpointsH.Create)
			r.Get("/webhook_endpoints", webhookEndpointsH.List)
			r.Get("/webhook_endpoints/{id}/deliveries", webhookEndpointsH.Deliveries)
			r.Post("/webhook_deliveries/{id}/replay", webhookEndpointsH.ReplayDelivery)

			r.Get("/settlements", settlementsH.List)
			r.Get("/settlements/{id}", settlementsH.Get)

			r.Post("/payment_links", paymentLinksH.Create)
			r.Get("/payment_links", paymentLinksH.List)
			r.Get("/payment_links/{id}", paymentLinksH.Get)
			r.Post("/payment_links/{id}/void", paymentLinksH.Void)
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
	arcRPC := cfg.ArcRPC
	if arcRPC == "" {
		arcRPC = "https://rpc.testnet.arc.network"
	}
	return &handlers.Bridge{
		Pool: cfg.Pool, Provider: provider, StableFX: stableFX, Webhooks: dispatcher,
		RelayerKey: key, RelayerAddr: crypto.PubkeyToAddress(key.PublicKey),
		StaleAfter: cfg.BridgeStaleAfter,
		ArcRPC:     arcRPC,
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
