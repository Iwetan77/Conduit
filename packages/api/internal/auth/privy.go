package auth

import (
	"crypto/ecdsa"
	"fmt"
	"strings"

	"github.com/golang-jwt/jwt/v5"
)

// PrivyClaims is the shape of a Privy access token, per Privy's own
// documented Go verification example (docs.privy.io/authentication/
// user-authentication/access-tokens) -- confirmed live before writing this:
// Privy verification is NOT a JWKS-endpoint fetch, it's a static ES256
// public key (PEM, from the Privy Dashboard) verified with golang-jwt.
type PrivyClaims struct {
	jwt.RegisteredClaims
	// AppID lands in the standard "aud" claim (RegisteredClaims.Audience),
	// SessionID in a Privy-specific "sid" claim not otherwise needed here.
}

// PrivyVerifier holds the static ES256 public key and app ID needed to
// verify a Privy access token. Constructed once at startup from
// PRIVY_APP_ID + PRIVY_VERIFICATION_KEY (PEM) env vars.
type PrivyVerifier struct {
	appID     string
	publicKey *ecdsa.PublicKey
}

func NewPrivyVerifier(appID, verificationKeyPEM string) (*PrivyVerifier, error) {
	key, err := jwt.ParseECPublicKeyFromPEM([]byte(verificationKeyPEM))
	if err != nil {
		return nil, fmt.Errorf("auth: parse Privy verification key: %w", err)
	}
	return &PrivyVerifier{appID: appID, publicKey: key}, nil
}

// Verify checks a Privy access token's signature, issuer ("privy.io"), and
// audience (this app's Privy App ID), returning the user's Privy DID (the
// "sub" claim) on success.
func (v *PrivyVerifier) Verify(tokenString string) (privyUserID string, err error) {
	token, err := jwt.ParseWithClaims(tokenString, &PrivyClaims{}, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodECDSA); !ok {
			return nil, fmt.Errorf("unexpected signing method %v", t.Header["alg"])
		}
		return v.publicKey, nil
	}, jwt.WithIssuer("privy.io"), jwt.WithAudience(v.appID))
	if err != nil {
		return "", fmt.Errorf("auth: verify Privy token: %w", err)
	}
	claims, ok := token.Claims.(*PrivyClaims)
	if !ok || !token.Valid {
		return "", fmt.Errorf("auth: invalid Privy token claims")
	}
	if claims.Subject == "" {
		return "", fmt.Errorf("auth: Privy token missing sub claim")
	}
	return claims.Subject, nil
}

// looksLikePrivyToken distinguishes a Privy JWT (three dot-separated
// base64url segments) from this codebase's own sk_/pk_ prefixed API keys,
// so Middleware can route a single Authorization header to whichever
// verification path applies -- the existing sk_/pk_ system stays for
// programmatic/SDK access; Privy is the human login layer on top, not a
// replacement.
func looksLikePrivyToken(token string) bool {
	return strings.Count(token, ".") == 2 && !strings.HasPrefix(token, "sk_") && !strings.HasPrefix(token, "pk_")
}
