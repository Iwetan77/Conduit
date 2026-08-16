package circle

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// loadAPIKey reads packages/api/.env directly, same pattern as
// internal/fx's loader, so `go test` works without exporting anything first.
func loadAPIKey(t *testing.T) string {
	t.Helper()
	if v := os.Getenv("CIRCLE_API_KEY"); v != "" {
		return v
	}
	_, thisFile, _, _ := runtime.Caller(0)
	envPath := filepath.Join(filepath.Dir(thisFile), "..", "..", ".env")
	data, err := os.ReadFile(envPath)
	if err != nil {
		t.Skipf("CIRCLE_API_KEY not set and %s not found: %v", envPath, err)
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "CIRCLE_API_KEY=") {
			return strings.TrimSpace(strings.TrimPrefix(line, "CIRCLE_API_KEY="))
		}
	}
	t.Skip("CIRCLE_API_KEY not found in .env")
	return ""
}

// TestStartSocialLogin_Live hits the REAL Circle Wallets API.
//
// No mocking: per the build rule against faking network calls, if this can't
// run for real it skips loudly rather than asserting against a fixture. A
// fixture here would be actively harmful — the entire question this answers is
// whether Circle's live contract matches what the migration assumes.
func TestStartSocialLogin_Live(t *testing.T) {
	c := New("", loadAPIKey(t))
	if !c.Configured() {
		t.Skip("no API key")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	// deviceId identifies a browser, not a human. Unique per run so a failure
	// can't be a stale-device artefact.
	deviceID := fmt.Sprintf("conduit-test-%d", time.Now().UnixNano())
	session, err := c.StartSocialLogin(ctx, deviceID)
	if err != nil {
		t.Fatalf("StartSocialLogin: %v", err)
	}
	if session.DeviceToken == "" || session.DeviceEncryptionKey == "" {
		t.Fatalf("empty session: %+v", session)
	}
}

// TestUserLifecycle_Live: create a user, then mint a session for it.
//
// This is the server-side half of Google sign-in. The browser half (the Web
// SDK completing the Google flow) can't run headlessly and is proven manually
// on the spike page instead.
func TestUserLifecycle_Live(t *testing.T) {
	c := New("", loadAPIKey(t))
	if !c.Configured() {
		t.Skip("no API key")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	userID := fmt.Sprintf("conduit-test-%d", time.Now().UnixNano())
	user, err := c.CreateUser(ctx, userID)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if user.ID != userID {
		t.Errorf("CreateUser returned id %q, want %q", user.ID, userID)
	}

	session, err := c.IssueUserToken(ctx, userID)
	if err != nil {
		t.Fatalf("IssueUserToken: %v", err)
	}
	if session.UserToken == "" || session.EncryptionKey == "" {
		t.Fatalf("empty user session: userToken=%d chars, encryptionKey=%d chars",
			len(session.UserToken), len(session.EncryptionKey))
	}
}

// TestAPIErrorsSurface: Circle reports some failures in the BODY of a 2xx, so
// a client that trusts the status code alone reads an error as success. Assert
// a known-bad request is actually returned as an error.
func TestAPIErrorsSurface(t *testing.T) {
	c := New("", loadAPIKey(t))
	if !c.Configured() {
		t.Skip("no API key")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	// Empty userId is rejected by Circle.
	if _, err := c.IssueUserToken(ctx, ""); err == nil {
		t.Error("expected an error for an empty userId, got nil")
	}
}
