package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/kzn-labs/conduit/api/internal/auth"
	apierrors "github.com/kzn-labs/conduit/api/internal/errors"
	"golang.org/x/time/rate"
)

// Per-client rate limiting for the routes that need no credential.
//
// Everything behind auth.Middleware already costs an attacker an API key, and a
// key can be revoked. The public payer routes cannot be: a payment link is a URL
// meant to be opened by strangers, so `/public`, `/pay`, the quote path and the
// bridge endpoints answer anyone who asks. Several of them spend real money on
// our side -- a quote is a live StableFX call against our key, and the bridge
// endpoints hit Circle -- so an unthrottled loop over a link URL burns our
// provider quota and costs us, whether or not it ever pays anything.
//
// Deliberately in-process, not Redis. This is one API instance today, and a
// dependency that must be running for payments to work is a worse failure mode
// than a limiter that resets when the process does. If the API is ever scaled
// horizontally this becomes per-instance and the effective limit multiplies by
// instance count -- acceptable, and noted here so it is a decision rather than
// a surprise.

const (
	// Sustained requests per second per client, with a burst on top. A payer
	// legitimately loads a pay page, polls its status every few seconds, and
	// fetches a quote or two; that is comfortably inside this. A script
	// hammering quotes is not.
	publicRatePerSecond = 5
	publicBurst         = 20

	// POST /v1/rpc gets its own, far larger bucket.
	//
	// It shared the public one, and that was an outage waiting for a faster
	// client. A single payment makes dozens of JSON-RPC calls -- nonce, gas
	// estimate, fee history, broadcast, then receipt polling -- so one payer,
	// alone, exhausted a bucket of 5/second. Measured against production before
	// this change: thirty rapid calls, the volume of ONE payment, returned nine
	// 429s. The browser surfaces a rejected read as "failed to fetch", which
	// the app reports as "Couldn't reach the network".
	//
	// Phase B2 then made it worse by fixing something else. Dropping ethers'
	// poll interval from 4000ms to 500ms cut nine seconds off every payment and
	// multiplied receipt-polling requests by eight, straight into this bucket.
	// The lesson is in the pairing: a client optimisation and a server limit are
	// one system, and tuning either alone is how a latency fix becomes a
	// network error.
	//
	// A high ceiling is appropriate because this is a RELAY to a public chain,
	// not a spend endpoint. Nothing behind it costs money or mutates Conduit
	// state; the worst an abuser achieves is proxying reads that Arc's own
	// public endpoint would serve them anyway. The limit exists to stop this
	// instance being used as free infrastructure, not to ration payers.
	rpcRatePerSecond = 120
	rpcBurst         = 400

	// Authenticated callers get their own, far more generous allowance, keyed
	// on the account rather than the IP.
	//
	// A merchant's dashboard polls, a POS mints links, an integrator backfills;
	// none of that should be throttled at payer rates, and an office behind one
	// NAT must not share a bucket. But "already authenticated" is not the same
	// as "unlimited": POST /v1/accounts needs no credential, so anyone can mint
	// an sk_ key and then hammer every authenticated route with it. This is what
	// bounds that, and a key -- unlike an IP -- can be revoked once it is
	// obviously the source.
	authedRatePerSecond = 50
	authedBurst         = 200

	// A client is forgotten after this long idle, so the map cannot grow
	// without bound. Without eviction the limiter would itself be the memory
	// exhaustion vector it exists to prevent.
	limiterIdleTTL  = 10 * time.Minute
	limiterSweepGap = 5 * time.Minute

	// Hard ceiling on tracked clients, as a backstop to the idle sweep. The
	// sweep only runs every limiterSweepGap, so a burst of requests from many
	// distinct addresses can add entries far faster than it removes them. Once
	// this is reached new clients share a single overflow bucket rather than
	// each getting their own -- degraded, but bounded. ~100k entries is a few
	// MB and far above any real client count for this service.
	maxTrackedClients = 100_000
	overflowKey       = "\x00overflow"
)

