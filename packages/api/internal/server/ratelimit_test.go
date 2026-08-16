package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"golang.org/x/time/rate"
)

// X-Forwarded-For is a list, and the proxy in front of us appends the address
// it observed. Only the rightmost entry is written by our own proxy; everything
// left of it arrived with the request and is whatever the caller chose to send.
//
// Reading the leftmost entry therefore let a caller present a different
// identity per request, which both defeated the limit and grew the client map
// once per distinct value.
func TestClientIPUsesTheProxyObservedAddress(t *testing.T) {
	cases := []struct {
		name       string
		xff        string
		xRealIP    string
		remoteAddr string
		trustProxy bool
		want       string
	}{
		{
			name:       "single entry is the client",
			xff:        "203.0.113.7",
			remoteAddr: "10.0.0.1:5000",
			trustProxy: true,
			want:       "203.0.113.7",
		},
		{
			// The caller sent a value of their own; our proxy appended the
			// address it actually saw. The appended one is the real one.
			name:       "caller supplied entries are ignored",
			xff:        "1.1.1.1, 2.2.2.2, 203.0.113.7",
			remoteAddr: "10.0.0.1:5000",
			trustProxy: true,
			want:       "203.0.113.7",
		},
		{
			name:       "x-real-ip wins when present",
			xff:        "1.1.1.1, 203.0.113.7",
			xRealIP:    "198.51.100.4",
			remoteAddr: "10.0.0.1:5000",
			trustProxy: true,
			want:       "198.51.100.4",
		},
		{
			// Without a proxy in front, the header is attacker-controlled end
			// to end and must not be read at all.
			name:       "headers ignored when no proxy is configured",
			xff:        "1.1.1.1, 203.0.113.7",
			xRealIP:    "198.51.100.4",
			remoteAddr: "203.0.113.9:5000",
			trustProxy: false,
			want:       "203.0.113.9",
		},
		{
			name:       "falls back to the socket when no headers",
			remoteAddr: "203.0.113.9:5000",
			trustProxy: true,
			want:       "203.0.113.9",
		},
		{
			name:       "trailing separator does not yield an empty identity",
			xff:        "203.0.113.7,",
			remoteAddr: "10.0.0.1:5000",
			trustProxy: true,
			want:       "10.0.0.1",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/v1/payment_links/pl_1/public", nil)
			r.RemoteAddr = tc.remoteAddr
			if tc.xff != "" {
				r.Header.Set("X-Forwarded-For", tc.xff)
			}
			if tc.xRealIP != "" {
				r.Header.Set("X-Real-IP", tc.xRealIP)
			}
			if got := clientIP(r, tc.trustProxy); got != tc.want {
				t.Errorf("clientIP = %q, want %q", got, tc.want)
			}
		})
	}
}

// The limit has to survive a caller varying the part of the header they
// control. One identity means one bucket, however the request is dressed up.
func TestRateLimitHoldsWhenTheClientVariesTheHeader(t *testing.T) {
	rl := newRateLimiter(rate.Limit(publicRatePerSecond), publicBurst)
	h := rateLimit(rl, true)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	const requests = 100
	var throttled int
	for i := 0; i < requests; i++ {
		r := httptest.NewRequest(http.MethodGet, "/v1/payment_links/pl_1/public", nil)
		r.RemoteAddr = "10.0.0.1:5000"
		// A different value each time in the caller-controlled position, with
		// the address our proxy appends held constant -- which is what it
		// would be, since it is the same machine calling.
		r.Header.Set("X-Forwarded-For", randomishIP(i)+", 203.0.113.7")

		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code == http.StatusTooManyRequests {
			throttled++
		}
	}

	// Burst is allowed through, the rest must not be.
	if throttled < requests-publicBurst-2 {
		t.Errorf("throttled %d of %d requests; want at least %d",
			throttled, requests, requests-publicBurst-2)
	}

	// One caller must occupy one bucket, not one per header value, or the map
	// becomes the exhaustion vector the eviction sweep exists to prevent.
	rl.mu.Lock()
	tracked := len(rl.clients)
	rl.mu.Unlock()
	if tracked != 1 {
		t.Errorf("tracked %d clients for one caller, want 1", tracked)
	}
}

// Genuinely distinct callers must still get their own allowance -- the point of
// reading the header at all is that everyone behind the proxy is not one client.
func TestRateLimitSeparatesRealClients(t *testing.T) {
	rl := newRateLimiter(rate.Limit(publicRatePerSecond), publicBurst)
	h := rateLimit(rl, true)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	for i := 0; i < 5; i++ {
		r := httptest.NewRequest(http.MethodGet, "/v1/payment_links/pl_1/public", nil)
		r.RemoteAddr = "10.0.0.1:5000"
		r.Header.Set("X-Forwarded-For", "1.1.1.1, "+randomishIP(i))

		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("request %d: status=%d, want 200", i, w.Code)
		}
	}

	rl.mu.Lock()
	tracked := len(rl.clients)
	rl.mu.Unlock()
	if tracked != 5 {
		t.Errorf("tracked %d clients for 5 callers, want 5", tracked)
	}
}

// Preflight carries no credentials and does no work; rejecting it would break
// CORS for a browser that was still within its allowance.
func TestRateLimitLetsPreflightThrough(t *testing.T) {
	rl := newRateLimiter(rate.Limit(publicRatePerSecond), publicBurst)
	h := rateLimit(rl, true)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	for i := 0; i < 200; i++ {
		r := httptest.NewRequest(http.MethodOptions, "/v1/payment_links/pl_1/public", nil)
		r.RemoteAddr = "203.0.113.7:5000"
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("preflight %d: status=%d, want 200", i, w.Code)
		}
	}
}

func randomishIP(i int) string {
	return "198.51.100." + string(rune('0'+i%10)) + string(rune('0'+(i/10)%10))
}
