package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"time"
)

// Conduit's own dashboard session.
//
// Exists to get an identity provider off the hot path. Verifying a Circle user
// token means calling Circle, so with Circle as the request credential every
// single API call paid a round trip: measured at 280ms on a good one and 7.6s
// on a bad one, on a dashboard that polls. That is not a latency regression to
// tune later, it is the wrong shape — it also puts Circle's availability in
// front of every request this API serves.
//
// So the provider authenticates the LOGIN, and this token carries the session
// afterwards. It is verified with a local HMAC and one database lookup, which
// is what the sk_/pk_ path already costs. Circle's token is then only needed
// where it genuinely is: signing, in the browser.
//
// Deliberately not a JWT. There is no third party to interoperate with, no key
// distribution problem, and no algorithm negotiation worth inheriting — a
// signed account id with an expiry is the whole requirement.

const SessionTokenPrefix = "cs_"

// KeyTypeSession marks a Principal resolved from a Conduit session token.
// There is no api_keys row behind it, so KeyID stays empty.
const KeyTypeSession KeyType = "session"

// How long a dashboard session lasts. Longer than Circle's 60-minute user
// token on purpose: a merchant's dashboard session is ours to define, and
// tying it to the provider's token would sign people out mid-task for a reason
// that has nothing to do with them.
const SessionTTL = 12 * time.Hour

var sessionSecret = func() []byte {
	if v := strings.TrimSpace(os.Getenv("CONDUIT_SESSION_SECRET")); v != "" {
		if b, err := hex.DecodeString(v); err == nil && len(b) >= 32 {
			return b
		}
		return []byte(v)
	}
	// No configured secret: generate one for this process. Sessions then die
	// with a restart, which is correct for local development and loudly wrong
	// for a deployment running more than one instance — hence the warning
	// rather than a silent default that would fail as intermittent logouts.
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("auth: cannot generate a session secret: " + err.Error())
	}
	log.Printf("auth: CONDUIT_SESSION_SECRET is not set — dashboard sessions will not survive a restart and will not work across multiple instances")
	return b
}()

// NewSessionToken issues a signed session for an account.
func NewSessionToken(accountID string) string {
	payload := fmt.Sprintf("%s.%d", accountID, time.Now().Add(SessionTTL).Unix())
	mac := hmac.New(sha256.New, sessionSecret)
	mac.Write([]byte(payload))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return SessionTokenPrefix + base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + sig
}

var errBadSession = errors.New("invalid session token")

// ParseSessionToken verifies the signature and expiry, returning the account id.
func ParseSessionToken(token string) (string, error) {
	if !strings.HasPrefix(token, SessionTokenPrefix) {
		return "", errBadSession
	}
	rest := strings.TrimPrefix(token, SessionTokenPrefix)
	dot := strings.LastIndex(rest, ".")
	if dot < 0 {
		return "", errBadSession
	}
	rawPayload, err := base64.RawURLEncoding.DecodeString(rest[:dot])
	if err != nil {
		return "", errBadSession
	}
	mac := hmac.New(sha256.New, sessionSecret)
	mac.Write(rawPayload)
	want := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	// Constant time: a byte-by-byte comparison here leaks how much of a forged
	// signature was correct, which is enough to construct one.
	if subtle.ConstantTimeCompare([]byte(want), []byte(rest[dot+1:])) != 1 {
		return "", errBadSession
	}

	parts := strings.Split(string(rawPayload), ".")
	if len(parts) != 2 {
		return "", errBadSession
	}
	exp, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return "", errBadSession
	}
	if time.Now().Unix() > exp {
		return "", fmt.Errorf("session expired")
	}
	return parts[0], nil
}
