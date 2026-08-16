package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// sessionSecret resolves once, on first use, so this has to be set before any
// token is minted. init() runs before any test in the package.
func init() {
	// 64 hex chars = 32 bytes, the minimum accepted.
	os.Setenv("CONDUIT_SESSION_SECRET",
		"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
}

// sign builds a token the way NewSessionToken does, but from an arbitrary
// payload, so the tests can construct shapes the real minter never produces.
func sign(payload string) string {
	mac := hmac.New(sha256.New, sessionSecret())
	mac.Write([]byte(payload))
	return SessionTokenPrefix +
		base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." +
		base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func TestSessionTokenRoundTrip(t *testing.T) {
	token := NewSessionToken("acct_abc", 3)
	if !strings.HasPrefix(token, SessionTokenPrefix) {
		t.Fatalf("token %q lacks the %q prefix", token, SessionTokenPrefix)
	}

	id, version, err := ParseSessionToken(token)
	if err != nil {
		t.Fatalf("ParseSessionToken: %v", err)
	}
	if id != "acct_abc" {
		t.Errorf("account id = %q, want acct_abc", id)
	}
	if version != 3 {
		t.Errorf("session version = %d, want 3", version)
	}
}

// The version has to be inside the signed payload. If it were carried
// alongside, anyone holding a revoked token could restate its version and the
// account's stored value would no longer be the authority on anything.
func TestSessionVersionIsCoveredBySignature(t *testing.T) {
	valid := NewSessionToken("acct_abc", 0)

	// Take the real signature and pair it with a payload claiming version 1.
	rest := strings.TrimPrefix(valid, SessionTokenPrefix)
	sig := rest[strings.LastIndex(rest, ".")+1:]
	forgedPayload := base64.RawURLEncoding.EncodeToString(
		[]byte(fmt.Sprintf("acct_abc.%d.1", time.Now().Add(SessionTTL).Unix())))

	if _, _, err := ParseSessionToken(SessionTokenPrefix + forgedPayload + "." + sig); err == nil {
		t.Error("a token with an edited version verified; the version is not covered by the signature")
	}
}

// Tokens minted before the version existed carried two payload fields. They
// must not be accepted at an assumed version, or presenting an older token
// would walk straight past revocation.
func TestPreVersionTokensAreRejected(t *testing.T) {
	legacy := sign(fmt.Sprintf("acct_abc.%d", time.Now().Add(SessionTTL).Unix()))
	if _, _, err := ParseSessionToken(legacy); err == nil {
		t.Error("a pre-version token verified; it must be rejected")
	}
}

func TestMalformedAndExpiredTokensAreRejected(t *testing.T) {
	expired := sign(fmt.Sprintf("acct_abc.%d.0", time.Now().Add(-time.Minute).Unix()))

	cases := []struct {
		name  string
		token string
	}{
		{"empty", ""},
		{"no prefix", "acct_abc.1.0"},
		{"prefix only", SessionTokenPrefix},
		{"no signature", SessionTokenPrefix + "YWNjdF9hYmMuMS4w"},
		{"garbage payload", SessionTokenPrefix + "!!!.sig"},
		{"wrong signature", SessionTokenPrefix +
			base64.RawURLEncoding.EncodeToString([]byte("acct_abc.99999999999.0")) + ".bm90YXNpZw"},
		{"too many fields", sign(fmt.Sprintf("acct_abc.%d.0.extra", time.Now().Add(SessionTTL).Unix()))},
		{"non-numeric version", sign(fmt.Sprintf("acct_abc.%d.v1", time.Now().Add(SessionTTL).Unix()))},
		{"expired", expired},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, _, err := ParseSessionToken(tc.token); err == nil {
				t.Errorf("token %q verified, want an error", tc.token)
			}
		})
	}
}
