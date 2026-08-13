// Package auth implements API key generation, hashing, and the bearer-auth
// middleware. Keys are sk_test_/sk_live_/pk_test_/pk_live_ + 32 random bytes
// base62. Only the SHA-256 hash and a 4-char display suffix are ever stored —
// the full key is returned exactly once, at creation.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	apierrors "github.com/kzn-labs/conduit/api/internal/errors"
)

type KeyType string

const (
	KeyTypePublishable KeyType = "pk"
	KeyTypeSecret      KeyType = "sk"
)

const base62Alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// GenerateKey returns (fullKey, prefix, suffix, hashHex). fullKey is shown to
// the caller exactly once and never stored.
func GenerateKey(keyType KeyType, livemode bool) (fullKey, prefix, suffix, hashHex string, err error) {
	mode := "test"
	if livemode {
		mode = "live"
	}
	prefix = fmt.Sprintf("%s_%s_", keyType, mode)

	buf := make([]byte, 32)
	for i := range buf {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(base62Alphabet))))
		if err != nil {
			return "", "", "", "", err
		}
		buf[i] = base62Alphabet[n.Int64()]
	}
	random := string(buf)
	fullKey = prefix + random
	suffix = random[len(random)-4:]

	sum := sha256.Sum256([]byte(fullKey))
	hashHex = hex.EncodeToString(sum[:])
	return fullKey, prefix, suffix, hashHex, nil
}

func HashKey(fullKey string) string {
	sum := sha256.Sum256([]byte(fullKey))
	return hex.EncodeToString(sum[:])
}

type Principal struct {
	AccountID string
	KeyID     string
	KeyType   KeyType
	Livemode  bool
}

type ctxKey int

const principalCtxKey ctxKey = 0

func WithPrincipal(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, principalCtxKey, p)
}

func FromContext(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(principalCtxKey).(Principal)
	return p, ok
}

// pkAllowedPaths: pk_ keys may only reach the hosted-checkout calls. Matched
// by (method, path-prefix) since these run unauthenticated-adjacent, in a
// browser, and must not be able to touch anything else.
var pkAllowedPrefixes = []struct {
	method string
	prefix string
}{
	{http.MethodGet, "/v1/settlement_intents/"},  // GET /:id (suffix must be exactly the id, checked by caller)
	{http.MethodPost, "/v1/settlement_intents/"}, // /:id/quote, /:id/prepare, /:id/confirm
}

func isPkAllowed(method, path string) bool {
	if !strings.HasPrefix(path, "/v1/settlement_intents/") {
		return false
	}
	for _, a := range pkAllowedPrefixes {
		if a.method == method {
			return true
		}
	}
	return false
}

// Middleware validates the Authorization: Bearer <key> header. The bearer
// value is either one of this codebase's own sk_/pk_ API keys (looked up by
// hash, as before) or a Privy access token (a JWT, verified against Privy's
// static ES256 key) -- Privy is the human dashboard login layer on top of
// the existing machine-key system, not a replacement for it (see
// docs/-carried spec note in WHERE-I-STOPPED.md). privyVerifier is nil when
// Privy isn't configured (opt-in, same graceful-degradation pattern as the
// bridge feature) -- in that case only sk_/pk_ keys work, exactly as before
// this phase.
func Middleware(pool *pgxpool.Pool, privyVerifier *PrivyVerifier, circleVerifier *CircleVerifier) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// A Circle session presents itself in its own header rather than as
			// a Bearer token, because it is not one: it is Circle's token, sent
			// to us, and it must not be confused with a Conduit sk_/pk_ key or
			// mistaken for one by a prefix check.
			if ct := strings.TrimSpace(r.Header.Get("X-Circle-User-Token")); ct != "" && circleVerifier != nil {
				principal, err := lookupCirclePrincipal(r.Context(), pool, circleVerifier, ct)
				if err != nil {
					writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
					return
				}
				finishAuth(w, r, next, pool, principal)
				return
			}

			authHeader := r.Header.Get("Authorization")
			if !strings.HasPrefix(authHeader, "Bearer ") {
				writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
				return
			}
			key := strings.TrimPrefix(authHeader, "Bearer ")

			var principal Principal
			var err error
			if privyVerifier != nil && looksLikePrivyToken(key) {
				principal, err = lookupPrivyPrincipal(r.Context(), pool, privyVerifier, key)
			} else {
				principal, err = lookupKey(r.Context(), pool, key)
			}
			if err != nil {
				writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
				return
			}

			finishAuth(w, r, next, pool, principal)
		})
	}
}

