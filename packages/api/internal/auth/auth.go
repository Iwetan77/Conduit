// Package auth implements API key generation, hashing, and the bearer-auth
// middleware. Keys are sk_test_/sk_live_ + 32 random bytes
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
	// Retained for the api_keys.type CHECK constraint and for old rows. Nothing
	// mints one and nothing accepts one -- see lookupKey.
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

// The pk_ scope predicate that used to live here is gone with the concept --
// see lookupKey. Publishable keys are refused outright, so there is no longer a
// set of routes they may reach.

// Middleware validates the Authorization: Bearer <key> header. The bearer value
// is either one of this codebase's own sk_/pk_ API keys (looked up by hash) or
// a Conduit session token (cs_..., HMAC-verified locally). A Circle session
// arrives separately, in X-Circle-User-Token.
//
// A third branch used to sit between them: a Privy access token, a JWT verified
// against Privy's static ES256 key. It was removed in Phase 7 of the Circle
// migration. Note what replaced it -- not "the Circle equivalent", but the
// session token. Verifying a provider's JWT on every request put that provider
// on the hot path of the whole API; a cs_ token is minted once at sign-in and
// checked with a local HMAC, which is why there is deliberately no
// "verify a Circle token on every request" branch here.
func Middleware(pool *pgxpool.Pool, circleVerifier *CircleVerifier) func(http.Handler) http.Handler {
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
			// Conduit's own session first: a local HMAC check and one row read,
			// with no identity provider in the path.
			if strings.HasPrefix(key, SessionTokenPrefix) {
				principal, err = lookupSessionPrincipal(r.Context(), pool, key)
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

// KeyTypePrivy and ProviderPrivy stood here, alongside lookupPrivyPrincipal.
// Removed in Phase 7. ProviderPrivy is deliberately NOT kept as a legacy
// constant: accounts.auth_provider can still hold 'privy' on old rows, but
// nothing in this codebase should be able to resolve one, and leaving the
// constant around is how that quietly comes back.

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
	// KeyType is the CALLER's to set -- it knows which provider it verified.
	// This used to hard-code KeyTypePrivy and the Circle path overwrote it,
	// which meant the default was wrong for every caller that forgot to.
	return Principal{AccountID: accountID, Livemode: livemode}, nil
}

// lookupSessionPrincipal resolves a Conduit session token to its account.
//
// The account row is still read rather than trusted from the token: an account
// can be deleted or change livemode after the token was signed, and a session
// that outlived its account would be authenticated against nothing.
func lookupSessionPrincipal(ctx context.Context, pool *pgxpool.Pool, token string) (Principal, error) {
	accountID, tokenVersion, err := ParseSessionToken(token)
	if err != nil {
		return Principal{}, err
	}
	var livemode bool
	var currentVersion int
	if err := pool.QueryRow(ctx,
		`SELECT livemode, session_version FROM accounts WHERE id = $1`, accountID,
	).Scan(&livemode, &currentVersion); err != nil {
		return Principal{}, fmt.Errorf("no account for session %s: %w", accountID, err)
	}
	// A valid signature only proves we issued the token, not that it is still
	// meant to work. The account's version is the authority; signing out bumps
	// it, and every token signed at an earlier one dies with it.
	if tokenVersion != currentVersion {
		return Principal{}, errors.New("session revoked")
	}
	return Principal{AccountID: accountID, KeyType: KeyTypeSession, Livemode: livemode}, nil
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

	// A pk_ key is not a credential.
	//
	// Publishable keys were documented as a product surface and never issued --
	// every GenerateKey call site mints sk_ -- and they would have granted
	// access to routes that need no credential at all, since the hosted-checkout
	// actions live in the public route group. That is surface area with no
	// capability behind it, so the concept is gone.
	//
	// Rejected here rather than simply forgotten. keyType below defaults to
	// SECRET, so dropping the pk_ branch without this would have promoted any
	// row that already carries a pk_ prefix from "scoped" to "full access" --
	// deleting a restriction instead of the feature. Failing closed means an
	// existing row, or one inserted by hand, authenticates nothing.
	if strings.HasPrefix(prefix, "pk_") {
		return Principal{}, errors.New("publishable keys are not accepted")
	}

	keyType := KeyTypeSecret

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
