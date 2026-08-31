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
	"github.com/go-chi/chi/v5/middleware"
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

// The blockchain identifier Arc wallets carry, in Circle's own vocabulary.
//
// Read back from a real ListWallets response rather than assumed
// (docs/circle-wallet-capability.md). Named once because two places depend on
// it and they must not drift: the login path asks Circle to create wallets on
// it, and settlement provisioning refuses any wallet that is not on it. A
// settlement address on the wrong chain is a valid address that no payment can
// ever reach.
const arcBlockchain = "ARC-TESTNET"

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
	// Arc is named once, here, and shared with the login path below rather than
	// written out twice. A settlement wallet on the wrong chain is an address
	// that is valid and that no payment can ever reach, so the two places that
	// decide "is this Arc" must not be able to drift apart.
	settlementWalletH := &handlers.SettlementWallet{
		Pool:          cfg.Pool,
		Client:        circleClient,
		ArcBlockchain: arcBlockchain,
	}
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
			arcBlockchain,
			"ETH-SEPOLIA",
			"BASE-SEPOLIA",
			"MATIC-AMOY",
			"AVAX-FUJI",
			"ARB-SEPOLIA",
			"OP-SEPOLIA",
			"UNI-SEPOLIA",
		},
		FallbackBlockchains: []string{arcBlockchain},
	}
	// Server-side balance reads with a short cache. Keeps N browsers from
	// each fanning out their own RPC calls and tripping Arc's rate limiter.
	arcRPCForBalances := cfg.ArcRPC
	if arcRPCForBalances == "" {
		arcRPCForBalances = "https://rpc.testnet.arc.network"
	}
	// The router address the record route verifies against. Read from the
	// environment here for the same reason StartBackgroundWorkers does: it is
	// deployment configuration, and the indexer and the record route must agree
	// on which router is ours.
	routerAddr := strings.TrimSpace(os.Getenv("CONDUIT_ROUTER_ADDRESS"))
	// Unset, this does not degrade one feature -- it breaks paying and
	// recording, and it does both silently.
	//
	// The approval guard builds its allowlist from this value, so an empty one
	// matches nothing: every approve a Circle wallet asks for is refused, and
	// that reaches the payer as an opaque network error three layers from the
	// cause. Recording a direct settlement refuses for the same reason. Neither
	// failure names the variable, so it is worth one line at boot that does.
	if routerAddr == "" {
		log.Printf("config: CONDUIT_ROUTER_ADDRESS is not set — token approvals will be refused and " +
			"direct settlements will not be recorded. Set it to the deployed ConduitRouter address.")
	}
	intentsH := &handlers.SettlementIntents{
		Pool: cfg.Pool, StableFX: stableFX, AppBaseURL: cfg.AppBaseURL,
		Webhooks: dispatcher, ArcRPC: arcRPCForBalances,
		RouterAddr: routerAddr,
	}
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
	usernamesH := &handlers.Usernames{Pool: cfg.Pool}
	// Arc RPC is needed here for contract wallets: a multisig treasury holds no
	// key of its own and can only answer for a signature through EIP-1271.
	payoutDestinationsH := &handlers.PayoutDestinations{Pool: cfg.Pool, ArcRPC: arcRPCForBalances}
	payoutsH := &handlers.Payouts{Pool: cfg.Pool, ArcRPC: arcRPCForBalances}
	externalSettlementH := &handlers.ExternalSettlement{Pool: cfg.Pool}
	employeesH := &handlers.Employees{Pool: cfg.Pool}
	// The deployed ConduitPayroll. Unset, runs can be drafted and read but not
	// executed -- the same opt-in shape the bridge uses, so a deployment
	// without it degrades visibly rather than panicking.
	payrollContract := strings.TrimSpace(os.Getenv("CONDUIT_PAYROLL_ADDRESS"))
	if payrollContract == "" {
		log.Printf("config: CONDUIT_PAYROLL_ADDRESS is not set — payroll runs can be drafted but not executed.")
	}
	payrollRunsH := &handlers.PayrollRuns{
		Pool: cfg.Pool, Webhooks: dispatcher,
		ArcRPC: arcRPCForBalances, PayrollContract: payrollContract,
	}
	paymentLinksH := &handlers.PaymentLinks{Pool: cfg.Pool, AppBaseURL: cfg.AppBaseURL}
	bridgeH, err := newBridgeHandler(cfg, stableFX, dispatcher)
	if err != nil {
		log.Printf("bridge: CCTP cross-chain inbound disabled: %v", err)
	}

	// One limiter for the whole process, so a client cannot reset its budget by
	// moving between public routes.
	publicLimiter := newRateLimiter(publicRatePerSecond, publicBurst)
	// Separate bucket set, so a merchant's own traffic can never exhaust the
	// payer allowance or the other way round.
	authedLimiter := newRateLimiter(authedRatePerSecond, authedBurst)
	// Only honour X-Forwarded-For when an operator confirms a proxy is in front.
	// The header is caller-supplied; trusting it unconditionally would let
	// anyone bypass the limit by inventing an IP per request.
	trustProxyHeaders := os.Getenv("CONDUIT_TRUSTED_PROXY") != ""

	r := chi.NewRouter()
	// The app calls this API from browser JS on a different origin, so CORS is
	// load-bearing for the public payer routes (bridge/*, /public) -- they are
	// opened by a browser with no same-origin context at all.
	// Origins are named explicitly, or there are none.
	//
	// The wildcard used to be the default whenever CONDUIT_ALLOWED_ORIGINS was
	// unset, so a forgotten variable opened the API to every site on the
	// internet -- silently, on exactly the deployments nobody is watching.
	// Absence of configuration is not consent.
	//
	// The wildcard now requires someone to say CONDUIT_DEV=1, which is a
	// statement about the environment rather than an oversight. Without it and
	// without an allowlist, no cross-origin headers are served at all:
	// same-origin callers and server-side clients are unaffected (API keys are
	// bearer tokens in a header, never sent implicitly), and a browser on
	// another origin is refused. Logged loudly, because a real deployment
	// reaching that branch is misconfigured.
	var allowedOrigins []string
	if raw := strings.TrimSpace(os.Getenv("CONDUIT_ALLOWED_ORIGINS")); raw != "" {
		for _, o := range strings.Split(raw, ",") {
			if o = strings.TrimSpace(o); o != "" {
				allowedOrigins = append(allowedOrigins, o)
			}
		}
	} else if os.Getenv("CONDUIT_DEV") != "" {
		allowedOrigins = []string{"*"}
		log.Printf("cors: CONDUIT_DEV is set - allowing every origin. Never set this in production.")
	} else {
		log.Printf("cors: CONDUIT_ALLOWED_ORIGINS is not set - refusing cross-origin browser requests. " +
			"Set it to the app's origin, or set CONDUIT_DEV=1 for local development.")
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
	// Compression, before the request log so the log times the real response.
	//
	// Worth being accurate about the size of this win, because it is smaller
	// than it looks: production sits behind Render's edge, which ALREADY gzips
	// responses for clients that ask. Measured against the deployed API, the
	// browser-visible bytes were the same before and after this line
	// (/v1/currencies: 1074 raw, 486 gzipped, both ways). So this is not the
	// bandwidth saving it would appear to be from the numbers alone.
	//
	// What it does buy: the origin-to-edge hop is compressed rather than
	// shipping raw JSON, the origin emits its own Vary: Accept-Encoding so any
	// cache in front behaves correctly, and compression stops being something
	// the platform happens to do for us. A move off Render, or a client reaching
	// the origin directly, keeps it. Cheap insurance rather than a headline.
	//
	// Level 5 rather than the default: past there, gzip spends noticeably more
	// CPU for very little further size on JSON, and CPU is the thing actually
	// billed on the API host.
	r.Use(middleware.Compress(5))

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

	// Reports the deployed git commit so a deploy can be verified over HTTP
	// instead of squinting at the dashboard. RENDER_GIT_COMMIT is injected
	// by Render at build+runtime; it's a bare SHA (safe to interpolate).
	//
	// started_at is here because the commit alone cannot answer "did my push
	// deploy?". Two builds of the same commit are indistinguishable by SHA, so
	// a redeploy that succeeded and one that never ran look identical -- which
	// is exactly the question being asked whenever anyone loads this endpoint.
	// The process start time separates them: same commit with a newer start is
	// a deploy that happened.
	//
	// Formatted once at boot rather than per request: it is a constant for the
	// life of the process, and a handler that recomputes a constant is a
	// handler that can drift from the thing it is reporting.
	startedAt := time.Now().UTC().Format(time.RFC3339)
	r.Get("/version", func(w http.ResponseWriter, r *http.Request) {
		commit := os.Getenv("RENDER_GIT_COMMIT")
		if commit == "" {
			commit = "unknown"
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"commit":"` + commit + `","started_at":"` + startedAt + `"}`))
	})

	r.Route("/v1", func(r chi.Router) {
		// Rate limiting, on the unauthenticated routes ONLY.
		//
		// Everything in the authenticated group below already costs an attacker
		// an API key, and a key can be revoked. A payment link cannot: it is a
		// URL meant to be opened by strangers. Several routes in here spend real
		// money on our side -- a quote is a live StableFX call against our key --
		// so an unthrottled loop over one link URL burns provider quota we pay
		// for, whether or not it ever settles anything.
		//
		// Scoped as its own group rather than r.Use on /v1, which would have
		// covered the authenticated routes too and throttled a whole office
		// behind one NAT as if it were a single client. Scoping it structurally
		// also means a bogus Authorization header cannot skip the limiter --
		// which is what checking for one in the middleware would have allowed.
		r.Group(func(r chi.Router) {
			r.Use(rateLimit(publicLimiter, trustProxyHeaders))

			// Unauthenticated: GET /v1/currencies is public reference data; POST
			// /v1/accounts is how you get your FIRST key (bootstrap) — the spec
			// doesn't say how account #0 is created without already having a key,
			// so this is a deliberate, documented choice: account creation is open,
			// everything else needs the key that creates it. Subaccounts (spec's
			// "Conduit-Account" header flow) still require an authenticated parent
			// account key — this only covers creating a brand new top-level account.
			// Reference data that changes only on deploy. Long enough to matter,
			// with stale-while-revalidate so a refresh never blocks a payer.
			r.Get("/currencies", cacheFor("public, max-age=60, stale-while-revalidate=300", currenciesH.List))
			// Indicative FX rates, no state touched. Public so any payer surface can
			// show "you'll receive ≈ X" — and whether the pair routes at all, and
			// whether the amount clears the provider's minimum — BEFORE the payer
			// commits to a checkout. See handlers.FxRates.
			// Two seconds, matching fxRateCacheTTL exactly. A quote promised as
			// fresher than the server holds it would be priced on nothing.
			r.Get("/fx/rates", cacheFor("public, max-age=2", fxRatesH.Get))
			// Public: a payer has no API key, and this is read-only chain data.
			// PRIVATE, not public: this is one address's money, and a shared cache
			// holding it would serve one payer's balance to another. Ten seconds
			// matches balanceCacheTTL.
			r.Get("/balances", cacheFor("private, max-age=10", balancesH.List))
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
			// An additional wallet for a user who already has one. Returns a
			// challenge; the wallet exists only once the browser executes it.
			r.Post("/auth/circle/wallets", circleAuthH.CreateWallet)
			r.Post("/auth/circle/sign_typed_data", circleAuthH.SignTypedData)
			r.Post("/auth/circle/sign_message", circleAuthH.SignMessage)
			r.Post("/auth/circle/contract_execution", circleAuthH.ContractExecution)
			r.Get("/auth/circle/transactions", circleAuthH.FindTransaction)
			r.Get("/auth/circle/transactions/{id}", circleAuthH.Transaction)

			// Public, minimal intent details for the payer surface (/pay/[id]) --
			// a payer landing on a bare payment link has no API key. Deliberately
			// exposes only amount/currency/status/source_chain/expiry, never
			// account_id/settle_address/reference/metadata.
			// no-store: this carries live payment status. A cached copy shows a
			// payer "unpaid" for something they have already paid.
			r.Get("/settlement_intents/{id}/public", cacheFor("no-store", intentsH.GetPublic))

			// Payment links: same "no API key" reasoning as the settlement_intent
			// public route above -- a payer opening a bare link/QR has no
			// credentials. GetPublic and Pay are the two payer-facing calls.
			// no-store, for the same reason as the intent above.
			r.Get("/payment_links/{id}/public", cacheFor("no-store", paymentLinksH.GetPublic))
			r.Post("/payment_links/{id}/pay", paymentLinksH.Pay)

			// Cross-currency FX for the payer surface. Same "no API key" reasoning
			// as the routes above: a payer opening a link or QR has no
			// credentials, and Circle StableFX is the ONLY working cross-currency
			// path (an on-chain swap route was removed: Arc has no USDC/EURC
			// pool, so it could never settle). Scoped by intent ID, which is the capability.
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

			// Usernames. Public for the same reason the link routes are: the
			// person typing a name into /send is a payer with no API key, and
			// resolving a name to an address is the entire point of the feature.
			//
			// no-store on both. Resolution decides where money goes, so a stale
			// answer is a misdirected payment; availability is checked while
			// someone types and a cached "free" would invite them to claim a name
			// that is already gone.
			r.Get("/usernames/{username}", cacheFor("no-store", usernamesH.Resolve))
			r.Get("/usernames/{username}/available", cacheFor("no-store", usernamesH.Available))
			r.Get("/wallets/{address}/username", cacheFor("no-store", usernamesH.ByWallet))
			// Claiming with a wallet signature rather than a session, because a
			// payer with only an EVM wallet HAS no session -- their account is
			// created lazily on first send. The signature is the credential, and
			// the name being claimed is inside the signed message so a captured
			// one cannot be replayed for a different name.
			r.Post("/usernames/claim", usernamesH.ClaimWithWallet)

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

		})

		r.Group(func(r chi.Router) {
			r.Use(auth.Middleware(cfg.Pool, circleVerifier))
			// After auth, so it can key on the account. Anyone can mint an sk_
			// key from the open POST /v1/accounts, so authenticated did not
			// mean bounded.
			r.Use(rateLimitByAccount(authedLimiter, trustProxyHeaders))
			r.Use(idempotency.Middleware(cfg.Pool))

			r.Get("/accounts", accountsH.List)
			r.Get("/accounts/me", accountsH.Me)
			// Claiming a name is an account action, so it sits behind the same
			// auth as the rest of them. Read is public; write never is.
			r.Post("/accounts/me/username", usernamesH.Claim)
			// "Keep sending it where it already goes." The other answer --
			// naming a different address -- confirms itself through the account
			// update, which validates the address.
			// Binds the settlement wallet the browser just created to this
			// account. Behind session auth like the rest, and additionally
			// requires the caller's Circle user token -- the address is read
			// back from Circle with it rather than taken from the request.
			r.Post("/accounts/me/settlement_wallet", settlementWalletH.Provision)
			// Addresses a business withdraws TO, which is not where its income
			// routes. Added unverified and unpayable until its owner proves
			// control of it.
			r.Get("/payout_destinations", payoutDestinationsH.List)
			r.Post("/payout_destinations", payoutDestinationsH.Create)
			r.Post("/payout_destinations/{id}/challenge", payoutDestinationsH.Challenge)
			r.Post("/payout_destinations/{id}/verify", payoutDestinationsH.Verify)
			r.Delete("/payout_destinations/{id}", payoutDestinationsH.Delete)
			// Withdrawals. Create authorises and hands back the transfer to
			// make; confirm records what the chain says actually happened.
			r.Get("/payouts", payoutsH.List)
			r.Post("/payouts", payoutsH.Create)
			r.Post("/payouts/{id}/confirm", payoutsH.Confirm)
			// Advanced: income lands directly in a treasury instead of the
			// wallet Conduit provisioned. Only from a verified destination,
			// and reversible in one call.
			r.Post("/accounts/me/settlement_address/external", externalSettlementH.SetExternal)
			r.Post("/accounts/me/settlement_address/revert", externalSettlementH.Revert)
			// The people a business pays. Archived rather than deleted: a
			// removed row breaks the history of every run that paid them.
			r.Get("/employees", employeesH.List)
			r.Post("/employees", employeesH.Create)
			r.Patch("/employees/{id}", employeesH.Update)
			r.Post("/employees/{id}/archive", employeesH.Archive)
			// Payroll: draft, read, execute, then report each currency group's
			// outcome as it lands. Partial is an outcome, not an error.
			r.Get("/payroll_runs", payrollRunsH.List)
			r.Post("/payroll_runs", payrollRunsH.Create)
			r.Get("/payroll_runs/{id}", payrollRunsH.Get)
			r.Post("/payroll_runs/{id}/execute", payrollRunsH.Execute)
			r.Post("/payroll_runs/{id}/legs", payrollRunsH.RecordLeg)
			// Ends every session for the account. Authenticated because it acts
			// on the caller's own account, and only meaningful to a session
			// caller -- see Accounts.Logout.
			r.Post("/auth/logout", accountsH.Logout)
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

// cacheFor sets Cache-Control on a GET whose freshness the server already
// bounds internally.
//
// Every header written with this MUST match a TTL the code actually enforces.
// A header is a promise about staleness, and one that outlives the server's own
// cache is a promise to serve data the server has already decided is too old --
// on a payments API, that is how someone reads "unpaid" for an invoice that has
// been settled. So these are derived from the same constants the handlers use,
// never chosen for effect.
func cacheFor(value string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", value)
		next(w, r)
	}
}

var errNoRelayerKey = errors.New("ARC_RELAYER_KEY not configured")

// How often the background sweepers wake up.
//
// These were both 10 seconds, and each one runs an unconditional query whether
// or not there is anything to do -- so between them the database was queried
// roughly 17,000 times a day at idle. That is not a query-cost problem, it is a
// SLEEP problem: a serverless Postgres scales to zero only after several
// minutes of no connections, and a query every ten seconds means it never gets
// there. The compute bills for time awake, so an app with no users at all still
// pays for 720 hours a month.
//
// Neither of these is on the payment path. The webhook sweeper redelivers
// failed webhooks that are ALREADY on an exponential backoff, and the bridge
// reconciler recovers transfers that were orphaned by a browser dying
// mid-payment. Both are recovery, measured in minutes by nature, and nothing a
// payer does gets slower because they run less often.
//
// Overridable so the interval can be tuned on a deployment without a rebuild --
// tightened while debugging a stuck transfer, loosened when the database bill
// matters more than a few minutes of recovery latency.
func workerInterval(env string, fallback time.Duration) time.Duration {
	if raw := strings.TrimSpace(os.Getenv(env)); raw != "" {
		if d, err := time.ParseDuration(raw); err == nil && d > 0 {
			return d
		}
		log.Printf("server: ignoring invalid %s=%q, using %s", env, raw, fallback)
	}
	return fallback
}

// StartBackgroundWorkers runs the webhook retry sweeper, the CCTP orphan
// reconciler (if bridging is configured), and, if arcRPC/routerAddress are
// provided, the on-chain indexer — all block until ctx is cancelled. Call in a
// goroutine from cmd/api and cmd/devserver.
func StartBackgroundWorkers(ctx context.Context, pool *pgxpool.Pool, arcRPC, routerAddress string, bridgeCfg Config) {
	// 15 minutes, deliberately LONGER than the database's scale-to-zero window.
	//
	// This is the whole point and it is easy to get wrong by a factor that
	// matters: a serverless Postgres suspends after ~5 minutes of inactivity, so
	// a sweeper on a 5 minute tick wakes it at the exact moment it was about to
	// sleep and it never suspends at all. The interval has to clear that window
	// with room, or the compute bills for 720 hours a month regardless of how
	// few queries those hours contained.
	sweepEvery := workerInterval("CONDUIT_WEBHOOK_SWEEP_INTERVAL", 15*time.Minute)
	reconcileEvery := workerInterval("CONDUIT_BRIDGE_RECONCILE_INTERVAL", 15*time.Minute)
	log.Printf("server: background workers — webhook sweep %s, bridge reconcile %s", sweepEvery, reconcileEvery)

	dispatcher := webhooks.NewDispatcher(pool)
	go func() {
		ticker := time.NewTicker(sweepEvery)
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
			ticker := time.NewTicker(reconcileEvery)
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