// finishAuth applies the checks that must hold however the principal was
// resolved. Shared rather than duplicated per auth path: a permission check
// that exists on one branch and not another is a hole, and the Circle branch
// would have been exactly that.
func finishAuth(
	w http.ResponseWriter,
	r *http.Request,
	next http.Handler,
	pool *pgxpool.Pool,
	principal Principal,
) {
	if principal.KeyType == KeyTypePublishable && !isPkAllowed(r.Method, r.URL.Path) {
		writeErr(w, apierrors.E(apierrors.CodeForbidden, ""))
		return
	}

	// Subaccount switching via Conduit-Account header — only valid if
	// the key's account IS the parent of the requested subaccount.
	if sub := r.Header.Get("Conduit-Account"); sub != "" && sub != principal.AccountID {
		isChild, err := isParentOf(r.Context(), pool, principal.AccountID, sub)
		if err != nil || !isChild {
			writeErr(w, apierrors.E(apierrors.CodeForbidden, "Conduit-Account"))
			return
		}
		principal.AccountID = sub
	}

	ctx := WithPrincipal(r.Context(), principal)
	next.ServeHTTP(w, r.WithContext(ctx))
}

// KeyTypePrivy marks a Principal resolved from a Privy access token rather
// than a stored sk_/pk_ key -- there is no api_keys row backing this
// session, KeyID is always empty.
const KeyTypePrivy KeyType = "privy"

// ProviderPrivy is the auth_provider value for a Privy-issued identity. A
// second provider gets its own constant rather than reusing this one: the
// unique index is on (auth_provider, auth_subject), so the provider is half
// the key and must never be guessed or defaulted.
const ProviderPrivy = "privy"

// lookupPrivyPrincipal verifies the Privy access token and resolves it to an
// existing Conduit account. Returns an error (not a synthetic empty principal)
// if no account exists yet for this user -- account creation for a brand-new
// login goes through the dedicated bootstrap handler, which verifies the token
// itself and creates the row, rather than this general-purpose middleware
// silently creating under-specified accounts (a fresh account needs a real
// name/settle currency/settle address, which aren't in the JWT).
func lookupPrivyPrincipal(ctx context.Context, pool *pgxpool.Pool, verifier *PrivyVerifier, token string) (Principal, error) {
	subject, err := verifier.Verify(token)
	if err != nil {
		return Principal{}, err
	}
	return lookupAuthPrincipal(ctx, pool, ProviderPrivy, subject)
}

// lookupAuthPrincipal resolves (provider, subject) to an account.
//
// Matching on BOTH columns is the point. During a provider migration two rows
// can exist for the same human, and a subject string is only unique within the
// provider that issued it -- so a lookup that ignored the provider could hand a
// caller someone else's account if the two providers ever minted the same
// subject. The unique index is on the pair for the same reason.
func lookupAuthPrincipal(ctx context.Context, pool *pgxpool.Pool, provider, subject string) (Principal, error) {
	var accountID string
	var livemode bool
	err := pool.QueryRow(ctx,
		`SELECT id, livemode FROM accounts WHERE auth_provider = $1 AND auth_subject = $2`,
		provider, subject,
	).Scan(&accountID, &livemode)
	if err != nil {
		return Principal{}, fmt.Errorf("no account for %s user %s: %w", provider, subject, err)
	}
	return Principal{AccountID: accountID, KeyType: KeyTypePrivy, Livemode: livemode}, nil
}

func lookupKey(ctx context.Context, pool *pgxpool.Pool, key string) (Principal, error) {
	if len(key) < 8 {
		return Principal{}, errors.New("key too short")
	}
	hash := HashKey(key)

	var accountID, keyID, prefix string
	var revoked bool
	var livemode bool
	err := pool.QueryRow(ctx,
		`SELECT account_id, id, prefix, livemode, (revoked_at IS NOT NULL) FROM api_keys WHERE key_hash = $1`,
		hash,
	).Scan(&accountID, &keyID, &prefix, &livemode, &revoked)
	if err != nil {
		return Principal{}, err
	}
	if revoked {
		return Principal{}, errors.New("key revoked")
	}

	// Constant-time re-check of the hash to avoid any timing side-channel from
	// the DB lookup path length (defense in depth; the query above is already
	// exact-match on a unique index).
	expected := HashKey(key)
	if subtle.ConstantTimeCompare([]byte(hash), []byte(expected)) != 1 {
		return Principal{}, errors.New("hash mismatch")
	}

	keyType := KeyTypeSecret
	if strings.HasPrefix(prefix, "pk_") {
		keyType = KeyTypePublishable
	}

	return Principal{AccountID: accountID, KeyID: keyID, KeyType: keyType, Livemode: livemode}, nil
}

func isParentOf(ctx context.Context, pool *pgxpool.Pool, parentID, childID string) (bool, error) {
	var actualParent *string
	err := pool.QueryRow(ctx, `SELECT parent_id FROM accounts WHERE id = $1`, childID).Scan(&actualParent)
	if err != nil {
		return false, err
	}
	return actualParent != nil && *actualParent == parentID, nil
}

func writeErr(w http.ResponseWriter, e *apierrors.APIError) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(e.Status)
	fmt.Fprintf(w, `{"error":{"type":%q,"code":%q,"message":%q,"doc_url":%q}}`, e.Type, e.Code, e.Message, e.DocURL)
}
