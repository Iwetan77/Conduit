package server

import (
	"encoding/json"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

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

	// A client is forgotten after this long idle, so the map cannot grow
	// without bound. Without eviction the limiter would itself be the memory
	// exhaustion vector it exists to prevent.
	limiterIdleTTL  = 10 * time.Minute
	limiterSweepGap = 5 * time.Minute
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
		c = &clientLimiter{limiter: rate.NewLimiter(rl.rps, rl.burst)}
		rl.clients[key] = c
	}
	c.lastSeen = time.Now()
	rl.mu.Unlock()
	return c.limiter.Allow()
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
func clientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			// Leftmost entry is the original client; the rest are proxies.
			if first, _, found := strings.Cut(xff, ","); found {
				return strings.TrimSpace(first)
			}
			return strings.TrimSpace(xff)
		}
		if xrip := strings.TrimSpace(r.Header.Get("X-Real-IP")); xrip != "" {
			return xrip
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
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
