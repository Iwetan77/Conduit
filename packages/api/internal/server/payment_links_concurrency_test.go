package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
)

// TestSingleUsePayConcurrentOnlyOneIntent is the regression test for the
// double-checkout bug: POST /payment_links/{id}/pay used to read the link's
// status and insert a settlement_intent as two separate statements, so N
// concurrent checkouts on a single_use link all saw 'active' and each minted
// its own intent. Exactly one must win; the rest are refused with
// payment_link_in_checkout, and exactly one intent row may exist for the link.
func TestSingleUsePayConcurrentOnlyOneIntent(t *testing.T) {
	srv, key, pool := newLinkTestServer(t, 15515)

	resp := doJSON(t, srv.URL, "POST", "/v1/payment_links", key,
		`{"amount_mode":"fixed","amount":10000,"settle_currency":"USD","reuse_policy":"single_use"}`, "")
	if resp.status != http.StatusCreated {
		t.Fatalf("create link: status=%d body=%s", resp.status, resp.body)
	}
	var link struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal([]byte(resp.body), &link); err != nil {
		t.Fatalf("unmarshal link: %v", err)
	}

	// A raw request issued from each goroutine, deliberately NOT doJSON: that
	// helper calls t.Fatal on transport errors, which must only run on the
	// test's own goroutine.
	pay := func() int {
		req, err := http.NewRequest("POST", srv.URL+"/v1/payment_links/"+link.ID+"/pay", strings.NewReader(`{}`))
		if err != nil {
			return 0
		}
		req.Header.Set("Content-Type", "application/json")
		r, err := http.DefaultClient.Do(req)
		if err != nil {
			return 0
		}
		defer r.Body.Close()
		io.Copy(io.Discard, r.Body)
		return r.StatusCode
	}

	const n = 8
	statuses := make([]int, n)
	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func(i int) {
			defer wg.Done()
			statuses[i] = pay()
		}(i)
	}
	wg.Wait()

	created, conflict := 0, 0
	for _, s := range statuses {
		switch s {
		case http.StatusCreated:
			created++
		case http.StatusConflict:
			conflict++
		default:
			t.Errorf("unexpected pay status %d (all: %v)", s, statuses)
		}
	}
	if created != 1 {
		t.Errorf("expected exactly 1 created checkout, got %d (all: %v)", created, statuses)
	}
	if conflict != n-1 {
		t.Errorf("expected %d in-checkout conflicts, got %d (all: %v)", n-1, conflict, statuses)
	}

	var intents int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM settlement_intents WHERE payment_link_id = $1`, link.ID).Scan(&intents); err != nil {
		t.Fatalf("count intents: %v", err)
	}
	if intents != 1 {
		t.Errorf("expected exactly 1 settlement_intent, got %d", intents)
	}
}

// TestSingleUseReservationReleasedOnCancel: cancelling the in-flight intent
// releases the link's reservation immediately, so the invoice is payable again
// without waiting for the reservation to lapse. This is the explicit release
// path; expiry is the fallback for checkouts nobody ever cancels.
func TestSingleUseReservationReleasedOnCancel(t *testing.T) {
	srv, key, _ := newLinkTestServer(t, 15516)

	resp := doJSON(t, srv.URL, "POST", "/v1/payment_links", key,
		`{"amount_mode":"fixed","amount":10000,"settle_currency":"USD","reuse_policy":"single_use"}`, "")
	var link struct {
		ID string `json:"id"`
	}
	json.Unmarshal([]byte(resp.body), &link)

	resp = doJSON(t, srv.URL, "POST", "/v1/payment_links/"+link.ID+"/pay", "", `{}`, "")
	if resp.status != http.StatusCreated {
		t.Fatalf("first pay should succeed: status=%d body=%s", resp.status, resp.body)
	}
	var intent struct {
		ID string `json:"id"`
	}
	json.Unmarshal([]byte(resp.body), &intent)

	// Reserved: a second checkout is refused.
	resp = doJSON(t, srv.URL, "POST", "/v1/payment_links/"+link.ID+"/pay", "", `{}`, "")
	if resp.status != http.StatusConflict {
		t.Fatalf("pay while reserved: expected 409, got %d body=%s", resp.status, resp.body)
	}

	// Cancel the in-flight intent (the merchant's own key, same account).
	resp = doJSON(t, srv.URL, "POST", "/v1/settlement_intents/"+intent.ID+"/cancel", key, "", "")
	if resp.status != http.StatusOK {
		t.Fatalf("cancel intent: status=%d body=%s", resp.status, resp.body)
	}

	// Released: the invoice is payable again without any backdating.
	resp = doJSON(t, srv.URL, "POST", "/v1/payment_links/"+link.ID+"/pay", "", `{}`, "")
	if resp.status != http.StatusCreated {
		t.Fatalf("pay after cancel should succeed: status=%d body=%s", resp.status, resp.body)
	}
}
