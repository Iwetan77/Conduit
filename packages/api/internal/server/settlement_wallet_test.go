package server

// Provisioning a business its own settlement wallet.
//
// The one thing these tests exist to hold down: the SERVER decides which
// address an account settles to, from what Circle says, and never from what the
// browser sent. Everything else here is detail.
//
// Nothing is mocked. Where an assertion depends on what Circle actually does,
// the test talks to Circle — a real user, a real token, a real wallet list —
// and skips loudly if it cannot, exactly as internal/circle's tests do. A
// fixture would make these pass while proving nothing, and the property under
// test is precisely "we asked the real Circle and believed it, not the caller".
//
// The tests that do NOT depend on Circle never reach it: the idempotent re-call
// short-circuits before the lookup, and a personal account is refused before
// it. Those run everywhere.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kzn-labs/conduit/api/internal/auth"
	"github.com/kzn-labs/conduit/api/internal/db"
)

// ── plumbing ────────────────────────────────────────────────────────────────

func circleAPIKey(t *testing.T) string {
	t.Helper()
	if v := os.Getenv("CIRCLE_API_KEY"); v != "" {
		return v
	}
	_, thisFile, _, _ := runtime.Caller(0)
	envPath := filepath.Join(filepath.Dir(thisFile), "..", "..", ".env")
	data, err := os.ReadFile(envPath)
	if err != nil {
		t.Skipf("CIRCLE_API_KEY not set and %s not readable: %v", envPath, err)
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "CIRCLE_API_KEY=") {
			return strings.TrimSpace(strings.TrimPrefix(line, "CIRCLE_API_KEY="))
		}
	}
	t.Skip("CIRCLE_API_KEY not found in .env")
	return ""
}

// newSettlementTestServer boots a real database and the real router.
//
// circleKey may be a placeholder for the tests that never reach Circle — the
// handler checks that a key is CONFIGURED before doing anything, and satisfying
// a config check is not the same as faking a response. Any test whose assertion
// depends on Circle passes the real key.
func newSettlementTestServer(t *testing.T, port uint32, circleKey string) (*httptest.Server, *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	pool, cleanup, err := db.StartTestDB(ctx, port)
	if err != nil {
		t.Fatalf("StartTestDB: %v", err)
	}
	t.Cleanup(cleanup)

	srv := httptest.NewServer(New(Config{
		Pool:         pool,
		AppBaseURL:   "https://app.conduit.xyz",
		CircleAPIKey: circleKey,
	}))
	t.Cleanup(srv.Close)
	return srv, pool
}