type clientLimiter struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

type rateLimiter struct {
	mu      sync.Mutex
	clients map[string]*clientLimiter
	rps     rate.Limit
	burst   int
}

func newRateLimiter(rps rate.Limit, burst int) *rateLimiter {
	rl := &rateLimiter{clients: map[string]*clientLimiter{}, rps: rps, burst: burst}
	go rl.sweep()
	return rl
}

func (rl *rateLimiter) sweep() {
	for range time.Tick(limiterSweepGap) {
		cutoff := time.Now().Add(-limiterIdleTTL)
		rl.mu.Lock()
		for key, c := range rl.clients {
			if c.lastSeen.Before(cutoff) {
				delete(rl.clients, key)
			}
		}
		rl.mu.Unlock()
	}
}

func (rl *rateLimiter) allow(key string) bool {
	rl.mu.Lock()
	c, ok := rl.clients[key]
	if !ok {
		// Above the ceiling, everyone new shares one bucket. This is the
		// backstop for the case the idle sweep cannot cover: entries arriving
		// faster than limiterSweepGap removes them.
		if len(rl.clients) >= maxTrackedClients {
			key = overflowKey
			c, ok = rl.clients[key]
		}
		if !ok {
			c = &clientLimiter{limiter: rate.NewLimiter(rl.rps, rl.burst)}
			rl.clients[key] = c
		}
	}
	c.lastSeen = time.Now()
	rl.mu.Unlock()
	return c.limiter.Allow()
}

// allowN is allow, for a request that costs more than one.
//
// Used by the RPC proxy so an eth_getLogs scan is charged what it costs while
// receipt polling stays nearly free. See rpcMethodCost.
func (rl *rateLimiter) allowN(key string, n int) bool {
	if n < 1 {
		n = 1
	}
	rl.mu.Lock()
	c, ok := rl.clients[key]
	if !ok {
		if len(rl.clients) >= maxTrackedClients {
			key = overflowKey
			c, ok = rl.clients[key]
		}
		if !ok {
			c = &clientLimiter{limiter: rate.NewLimiter(rl.rps, rl.burst)}
			rl.clients[key] = c
		}
	}
	c.lastSeen = time.Now()
	rl.mu.Unlock()
	return c.limiter.AllowN(time.Now(), n)
}

