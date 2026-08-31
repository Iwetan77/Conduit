package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/kzn-labs/conduit/api/internal/db"
)

func loadAPIKeyForTest(t *testing.T) string {
	t.Helper()
	if v := os.Getenv("STABLEFX_API_KEY"); v != "" {
		return v
	}
	_, thisFile, _, _ := runtime.Caller(0)
	envPath := filepath.Join(filepath.Dir(thisFile), "..", "..", ".env")
	data, err := os.ReadFile(envPath)
	if err != nil {
		t.Skipf("STABLEFX_API_KEY not found: %v", err)
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "STABLEFX_API_KEY=") {
			return strings.TrimPrefix(line, "STABLEFX_API_KEY=")
		}
	}
	t.Skip("STABLEFX_API_KEY not in .env")
	return ""
}

// TestFullFlow_AccountToQuote is a real, no-mocks integration test: real
// embedded Postgres, real in-process HTTP server, real StableFX sandbox calls
// for the quote step. It covers everything from GATE 2's e2e.sh that doesn't
// require a funded on-chain wallet (steps 1-5 of that spec — account+key
// creation, idempotency replay, intent creation, real quote with a real rate
// and TTL). Steps 6-11 (prepare/confirm/real settlement/webhook/CSV/TTL
// expiry) need the funded wallet — see whereistopped.md.
func TestFullFlow_AccountToQuote(t *testing.T) {
	ctx := context.Background()
	pool, cleanup, err := db.StartTestDB(ctx, 15434)
	if err != nil {
		t.Fatalf("StartTestDB: %v", err)
	}
	defer cleanup()

	apiKey := loadAPIKeyForTest(t)
	handler := New(Config{Pool: pool, StableFXKey: apiKey, StableFXBase: "https://api-sandbox.circle.com", AppBaseURL: "https://app.conduit.xyz"})
	srv := httptest.NewServer(handler)
	defer srv.Close()

	// 1. Create an account -> get a real sk_test_ key
	createAcctBody := `{"name":"Tanaka Trading KK","settle_currency":"USDC","settle_address":"0x0000000000000000000000000000000000000009"}`
	resp := doJSON(t, srv.URL, "POST", "/v1/accounts", "", createAcctBody, "")
	if resp.status != http.StatusCreated {
		t.Fatalf("create account: status=%d body=%s", resp.status, resp.body)
	}
	var acct struct {
		ID     string `json:"id"`
		APIKey struct {
			Key string `json:"key"`
		} `json:"api_key"`
	}
	if err := json.Unmarshal([]byte(resp.body), &acct); err != nil {
		t.Fatalf("unmarshal account: %v (body: %s)", err, resp.body)
	}
	if !strings.HasPrefix(acct.APIKey.Key, "sk_test_") {
		t.Errorf("expected sk_test_ prefix, got %s", acct.APIKey.Key)
	}
	skKey := acct.APIKey.Key

	// 2. GET /v1/currencies (bearer-authed but not account-scoped)
	resp = doJSON(t, srv.URL, "GET", "/v1/currencies", skKey, "", "")
	if resp.status != http.StatusOK {
		t.Fatalf("list currencies: status=%d body=%s", resp.status, resp.body)
	}
	if !strings.Contains(resp.body, "BRLA") {
		t.Errorf("expected BRLA in currency list, got %s", resp.body)
	}

	// 3. Create a settlement intent WITH an Idempotency-Key
	idemKey := "test-idem-key-1"
	createIntentBody := `{"amount":1240000,"settle_currency":"USD","reference":"INV-2026-0412"}`
	resp = doJSON(t, srv.URL, "POST", "/v1/settlement_intents", skKey, createIntentBody, idemKey)
	if resp.status != http.StatusCreated {
		t.Fatalf("create intent: status=%d body=%s", resp.status, resp.body)
	}
	var intent1 struct {
		ID     string `json:"id"`
		Amount string `json:"amount"`
	}
	json.Unmarshal([]byte(resp.body), &intent1)
	if intent1.Amount != "1240000" {
		t.Errorf("expected amount 1240000, got %s", intent1.Amount)
	}

	// 4. Replay the EXACT same request with the same Idempotency-Key -> byte-identical response, no new row
	resp2 := doJSON(t, srv.URL, "POST", "/v1/settlement_intents", skKey, createIntentBody, idemKey)
	if resp2.body != resp.body {
		t.Errorf("idempotent replay returned a different body:\nfirst:  %s\nsecond: %s", resp.body, resp2.body)
	}
	var count int
	pool.QueryRow(ctx, `SELECT count(*) FROM settlement_intents WHERE id = $1`, intent1.ID).Scan(&count)
	if count != 1 {
		t.Errorf("expected exactly 1 row for intent %s, got %d", intent1.ID, count)
	}

	// 4b. Same key, DIFFERENT body -> 409 idempotency_key_reuse
	resp3 := doJSON(t, srv.URL, "POST", "/v1/settlement_intents", skKey,
		`{"amount":999,"settle_currency":"USD"}`, idemKey)
	if resp3.status != http.StatusConflict {
		t.Errorf("expected 409 on idempotency key reuse with different body, got %d: %s", resp3.status, resp3.body)
	}

	// 5. Request a quote for BRLA -> USDC (the primary demo pair) — real StableFX call
	resp = doJSON(t, srv.URL, "POST", "/v1/settlement_intents/"+intent1.ID+"/quote", skKey, `{"pay_currency":"BRLA"}`, "")
	if resp.status != http.StatusOK {
		t.Fatalf("quote: status=%d body=%s", resp.status, resp.body)
	}
	var quote struct {
		Provider    string `json:"provider"`
		Rate        string `json:"rate"`
		PayAmount   string `json:"pay_amount"`
		PayCurrency string `json:"pay_currency"`
		ExpiresAt   int64  `json:"expires_at"`
	}
	json.Unmarshal([]byte(resp.body), &quote)
	if quote.Provider != "stablefx" {
		t.Errorf("expected provider=stablefx, got %s", quote.Provider)
	}
	if quote.Rate == "" || quote.PayAmount == "" {
		t.Errorf("expected a real rate and pay_amount, got rate=%s pay_amount=%s", quote.Rate, quote.PayAmount)
	}
	t.Logf("real BRLA->USDC quote for intent %s: rate=%s pay_amount=%s BRLA expires_at=%d",
		intent1.ID, quote.Rate, quote.PayAmount, quote.ExpiresAt)

	// GET the intent back, confirm status advanced to "quoted"
	resp = doJSON(t, srv.URL, "GET", "/v1/settlement_intents/"+intent1.ID, skKey, "", "")
	if !strings.Contains(resp.body, `"status":"quoted"`) {
		t.Errorf("expected status=quoted after a successful quote, got %s", resp.body)
	}

	// 6. Cross-tenant isolation: a second account's key must not see the first account's intent
	resp = doJSON(t, srv.URL, "POST", "/v1/accounts", "", `{"name":"Other Co","settle_currency":"USDC","settle_address":"0x0000000000000000000000000000000000000009"}`, "")
	var acct2 struct {
		APIKey struct {
			Key string `json:"key"`
		} `json:"api_key"`
	}
	json.Unmarshal([]byte(resp.body), &acct2)
	resp = doJSON(t, srv.URL, "GET", "/v1/settlement_intents/"+intent1.ID, acct2.APIKey.Key, "", "")
	if resp.status != http.StatusNotFound {
		t.Errorf("expected 404 for cross-tenant access, got %d: %s", resp.status, resp.body)
	}
}

type jsonResp struct {
	status int
	body   string
}

func doJSON(t *testing.T, base, method, path, bearer, body, idemKey string) jsonResp {
	t.Helper()
	req, err := http.NewRequest(method, base+path, bytes.NewReader([]byte(body)))
	if err != nil {
		t.Fatal(err)
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	if idemKey != "" {
		req.Header.Set("Idempotency-Key", idemKey)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	buf := new(bytes.Buffer)
	buf.ReadFrom(resp.Body)
	return jsonResp{status: resp.StatusCode, body: buf.String()}
}
