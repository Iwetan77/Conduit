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
	"sync"
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

// Shortest secret accepted for signing sessions. 32 bytes is the output size of
// the SHA-256 the HMAC is built on; below that the key, not the hash, is the
// weakest part.
const minSessionSecretBytes = 32

// CheckSessionSecret forces the secret to be resolved, so a misconfigured one
// takes the process down at startup rather than at the first sign-in. Call it
// from main().
func CheckSessionSecret() { _ = sessionSecret() }

// Resolved on FIRST USE, not at package init.
//
// This was a package-level var, which meant it ran before main() -- so a
// devserver that reads the secret out of packages/api/.env and exports it could
// never win the race, and every restart silently minted a new random secret and
// signed the whole dashboard out. From the outside that is indistinguishable
// from the API being down.
var sessionSecret = sync.OnceValue(func() []byte {
	if v := strings.TrimSpace(os.Getenv("CONDUIT_SESSION_SECRET")); v != "" {
		if b, err := hex.DecodeString(v); err == nil && len(b) >= 32 {
			return b
		}
		// Anything that is not 32+ bytes of hex is taken as raw bytes, but only
		// if there are enough of them. This used to accept any non-empty string
		// at any length, so a short secret was honoured silently and the
		// signature on every dashboard session was brute-forceable -- a failure
		// with no symptom until it is used. Refuse to start instead.
		if len(v) < minSessionSecretBytes {
			log.Fatalf("auth: CONDUIT_SESSION_SECRET is %d bytes; it must be at least %d "+
				"(or %d+ bytes of hex). Generate one with: openssl rand -hex 32",
				len(v), minSessionSecretBytes, minSessionSecretBytes)
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
})

// NewSessionToken issues a signed session for an account at a given session
// version. The version is what makes the token revocable: it is compared
// against the account's current value on every request, so bumping that value
// invalidates every token already issued.
func NewSessionToken(accountID string, sessionVersion int) string {
	payload := fmt.Sprintf("%s.%d.%d", accountID, time.Now().Add(SessionTTL).Unix(), sessionVersion)
	mac := hmac.New(sha256.New, sessionSecret())
	mac.Write([]byte(payload))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return SessionTokenPrefix + base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + sig
}

var errBadSession = errors.New("invalid session token")

// ParseSessionToken verifies the signature and expiry, returning the account id
// and the session version the token was signed at. The caller compares that
// version against the account's current one — this function cannot, having no
// database, and a token that verifies here is not yet known to be live.
func ParseSessionToken(token string) (string, int, error) {
	if !strings.HasPrefix(token, SessionTokenPrefix) {
		return "", 0, errBadSession
	}
	rest := strings.TrimPrefix(token, SessionTokenPrefix)
	dot := strings.LastIndex(rest, ".")
	if dot < 0 {
		return "", 0, errBadSession
	}
	rawPayload, err := base64.RawURLEncoding.DecodeString(rest[:dot])
	if err != nil {
		return "", 0, errBadSession
	}
	mac := hmac.New(sha256.New, sessionSecret())
	mac.Write(rawPayload)
	want := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	// Constant time: a byte-by-byte comparison here leaks how much of a forged
	// signature was correct, which is enough to construct one.
	if subtle.ConstantTimeCompare([]byte(want), []byte(rest[dot+1:])) != 1 {
		return "", 0, errBadSession
	}

	// account id . expiry . session version. A token from before the version
	// existed has two fields and is rejected here, which signs every session
	// open at deploy time back in once.
	parts := strings.Split(string(rawPayload), ".")
	if len(parts) != 3 {
		return "", 0, errBadSession
	}
	exp, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return "", 0, errBadSession
	}
	version, err := strconv.Atoi(parts[2])
	if err != nil {
		return "", 0, errBadSession
	}
	if time.Now().Unix() > exp {
		return "", 0, fmt.Errorf("session expired")
	}
	return parts[0], version, nil
}