// seedMerchant writes an account with a Circle login identity — a business —
// and returns a session token for it.
// circleSubject is the Circle user id this account signs in as. It matters
// because the auth middleware gives X-Circle-User-Token precedence over the
// session bearer and resolves the account through auth_provider/auth_subject —
// so a test presenting a real Circle token needs the account to carry that
// user's identity, exactly as a real merchant's does.
func seedMerchant(t *testing.T, pool *pgxpool.Pool, id, loginWallet, circleSubject string) string {
	t.Helper()
	ctx := context.Background()
	if circleSubject == "" {
		circleSubject = "circle-subject-" + id
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO accounts (id, name, settle_currency, settle_address,
		                       auth_provider, auth_subject, login_wallet,
		                       settle_address_source, livemode)
		 VALUES ($1,$2,'USD',$3,'circle',$4,$3,'login_wallet',false)`,
		id, "Merchant "+id, loginWallet, circleSubject,
	); err != nil {
		t.Fatalf("seed merchant: %v", err)
	}
	var version int
	if err := pool.QueryRow(ctx, `SELECT session_version FROM accounts WHERE id = $1`, id).Scan(&version); err != nil {
		t.Fatalf("read session_version: %v", err)
	}
	return auth.NewSessionToken(id, version)
}

// seedPersonal writes a payer's wallet-keyed account: no identity in ANY
// identity column, which is the definition migration 0015 exists to protect.
func seedPersonal(t *testing.T, pool *pgxpool.Pool, id, wallet string) string {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx,
		`INSERT INTO accounts (id, name, settle_currency, settle_address, login_wallet,
		                       settle_address_source, livemode)
		 VALUES ($1,$2,'USD',$3,$3,'login_wallet',false)`,
		id, "Payer "+id, wallet,
	); err != nil {
		t.Fatalf("seed personal: %v", err)
	}
	var version int
	if err := pool.QueryRow(ctx, `SELECT session_version FROM accounts WHERE id = $1`, id).Scan(&version); err != nil {
		t.Fatalf("read session_version: %v", err)
	}
	return auth.NewSessionToken(id, version)
}

// provision calls the endpoint. doJSON cannot carry the Circle user token, and
// that header is half of what this route authenticates on.
func provision(t *testing.T, base, session, circleUserToken, body string) jsonResp {
	t.Helper()
	req, err := http.NewRequest("POST", base+"/v1/accounts/me/settlement_wallet", bytes.NewReader([]byte(body)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+session)
	req.Header.Set("Content-Type", "application/json")
	if circleUserToken != "" {
		req.Header.Set("X-Circle-User-Token", circleUserToken)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	buf := new(bytes.Buffer)
	buf.ReadFrom(resp.Body)
	return jsonResp{status: resp.StatusCode, body: buf.String()}
}

func settleAddressOf(t *testing.T, pool *pgxpool.Pool, id string) (string, *string, *string) {
	t.Helper()
	var addr string
	var walletID, source *string
	if err := pool.QueryRow(context.Background(),
		`SELECT settle_address, settle_wallet_id, settle_address_source FROM accounts WHERE id = $1`, id,
	).Scan(&addr, &walletID, &source); err != nil {
		t.Fatalf("read account: %v", err)
	}
	return addr, walletID, source
}

// ── live Circle helpers ─────────────────────────────────────────────────────

func circleCall(t *testing.T, apiKey, method, path, userToken, body string) map[string]any {
	t.Helper()
	var reader *bytes.Reader
	if body == "" {
		reader = bytes.NewReader(nil)
	} else {
		reader = bytes.NewReader([]byte(body))
	}
	req, err := http.NewRequest(method, "https://api.circle.com"+path, reader)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	if userToken != "" {
		req.Header.Set("X-User-Token", userToken)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Skipf("Circle unreachable (%s %s): %v", method, path, err)
	}
	defer resp.Body.Close()
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Skipf("Circle returned non-JSON for %s %s", method, path)
	}
	return out
}

// freshCircleUserToken creates a real Circle user and mints a real session for
// it. The user is brand new, so its wallet list is genuinely empty — which is
// exactly the state the "you do not own that wallet" test needs, and it is real
// rather than arranged.
func freshCircleUserToken(t *testing.T, apiKey string) (userID, token string) {
	t.Helper()
	userID = "conduit-test-" + uuid.NewString()
	circleCall(t, apiKey, "POST", "/v1/w3s/users", "", fmt.Sprintf(`{"userId":%q}`, userID))
	out := circleCall(t, apiKey, "POST", "/v1/w3s/users/token", "", fmt.Sprintf(`{"userId":%q}`, userID))
	data, _ := out["data"].(map[string]any)
	token, _ = data["userToken"].(string)
	if token == "" {
		t.Skipf("could not mint a Circle user token: %v", out)
	}
	return userID, token
}

type liveWallet struct {
	id, address, blockchain string
}

// anyInitializedArcWallet finds a real Arc wallet belonging to a real user
// whose token this process can mint.
//
// PIN-mode users only, and that is a finding rather than a preference: Circle
// refuses to mint a token for an SSO user from an API key at all, so an SSO
// user is unreachable from a test process. scripts/circle-wallet-probe.ts
// leaves such users behind; if none exists the test skips rather than
// pretending.
func anyInitializedArcWallet(t *testing.T, apiKey string) (userID, userToken string, w liveWallet) {
	t.Helper()
	out := circleCall(t, apiKey, "GET", "/v1/w3s/users?pageSize=50", "", "")
	data, _ := out["data"].(map[string]any)
	users, _ := data["users"].([]any)
	for _, u := range users {
		m, _ := u.(map[string]any)
		if m["authMode"] != "PIN" || m["pinStatus"] != "ENABLED" {
			continue
		}
		id, _ := m["id"].(string)
		tok := circleCall(t, apiKey, "POST", "/v1/w3s/users/token", "", fmt.Sprintf(`{"userId":%q}`, id))
		td, _ := tok["data"].(map[string]any)
		ut, _ := td["userToken"].(string)
		if ut == "" {
			continue
		}
		wl := circleCall(t, apiKey, "GET", "/v1/w3s/wallets", ut, "")
		wd, _ := wl["data"].(map[string]any)
		wallets, _ := wd["wallets"].([]any)
		for _, w := range wallets {
			wm, _ := w.(map[string]any)
			chain, _ := wm["blockchain"].(string)
			if chain != "ARC-TESTNET" {
				continue
			}
			addr, _ := wm["address"].(string)
			wid, _ := wm["id"].(string)
			if addr != "" && wid != "" {
				return id, ut, liveWallet{id: wid, address: addr, blockchain: chain}
			}
		}
	}
	t.Skip("no PIN-mode Circle user with an Arc wallet exists; run scripts/circle-wallet-probe.ts first")
	return "", "", liveWallet{}
}

// ── tests ───────────────────────────────────────────────────────────────────

// The whole endpoint rests on this. A caller names a wallet id; if it is not in
// the signed-in user's own list, it is not theirs and settlement must not move.
// Without this check, anyone who can reach the route could redirect a
// merchant's income to a wallet they control.
func TestSettlementWalletRejectsAWalletTheUserDoesNotOwn(t *testing.T) {
	key := circleAPIKey(t)
	srv, pool := newSettlementTestServer(t, 15541, key)
	login := "0x00000000000000000000000000000000000000c1"
	// A real token for a real user with a genuinely empty wallet list.
	circleUser, userToken := freshCircleUserToken(t, key)
	session := seedMerchant(t, pool, "acct_notowned", login, circleUser)

	resp := provision(t, srv.URL, session, userToken, `{"wallet_id":"11111111-2222-3333-4444-555555555555"}`)
	if resp.status != http.StatusForbidden {
		t.Fatalf("status=%d, want 403; body=%s", resp.status, resp.body)
	}
	if got := errCode(t, resp.body); got != "settlement_wallet_unknown" {
		t.Errorf("code=%s, want settlement_wallet_unknown", got)
	}

	addr, walletID, _ := settleAddressOf(t, pool, "acct_notowned")
	if addr != login || walletID != nil {
		t.Fatalf("a refused request still changed settlement: addr=%s wallet=%v", addr, walletID)
	}
}

// The sign-in wallet is the thing being moved AWAY from. It would pass every
// other check here and change nothing, while leaving a record claiming somebody
// chose it — which is worse than the silent default it replaced.
func TestSettlementWalletRejectsTheSignInWallet(t *testing.T) {
	key := circleAPIKey(t)
	circleUser, userToken, wallet := anyInitializedArcWallet(t, key)

	srv, pool := newSettlementTestServer(t, 15542, key)
	// The account signed in with the very wallet it is now offering.
	session := seedMerchant(t, pool, "acct_samewallet", wallet.address, circleUser)

	resp := provision(t, srv.URL, session, userToken, fmt.Sprintf(`{"wallet_id":%q}`, wallet.id))
	if resp.status != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d, want 422; body=%s", resp.status, resp.body)
	}

	_, walletID, source := settleAddressOf(t, pool, "acct_samewallet")
	if walletID != nil {
		t.Fatalf("the sign-in wallet was recorded as provisioned: %v", *walletID)
	}
	if source == nil || *source != "login_wallet" {
		t.Fatalf("source=%v, want login_wallet (unchanged)", source)
	}
}

// A real wallet of the user's, on Arc, that is not their sign-in wallet: the
// address stored must be the one CIRCLE reported, and settlement must flip to
// provisioned.
func TestSettlementWalletProvisionsFromCirclesOwnAddress(t *testing.T) {
	key := circleAPIKey(t)
	circleUser, userToken, wallet := anyInitializedArcWallet(t, key)

	srv, pool := newSettlementTestServer(t, 15543, key)
	// Signed in with something else entirely, so the wallet is a genuine second
	// address rather than the one they already had.
	session := seedMerchant(t, pool, "acct_provision", "0x00000000000000000000000000000000000000c2", circleUser)

	resp := provision(t, srv.URL, session, userToken, fmt.Sprintf(`{"wallet_id":%q}`, wallet.id))
	if resp.status != http.StatusOK {
		t.Fatalf("status=%d, want 200; body=%s", resp.status, resp.body)
	}

	addr, walletID, source := settleAddressOf(t, pool, "acct_provision")
	if !strings.EqualFold(addr, wallet.address) {
		t.Fatalf("settle_address=%s, want Circle's own %s", addr, wallet.address)
	}
	if walletID == nil || *walletID != wallet.id {
		t.Fatalf("settle_wallet_id=%v, want %s", walletID, wallet.id)
	}
	if source == nil || *source != "provisioned" {
		t.Fatalf("source=%v, want provisioned", source)
	}
}

// The browser re-runs provisioning whenever it loads an account that is not
// ready, so a repeat call is the normal case. It must not fail, must not
// rewrite, and must not need Circle — a retry that breaks whenever Circle is
// briefly unreachable is a retry that does not work.
func TestSettlementWalletProvisioningIsIdempotent(t *testing.T) {
	// Never reaches Circle: the short-circuit is above the lookup. The key is a
	// placeholder purely so the configured-check passes.
	srv, pool := newSettlementTestServer(t, 15544, "TEST_API_KEY:placeholder:placeholder")
	session := seedMerchant(t, pool, "acct_idem", "0x00000000000000000000000000000000000000c3", "")

	const walletID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	const provisioned = "0x00000000000000000000000000000000000000f1"
	if _, err := pool.Exec(context.Background(),
		`UPDATE accounts SET settle_wallet_id=$1, settle_address=$2, provisioned_address=$2,
		        settle_address_source='provisioned'
		  WHERE id='acct_idem'`, walletID, provisioned,
	); err != nil {
		t.Fatalf("seed provisioned state: %v", err)
	}

	resp := provision(t, srv.URL, session, "", fmt.Sprintf(`{"wallet_id":%q}`, walletID))
	if resp.status != http.StatusOK {
		t.Fatalf("status=%d, want 200; body=%s", resp.status, resp.body)
	}
	var out struct {
		SettleAddress         string `json:"settle_address"`
		SettlementWalletReady bool   `json:"settlement_wallet_ready"`
	}
	if err := json.Unmarshal([]byte(resp.body), &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.SettleAddress != provisioned || !out.SettlementWalletReady {
		t.Fatalf("re-call returned %+v, want the address already stored and ready", out)
	}

	addr, walletIDBack, source := settleAddressOf(t, pool, "acct_idem")
	if addr != provisioned || walletIDBack == nil || *walletIDBack != walletID || source == nil || *source != "provisioned" {
		t.Fatalf("a no-op call changed state: addr=%s wallet=%v source=%v", addr, walletIDBack, source)
	}

	// A DIFFERENT wallet is not a repeat, it is a redirection of income, and it
	// does not belong on a path the browser runs by itself.
	other := provision(t, srv.URL, session, "", `{"wallet_id":"99999999-8888-7777-6666-555555555555"}`)
	if other.status != http.StatusConflict {
		t.Fatalf("second wallet: status=%d, want 409; body=%s", other.status, other.body)
	}
}

// Personal accounts are out of scope by definition, not by oversight. A payer's
// wallet-keyed row settles to the wallet that signed in; provisioning one would
// move a payer's own money somewhere they never asked for.
func TestSettlementWalletRefusesPersonalAccounts(t *testing.T) {
	srv, pool := newSettlementTestServer(t, 15545, "TEST_API_KEY:placeholder:placeholder")
	wallet := "0x00000000000000000000000000000000000000d4"
	session := seedPersonal(t, pool, "acct_personal", wallet)

	resp := provision(t, srv.URL, session, "", `{"wallet_id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}`)
	if resp.status != http.StatusForbidden {
		t.Fatalf("status=%d, want 403; body=%s", resp.status, resp.body)
	}

	addr, walletID, source := settleAddressOf(t, pool, "acct_personal")
	if addr != wallet || walletID != nil {
		t.Fatalf("a personal account was touched: addr=%s wallet=%v", addr, walletID)
	}
	if source == nil || *source != "login_wallet" {
		t.Fatalf("source=%v, want login_wallet (untouched)", source)
	}
}

// The dashboard decides whether to run provisioning from this one field, so it
// has to be present and it has to be false rather than absent when unset.
func TestAccountMeReportsSettlementWalletReadiness(t *testing.T) {
	srv, pool := newSettlementTestServer(t, 15546, "TEST_API_KEY:placeholder:placeholder")
	session := seedMerchant(t, pool, "acct_ready", "0x00000000000000000000000000000000000000d5", "")

	read := func() (bool, *string) {
		resp := doJSON(t, srv.URL, "GET", "/v1/accounts/me", session, "", "")
		if resp.status != http.StatusOK {
			t.Fatalf("accounts/me: status=%d body=%s", resp.status, resp.body)
		}
		var out struct {
			Ready  bool    `json:"settlement_wallet_ready"`
			Source *string `json:"settle_address_source"`
		}
		if err := json.Unmarshal([]byte(resp.body), &out); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if !strings.Contains(resp.body, "settlement_wallet_ready") {
			t.Fatal("settlement_wallet_ready is absent; a client cannot tell that from false")
		}
		return out.Ready, out.Source
	}

	ready, source := read()
	if ready {
		t.Fatal("a merchant that has never provisioned reports ready")
	}
	if source == nil || *source != "login_wallet" {
		t.Fatalf("source=%v, want login_wallet", source)
	}

	if _, err := pool.Exec(context.Background(),
		`UPDATE accounts SET settle_wallet_id='w1', provisioned_address=settle_address,
		        settle_address_source='provisioned' WHERE id='acct_ready'`,
	); err != nil {
		t.Fatalf("mark provisioned: %v", err)
	}
	ready, source = read()
	if !ready {
		t.Fatal("a provisioned merchant does not report ready")
	}
	if source == nil || *source != "provisioned" {
		t.Fatalf("source=%v, want provisioned", source)
	}
}

// A business that has not been given an address of its own must not be able to
// mint a payment link, because a link outlives the decision. Printed on a
// counter and paid three weeks later, one pointing at the owner's personal
// wallet is the worst version of this bug.
func TestPaymentLinksRefusedUntilTheBusinessHasItsOwnWallet(t *testing.T) {
	srv, pool := newSettlementTestServer(t, 15547, "TEST_API_KEY:placeholder:placeholder")
	session := seedMerchant(t, pool, "acct_notready", "0x00000000000000000000000000000000000000e1", "")

	body := `{"amount_mode":"fixed","amount":50000,"settle_currency":"USD"}`
	resp := doJSON(t, srv.URL, "POST", "/v1/payment_links", session, body, "")
	if resp.status != http.StatusConflict {
		t.Fatalf("status=%d, want 409; body=%s", resp.status, resp.body)
	}
	if got := errCode(t, resp.body); got != "settlement_wallet_required" {
		t.Errorf("code=%s, want settlement_wallet_required", got)
	}

	// Once it has one, the same request goes through.
	if _, err := pool.Exec(context.Background(),
		`UPDATE accounts SET settle_wallet_id='w-ready', provisioned_address=settle_address,
		        settle_address_source='provisioned' WHERE id='acct_notready'`,
	); err != nil {
		t.Fatalf("mark provisioned: %v", err)
	}
	again := doJSON(t, srv.URL, "POST", "/v1/payment_links", session, body, "")
	if again.status != http.StatusCreated {
		t.Fatalf("after provisioning: status=%d, want 201; body=%s", again.status, again.body)
	}
}

// An API-key account named its own address when it was created. That is a
// decision somebody made, not a default nobody saw, and it must keep working --
// this check exists to catch the silent case, not to break integrations.
func TestApiKeyAccountsAreUnaffectedByTheReadinessCheck(t *testing.T) {
	srv, key, _ := newLinkTestServer(t, 15548)
	body := `{"amount_mode":"fixed","amount":1000,"settle_currency":"USD"}`
	resp := doJSON(t, srv.URL, "POST", "/v1/payment_links", key, body, "")
	if resp.status != http.StatusCreated {
		t.Fatalf("status=%d, want 201; body=%s", resp.status, resp.body)
	}
}

// An intent records where it was going when it was made.
//
// This is the property that makes changing an account's settlement address safe
// at all: a payment somebody already agreed to cannot be redirected afterwards,
// and no link has to be reissued when a merchant moves where income lands. The
// address is derived at creation and snapshotted -- never looked up at pay time.
func TestAnIntentsAddressIsSnapshottedNotLookedUp(t *testing.T) {
	srv, key, pool := newLinkTestServer(t, 15549)
	ctx := context.Background()

	var accountID, original string
	if err := pool.QueryRow(ctx,
		`SELECT id, settle_address FROM accounts WHERE parent_id IS NULL ORDER BY created_at LIMIT 1`,
	).Scan(&accountID, &original); err != nil {
		t.Fatalf("read account: %v", err)
	}

	resp := doJSON(t, srv.URL, "POST", "/v1/settlement_intents", key,
		`{"amount":"50000","settle_currency":"USD"}`, "")
	if resp.status != http.StatusCreated {
		t.Fatalf("create intent: status=%d body=%s", resp.status, resp.body)
	}
	var intent struct {
		ID            string `json:"id"`
		SettleAddress string `json:"settle_address"`
	}
	if err := json.Unmarshal([]byte(resp.body), &intent); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	// Derived from the account, not from the request -- the request did not
	// carry one and could not have.
	if !strings.EqualFold(intent.SettleAddress, original) {
		t.Fatalf("intent settles to %s, want the account's %s", intent.SettleAddress, original)
	}

	// The account moves. Directly, because the only paths that do this are
	// provisioning and the advanced external setting, and neither is what is
	// under test here.
	moved := "0x00000000000000000000000000000000000000ff"
	if _, err := pool.Exec(ctx,
		`UPDATE accounts SET settle_address = $1 WHERE id = $2`, moved, accountID,
	); err != nil {
		t.Fatalf("move the account's address: %v", err)
	}

	var stored string
	if err := pool.QueryRow(ctx,
		`SELECT settle_address FROM settlement_intents WHERE id = $1`, intent.ID,
	).Scan(&stored); err != nil {
		t.Fatalf("read intent: %v", err)
	}
	if !strings.EqualFold(stored, original) {
		t.Fatalf("the intent followed the account to %s; it must still say %s", stored, original)
	}

	// And a NEW intent picks up the new address, so the snapshot is a snapshot
	// rather than a value frozen at some earlier point.
	next := doJSON(t, srv.URL, "POST", "/v1/settlement_intents", key,
		`{"amount":"50000","settle_currency":"USD"}`, "")
	var second struct {
		SettleAddress string `json:"settle_address"`
	}
	_ = json.Unmarshal([]byte(next.body), &second)
	if !strings.EqualFold(second.SettleAddress, moved) {
		t.Fatalf("a new intent settles to %s, want the account's current %s", second.SettleAddress, moved)
	}
}
