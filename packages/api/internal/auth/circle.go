package auth

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kzn-labs/conduit/api/internal/circle"
)

// ProviderCircle is the auth_provider value for a Circle-issued identity.
//
// A separate constant from ProviderPrivy rather than a shared "the current
// provider": the unique index is on (auth_provider, auth_subject), so the
// provider is half the key. During the migration both rows exist for the same
// human, and defaulting or guessing this half would resolve one person's login
// to another person's account.
const ProviderCircle = "circle"

// KeyTypeCircle marks a Principal resolved from a Circle user token. Like
// KeyTypePrivy there is no api_keys row behind it, so KeyID is empty.
const KeyTypeCircle KeyType = "circle"

// CircleVerifier resolves a Circle user token to the Circle user id.
//
// Unlike Privy, this cannot be done offline. A Privy access token is an ES256
// JWT we hold the public key for, so PrivyVerifier checks a signature locally.
// Circle's user token is opaque to us and only Circle can validate it, which
// makes verification a network call.
//
// That difference is the reason this is not simply dropped into the request
// middleware: putting a Circle round trip in front of every API call would add
// latency to all of them and make the API's availability depend on Circle's.
// It is used at the authentication boundary — the account bootstrap — where a
// login is being established, and the resulting Conduit API key carries the
// session from there.
type CircleVerifier struct {
	Client *circle.Client
}

func NewCircleVerifier(c *circle.Client) *CircleVerifier {
	if c == nil || !c.Configured() {
		return nil
	}
	return &CircleVerifier{Client: c}
}

// Verify returns the Circle user id the token belongs to.
func (v *CircleVerifier) Verify(ctx context.Context, userToken string) (string, error) {
	if v == nil || v.Client == nil {
		return "", fmt.Errorf("circle auth is not configured")
	}
	user, err := v.Client.VerifyUserToken(ctx, userToken)
	if err != nil {
		return "", err
	}
	return user.ID, nil
}

// lookupCirclePrincipal verifies a Circle user token and resolves it to an
// existing Conduit account.
//
// Returns an error rather than a synthetic principal when no account exists:
// a first-time login goes through the bootstrap handler, which has the name,
// settle currency and settle address that a real account needs and a token
// does not carry. Silently creating an under-specified account here would put
// a merchant row in the database that nothing can settle to.
func lookupCirclePrincipal(ctx context.Context, pool *pgxpool.Pool, v *CircleVerifier, userToken string) (Principal, error) {
	subject, err := v.Verify(ctx, userToken)
	if err != nil {
		return Principal{}, err
	}
	p, err := lookupAuthPrincipal(ctx, pool, ProviderCircle, subject)
	if err != nil {
		return Principal{}, err
	}
	p.KeyType = KeyTypeCircle
	return p, nil
}