// rateLimitRPC is the middleware for POST /v1/rpc.
//
// Separate from the public limiter because the traffic is a different shape: a
// single payment makes dozens of reads, and sharing the payer bucket meant one
// person throttled themselves. It reads the method out of the body to weight
// the cost, then puts the body back for the handler -- the alternative, letting
// the proxy do its own limiting, would put the decision behind the thing it is
// meant to protect.
func rateLimitRPC(rl *rateLimiter, trustProxy bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodOptions {
				next.ServeHTTP(w, r)
				return
			}

			cost := 1
			// Bounded read: the proxy has its own body limit, and this must not
			// become a way to make the limiter allocate.
			body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
			r.Body.Close()
			if err == nil {
				var probe struct {
					Method string `json:"method"`
				}
				if json.Unmarshal(body, &probe) == nil {
					cost = rpcMethodCost(probe.Method)
				}
				// Handed back intact. Reading a request body consumes it, and a
				// proxy that received an empty one would fail every call.
				r.Body = io.NopCloser(bytes.NewReader(body))
			}

			if !rl.allowN("rpc:"+clientIP(r, trustProxy), cost) {
				e := apierrors.E(apierrors.CodeRateLimited, "")
				w.Header().Set("Retry-After", "1")
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(e.Status)
				json.NewEncoder(w).Encode(map[string]any{"error": e})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// clientIP identifies the caller for limiting purposes.
//
// Render and every other managed host put a proxy in front, so RemoteAddr is
// the proxy and limiting on it would throttle all users as one. X-Forwarded-For
// is the way through that, but it is caller-supplied and trivially spoofed --
// so it is only trusted when CONDUIT_TRUSTED_PROXY is set, which is the
// operator saying "there really is a proxy in front of me". Left unset (local
// dev, or a directly exposed server) the header is ignored entirely, because
// honouring it there would let anyone bypass the limit with one extra header.
//
// Which entry of the header is read matters. X-Forwarded-For is a list, and a
// proxy APPENDS the address it observed rather than replacing the list. With
// one proxy in front, a request that arrived with no header reaches us as
// "<client>", and one that arrived already carrying a value reaches us as
// "<that value>, <client>". Only the rightmost entry was written by our own
// proxy; anything to the left of it came in with the request and is therefore
// as trustworthy as the request itself, which is to say not at all.
//
// So the rightmost entry is the identity, and it must be, or the limit is
// keyed on something the caller chooses -- which is no limit, and which also
// grows the client map per distinct value rather than per client. See
// TestRateLimitHoldsWhenTheClientVariesTheHeader.
//
// X-Real-IP is preferred where present because it is a single value that our
// proxy sets, overwriting anything that came in, so there is no list to pick
// from. Render sets it.
func clientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if xrip := strings.TrimSpace(r.Header.Get("X-Real-IP")); xrip != "" {
			return xrip
		}
		if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
			// Rightmost entry: the address our own proxy observed and
			// appended. Everything to its left is caller-supplied.
			if i := strings.LastIndexByte(xff, ','); i >= 0 {
				if last := strings.TrimSpace(xff[i+1:]); last != "" {
					return last
				}
			} else {
				return xff
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// rateLimitByAccount limits authenticated traffic per account.
//
// Runs AFTER auth.Middleware, so the principal is resolved and the key is the
// account id. Falls back to the client address when there is no principal,
// which should not happen on this group but must not become an unlimited path
// if it ever does.
func rateLimitByAccount(rl *rateLimiter, trustProxy bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodOptions {
				next.ServeHTTP(w, r)
				return
			}
			key := "ip:" + clientIP(r, trustProxy)
			if p, ok := auth.FromContext(r.Context()); ok && p.AccountID != "" {
				key = "acct:" + p.AccountID
			}
			if !rl.allow(key) {
				e := apierrors.E(apierrors.CodeRateLimited, "")
				w.Header().Set("Retry-After", "1")
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(e.Status)
				json.NewEncoder(w).Encode(map[string]any{"error": e})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// rateLimit is the middleware. Applied to a route group rather than globally:
// throttling an authenticated merchant's dashboard by IP would punish an office
// behind one NAT, and those routes are already protected by a revocable key.
func rateLimit(rl *rateLimiter, trustProxy bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Preflight carries no credentials and does no work; rejecting it
			// breaks CORS for a browser that was within its limit.
			if r.Method == http.MethodOptions {
				next.ServeHTTP(w, r)
				return
			}
			if !rl.allow(clientIP(r, trustProxy)) {
				// Same envelope every other error in this API uses, so a
				// client parses a 429 exactly as it parses a 404.
				e := apierrors.E(apierrors.CodeRateLimited, "")
				w.Header().Set("Retry-After", "1")
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(e.Status)
				json.NewEncoder(w).Encode(map[string]any{"error": e})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// rpcMethodCost weights a JSON-RPC method by what it actually costs to serve.
//
// A flat count treats eth_getTransactionReceipt -- the cheapest possible lookup,
// and the one receipt polling makes hundreds of -- the same as eth_getLogs,
// which scans a block range and is the only method here that can be made
// genuinely expensive by its arguments. Weighting keeps polling nearly free
// while still bounding the calls worth bounding.
func rpcMethodCost(method string) int {
	switch method {
	case "eth_getLogs":
		return 20
	case "eth_call", "eth_estimateGas", "eth_feeHistory":
		return 2
	default:
		// Receipts, nonces, block numbers, balances, broadcasts. The traffic a
		// payment is actually made of.
		return 1
	}
}
