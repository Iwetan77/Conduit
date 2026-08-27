package server

import (
	"compress/gzip"
	"io"
	"net/http"
	"strings"
	"testing"
)

// The two response-level performance behaviours that are invisible when they
// break.
//
// Both are single lines of setup that every response depends on, and neither
// shows up in any functional test: if the Compress middleware is dropped in a
// merge, or a route is moved out from under cacheFor, every test still passes
// and every response is simply bigger or staler than it should be. Nobody
// notices until a bandwidth bill or a payer looking at a cached "unpaid".

func TestJSONResponsesAreCompressed(t *testing.T) {
	srv, key, _ := newLinkTestServer(t, 15518)

	req, err := http.NewRequest("GET", srv.URL+"/v1/payment_links", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Accept-Encoding", "gzip")

	// The default client transparently requests AND decodes gzip, which would
	// hide the header being absent. A transport that does nothing on its own is
	// the only way to observe what the server actually sent.
	client := &http.Client{Transport: &http.Transport{DisableCompression: true}}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("get payment_links: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status=%d body=%s", resp.StatusCode, body)
	}
	if enc := resp.Header.Get("Content-Encoding"); enc != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", enc)
	}

	// Decoding it proves the header is honest rather than merely present.
	zr, err := gzip.NewReader(resp.Body)
	if err != nil {
		t.Fatalf("gzip reader: %v", err)
	}
	defer zr.Close()
	body, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("read gzip body: %v", err)
	}
	if !strings.Contains(string(body), `"data"`) {
		t.Fatalf("decompressed body is not the list payload: %s", body)
	}
}

func TestCacheControlMatchesWhatTheDataAllows(t *testing.T) {
	srv, _, _ := newLinkTestServer(t, 15519)

	cases := []struct {
		name string
		path string
		want string
		why  string
	}{
		{
			name: "currencies are shared reference data",
			path: "/v1/currencies",
			want: "public, max-age=60, stale-while-revalidate=300",
			why:  "changes only on deploy",
		},
		{
			name: "a public link view is never cached",
			path: "/v1/payment_links/pl_does_not_exist/public",
			want: "no-store",
			why:  "carries live payment status; a cached copy shows a payer unpaid for something already paid",
		},
		{
			name: "an intent view is never cached",
			path: "/v1/settlement_intents/si_does_not_exist/public",
			want: "no-store",
			why:  "same as the link above",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp, err := http.Get(srv.URL + tc.path)
			if err != nil {
				t.Fatalf("get %s: %v", tc.path, err)
			}
			defer resp.Body.Close()
			// Status is deliberately not asserted: the header is set before the
			// handler runs, so it must hold on a 404 too. A 404 that forgets
			// no-store is exactly how a link that later goes live gets pinned as
			// missing in somebody's cache.
			if got := resp.Header.Get("Cache-Control"); got != tc.want {
				t.Fatalf("%s Cache-Control = %q, want %q (%s)", tc.path, got, tc.want, tc.why)
			}
		})
	}
}

// A payer's balance must never land in a shared cache: one address's money
// served to another is the worst possible caching bug in this codebase.
func TestBalancesAreNeverPubliclyCacheable(t *testing.T) {
	srv, _, _ := newLinkTestServer(t, 15520)

	resp, err := http.Get(srv.URL + "/v1/balances?address=0x0000000000000000000000000000000000000009")
	if err != nil {
		t.Fatalf("get balances: %v", err)
	}
	defer resp.Body.Close()

	cc := resp.Header.Get("Cache-Control")
	if !strings.HasPrefix(cc, "private") {
		t.Fatalf("Cache-Control = %q, must start with private -- this is one address's money", cc)
	}
	if strings.Contains(cc, "public") {
		t.Fatalf("Cache-Control = %q contains public", cc)
	}
}
