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
	"github.com/kzn-labs/conduit/api/internal/circle"
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

	// Circle Wallets. Optional on the same opt-in pattern: with no API key
	// the /auth/circle routes report "not configured" rather than failing
	// every call, so a deployment without it behaves exactly as before.
	CircleAPIKey  string
	CircleBaseURL string
}

// statusRecorder captures the status code so the request log can report it.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func New(cfg Config) http.Handler {
	stableFX := fx.NewStableFXProvider(cfg.StableFXBase, cfg.StableFXKey)
	dispatcher := webhooks.NewDispatcher(cfg.Pool)

	circleClient := circle.New(cfg.CircleBaseURL, cfg.CircleAPIKey)
	circleVerifier := auth.NewCircleVerifier(circleClient)
	accountsH := &handlers.Accounts{Pool: cfg.Pool, CircleVerifier: circleVerifier}
	apiKeysH := &handlers.ApiKeys{Pool: cfg.Pool}
	circleAuthH := &handlers.CircleAuth{
		Client: circleClient,
		// Arc plus every Circle-supported chain the cross-chain payer flow
		// offers as a source. Sonic, World Chain, Sei and HyperEVM appear in
		// that flow but Circle cannot hold a wallet on them, so a Circle user
		// simply cannot pay from those — a real gap, not an omission here.
		//
		// Adding to this list is safe now: Initialize drops a chain Circle
		// rejects and retries without it, so an identifier that turns out to be
		// wrong costs that one chain rather than every chain. It used to
		// collapse to Arc alone, which is why ETH-SEPOLIA sat out until the
		// retry was fixed.
		Blockchains: []string{
			"ARC-TESTNET",
			"ETH-SEPOLIA",
			"BASE-SEPOLIA",
			"MATIC-AMOY",
			"AVAX-FUJI",
			"ARB-SEPOLIA",
			"OP-SEPOLIA",
			"UNI-SEPOLIA",
		},
		FallbackBlockchains: []string{"ARC-TESTNET"},
	}
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
		AllowedOrigins: allowedOrigins,
		// PATCH is here because /v1/accounts/{id} is a PATCH and was unreachable
		// from the browser without it — the preflight answered without the
		// method, so the browser never sent the request and Settings' "Business
		// identity" could not be saved. Same failure mode as a missing header
		// below: nothing in the API log, because nothing arrived.
		AllowedMethods: []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		// X-Circle-User-Token is how the browser presents Circle's session on
		// the /auth/circle/* routes. Leaving it off this list does not produce
		// a 403 anywhere visible: the preflight answers 200 with no CORS
		// headers, and the browser refuses to send the real request at all.
		// The caller sees only "Failed to fetch", with nothing in the API log
		// because the request never arrived.
		AllowedHeaders:   []string{"Authorization", "Content-Type", "Idempotency-Key", "Conduit-Account", "X-Circle-User-Token"},
		AllowCredentials: false,
		MaxAge:           300,
	}))
	// Request log, on by default for the dev server and opt-in elsewhere.
	//
	// Added because a blank dashboard is indistinguishable from three different
	// causes -- requests not being made, requests being rejected, or requests
	// succeeding with no data -- and none of them were visible from either end.
	// Guessing between them is exactly the loop this project keeps paying for.
	if os.Getenv("CONDUIT_REQUEST_LOG") != "0" {
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				start := time.Now()
				rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
				next.ServeHTTP(rec, req)
				if strings.HasPrefix(req.URL.Path, "/v1/") {
					auth := "none"
					if req.Header.Get("X-Circle-User-Token") != "" {
						auth = "circle"
					} else if req.Header.Get("Authorization") != "" {
						auth = "bearer"
					}
					log.Printf("%s %s -> %d (%s, auth=%s)",
						req.Method, req.URL.Path, rec.status, time.Since(start).Round(time.Millisecond), auth)
				}
			})
		})
	}

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
		// Login bootstrap: verifies the credential itself (not gated by
		// auth.Middleware, since a brand-new user has no account yet for the
		// middleware to resolve) and upserts by (auth_provider, auth_subject).
		//
		// Registered unconditionally, never behind an "is the provider
		// configured" check. /accounts/privy used to be, and when this route
		// was first added it was nested in that same block by mistake -- so the
		// replacement for Privy existed only where Privy was configured, and
		// 404'd on exactly the deployments that had finished migrating. The
		// handler answers "not configured" itself when there is no Circle key.
		r.Post("/accounts/circle", accountsH.CreateFromCircle)

		// Circle Wallets: the browser cannot hold the Circle API key, so device
		// tokens and challenge ids are minted here. Unauthenticated for the same
		// reason /accounts/circle is -- the identity being established is the
		// point of the call.
		//
		// Registered unconditionally, NOT gated on a key being present. The
		// handler reports "not configured" on its own when there is no Circle
		// key.
		r.Post("/auth/circle/device", circleAuthH.StartLogin)
		r.Post("/auth/circle/initialize", circleAuthH.Initialize)
		r.Get("/auth/circle/wallets", circleAuthH.Wallets)
		r.Post("/auth/circle/sign_typed_data", circleAuthH.SignTypedData)
		r.Post("/auth/circle/sign_message", circleAuthH.SignMessage)
		r.Post("/auth/circle/contract_execution", circleAuthH.ContractExecution)
		r.Get("/auth/circle/transactions", circleAuthH.FindTransaction)
		r.Get("/auth/circle/transactions/{id}", circleAuthH.Transaction)

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
			r.Use(auth.Middleware(cfg.Pool, circleVerifier))
			r.Use(idempotency.Middleware(cfg.Pool))

			r.Get("/accounts", accountsH.List)
			r.Get("/accounts/me", accountsH.Me)
			r.Get("/accounts/{id}", accountsH.Get)
			r.Patch("/accounts/{id}", accountsH.Update)
			r.Post("/accounts/sub", accountsH.CreateSub)
			// The storefront's printed QR resolves to this link's hosted URL.
			r.Post("/accounts/{id}/storefront_link", paymentLinksH.StorefrontLink)
			r.Get("/api_keys", apiKeysH.List)
			// A storefront's own credential, for wiring a POS to it. The secret
			// is in the create response and nowhere else.
			r.Post("/accounts/{id}/api_keys", apiKeysH.Create)
			r.Post("/api_keys/{id}/revoke", apiKeysH.Revoke)

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
		// Without this the indexer would record an on-chain settlement and tell
		// the merchant nothing, while the same payment routed through the
		// confirm/record handlers fires settlement.succeeded.
		ix.Webhooks = dispatcher
		if err := ix.Run(ctx); err != nil && ctx.Err() == nil {
			log.Printf("indexer: Run exited: %v", err)
		}
	}()
}
