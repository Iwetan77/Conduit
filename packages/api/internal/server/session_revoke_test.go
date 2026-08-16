package server

import (
	"context"
	"net/http"
	"testing"

	"github.com/kzn-labs/conduit/api/internal/auth"
)

// A session token is held in localStorage for 12 hours. Clearing the browser's
// copy is not revocation -- the token keeps working wherever else it has
// reached, and nothing could stop it: no session id, no version, no deny list.
//
// This is the property that fixes: a token stops working the moment the
// account's session version moves past the one it was signed at.
func TestSessionIsRevokedByLogout(t *testing.T) {
	srv, _, pool := newLinkTestServer(t, 15516)
	ctx := context.Background()

	var accountID string
	if err := pool.QueryRow(ctx, `SELECT account_id FROM api_keys LIMIT 1`).Scan(&accountID); err != nil {
		t.Fatalf("read account: %v", err)
	}

	// A session as the login path would mint it: at the account's current
	// version, which a fresh account has as 0.
	var version int
	if err := pool.QueryRow(ctx,
		`SELECT session_version FROM accounts WHERE id = $1`, accountID).Scan(&version); err != nil {
		t.Fatalf("read session_version: %v", err)
	}
	token := auth.NewSessionToken(accountID, version)

	// It works before signing out.
	if resp := doJSON(t, srv.URL, "GET", "/v1/accounts/me", token, "", ""); resp.status != http.StatusOK {
		t.Fatalf("session before logout: status=%d body=%s", resp.status, resp.body)
	}

	// A second token, standing in for the copy that reached somewhere else.
	stolen := auth.NewSessionToken(accountID, version)

	if resp := doJSON(t, srv.URL, "POST", "/v1/auth/logout", token, "", ""); resp.status != http.StatusNoContent {
		t.Fatalf("logout: status=%d body=%s", resp.status, resp.body)
	}

	// Both are dead, not just the one that called logout. There is no
	// per-session id to revoke individually, and the case that matters is the
	// one where ending only the session in your own hand is no use.
	if resp := doJSON(t, srv.URL, "GET", "/v1/accounts/me", token, "", ""); resp.status != http.StatusUnauthorized {
		t.Errorf("session after logout: status=%d, want 401; body=%s", resp.status, resp.body)
	}
	if resp := doJSON(t, srv.URL, "GET", "/v1/accounts/me", stolen, "", ""); resp.status != http.StatusUnauthorized {
		t.Errorf("second copy after logout: status=%d, want 401; body=%s", resp.status, resp.body)
	}

	// Signing in again works, at the new version.
	if err := pool.QueryRow(ctx,
		`SELECT session_version FROM accounts WHERE id = $1`, accountID).Scan(&version); err != nil {
		t.Fatalf("re-read session_version: %v", err)
	}
	fresh := auth.NewSessionToken(accountID, version)
	if resp := doJSON(t, srv.URL, "GET", "/v1/accounts/me", fresh, "", ""); resp.status != http.StatusOK {
		t.Errorf("new session after logout: status=%d, want 200; body=%s", resp.status, resp.body)
	}
}

// An sk_ key has no session to end. Letting one bump the counter would turn a
// leaked key into a way to sign the merchant out of their own dashboard.
func TestLogoutRequiresASession(t *testing.T) {
	srv, secretKey, _ := newLinkTestServer(t, 15517)

	if resp := doJSON(t, srv.URL, "POST", "/v1/auth/logout", secretKey, "", ""); resp.status != http.StatusForbidden {
		t.Errorf("logout with an sk_ key: status=%d, want 403; body=%s", resp.status, resp.body)
	}
}
