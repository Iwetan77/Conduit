// Package circle talks to Circle's User-Controlled Wallets API — the
// non-custodial, MPC-backed wallet product behind Google sign-in.
//
// User-controlled is the only variant usable here. Circle's own StableFX guide
// and its Bridge Kit adapter both use DEVELOPER-controlled wallets, which are
// keyed by an entity secret the server holds: that makes the operator a
// custodian of every payer's funds, which is the wrong posture for a payments
// product regardless of how much simpler it is to call.
//
// Base URL note, measured rather than documented: internal/fx records that a
// TEST_API_KEY only works against api-sandbox.circle.com for StableFX, and
// that api.circle.com 401s it. The Wallets API does NOT behave that way — the
// same TEST_ key returns 200 from api.circle.com for /v1/w3s/*. So the two
// Circle products need different base URLs with the same key, and defaulting
// this one to the StableFX sandbox host would be wrong.
package circle

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/google/uuid"
)

const DefaultBaseURL = "https://api.circle.com"

// Client is a Circle Wallets API client. The API key is a server-side secret
// and must never be handed to a browser — which is the whole reason the app
// needs its own endpoints in front of this rather than calling Circle directly.
type Client struct {
	baseURL    string
	apiKey     string
	httpClient *http.Client
}

func New(baseURL, apiKey string) *Client {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	return &Client{
		baseURL:    baseURL,
		apiKey:     apiKey,
		httpClient: &http.Client{Timeout: 15 * time.Second},
	}
}

// Configured reports whether there is an API key to call with. Callers use this
// to stay off the Circle path entirely rather than emitting failing requests —
// the same graceful-degradation pattern the Privy verifier uses.
func (c *Client) Configured() bool { return c != nil && c.apiKey != "" }

// APIError is a Circle error response. Circle returns HTTP 200 with an error
// body in some cases, so status alone is not a reliable success signal.
type APIError struct {
	Status  int
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *APIError) Error() string {
	return fmt.Sprintf("circle: %s (code %d, http %d)", e.Message, e.Code, e.Status)
}

func (c *Client) post(ctx context.Context, path string, body, out any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("circle: marshal %s: %w", path, err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("circle: build %s: %w", path, err)
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("circle: %s: %w", path, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("circle: read %s: %w", path, err)
	}

	// Error bodies carry a top-level code/message; success bodies carry data.
	var envelope struct {
		Data    json.RawMessage `json:"data"`
		Code    int             `json:"code"`
		Message string          `json:"message"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return fmt.Errorf("circle: decode %s (http %d): %w", path, resp.StatusCode, err)
	}
	if envelope.Code != 0 || resp.StatusCode >= 400 {
		msg := envelope.Message
		if msg == "" {
			msg = string(raw)
		}
		return &APIError{Status: resp.StatusCode, Code: envelope.Code, Message: msg}
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(envelope.Data, out)
}

// SocialLoginSession is what a browser needs to start a Google sign-in.
//
// Neither field is a bearer credential for our API — they authorise the Web
// SDK to run one social login on one device, and are safe to hand to the
// browser that asked for them. The API key that minted them is not.
type SocialLoginSession struct {
	DeviceToken         string `json:"deviceToken"`
	DeviceEncryptionKey string `json:"deviceEncryptionKey"`
}

// StartSocialLogin issues a device token for a Google sign-in.
//
// deviceId identifies the browser, not the human — Circle's Web SDK generates
// and persists it client-side, and the same device reused across logins is
// expected. idempotencyKey is required by Circle and rejected if absent (it
// 400s with "may not be empty"), so it is generated here rather than asked of
// callers who would have no better source of one.
func (c *Client) StartSocialLogin(ctx context.Context, deviceID string) (*SocialLoginSession, error) {
	var out SocialLoginSession
	err := c.post(ctx, "/v1/w3s/users/social/token", map[string]string{
		"deviceId":       deviceID,
		"idempotencyKey": uuid.NewString(),
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// UserSession is a 60-minute session for one Circle user. Every challenge —
// creating a wallet, signing typed data — is executed against it.
type UserSession struct {
	UserToken     string `json:"userToken"`
	EncryptionKey string `json:"encryptionKey"`
}

// IssueUserToken mints a session for an existing Circle user.
func (c *Client) IssueUserToken(ctx context.Context, userID string) (*UserSession, error) {
	var out UserSession
	if err := c.post(ctx, "/v1/w3s/users/token", map[string]string{"userId": userID}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// User is a Circle user record.
type User struct {
	ID        string `json:"id"`
	Status    string `json:"status"`
	PinStatus string `json:"pinStatus"`
	AuthMode  string `json:"authMode"`
}

// CreateUser registers a user id with Circle. Used by the PIN flow; the social
// flow creates the user as a side effect of the first successful login.
func (c *Client) CreateUser(ctx context.Context, userID string) (*User, error) {
	var out User
	if err := c.post(ctx, "/v1/w3s/users", map[string]string{"userId": userID}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ── User-scoped calls ────────────────────────────────────────────────────────
//
// These carry BOTH the API key and an X-User-Token. The user token is Circle's
// own 60-minute session for one wallet owner and is what makes the call act on
// that user's behalf; the API key only identifies the app. Circle's design has
// the browser hold the user token, so these are reachable by anyone holding a
// valid one — the API key stays server-side, which is the property that
// matters, but these endpoints are not an authorization boundary of ours.

func (c *Client) doUser(ctx context.Context, method, path, userToken string, body, out any) error {
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("circle: marshal %s: %w", path, err)
		}
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return fmt.Errorf("circle: build %s: %w", path, err)
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("X-User-Token", userToken)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("circle: %s: %w", path, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("circle: read %s: %w", path, err)
	}

	var envelope struct {
		Data    json.RawMessage `json:"data"`
		Code    int             `json:"code"`
		Message string          `json:"message"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return fmt.Errorf("circle: decode %s (http %d): %w", path, resp.StatusCode, err)
	}
	if envelope.Code != 0 || resp.StatusCode >= 400 {
		msg := envelope.Message
		if msg == "" {
			msg = string(raw)
		}
		return &APIError{Status: resp.StatusCode, Code: envelope.Code, Message: msg}
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(envelope.Data, out)
}

// ErrAlreadyInitialized is Circle's code for "this user already has wallets".
// It is a success for our purposes — the caller wanted wallets to exist, and
// they do — so InitializeUser reports it distinctly rather than as a failure.
const ErrAlreadyInitialized = 155106

// InitializeUser creates the user's wallets on the given blockchains, returning
// a challenge the browser must execute (the user authorises key generation;
// the server never sees a key). Returns an empty challenge id when the user was
// already initialized.
func (c *Client) InitializeUser(ctx context.Context, userToken string, blockchains []string) (string, error) {
	var out struct {
		ChallengeID string `json:"challengeId"`
	}
	err := c.doUser(ctx, http.MethodPost, "/v1/w3s/user/initialize", userToken, map[string]any{
		"idempotencyKey": uuid.NewString(),
		"blockchains":    blockchains,
	}, &out)
	if err != nil {
		var apiErr *APIError
		if errors.As(err, &apiErr) && apiErr.Code == ErrAlreadyInitialized {
			return "", nil
		}
		return "", err
	}
	return out.ChallengeID, nil
}

// Wallet is one of a user's wallets.
type Wallet struct {
	ID          string `json:"id"`
	Address     string `json:"address"`
	Blockchain  string `json:"blockchain"`
	State       string `json:"state"`
	AccountType string `json:"accountType"`
}

// ListWallets returns the user's wallets.
func (c *Client) ListWallets(ctx context.Context, userToken string) ([]Wallet, error) {
	var out struct {
		Wallets []Wallet `json:"wallets"`
	}
	if err := c.doUser(ctx, http.MethodGet, "/v1/w3s/wallets", userToken, nil, &out); err != nil {
		return nil, err
	}
	return out.Wallets, nil
}

// SignTypedDataChallenge asks Circle to prepare an EIP-712 signature. The
// signature itself is produced in the browser when the user executes the
// returned challenge — this only sets it up.
//
// `data` is the typed-data document as a JSON STRING, not an object: Circle
// takes it verbatim so the bytes signed are exactly the bytes given, which is
// what makes the recovered signer reproducible.
func (c *Client) SignTypedDataChallenge(ctx context.Context, userToken, walletID, data string) (string, error) {
	var out struct {
		ChallengeID string `json:"challengeId"`
	}
	err := c.doUser(ctx, http.MethodPost, "/v1/w3s/user/sign/typedData", userToken, map[string]any{
		"walletId": walletID,
		"data":     data,
	}, &out)
	if err != nil {
		return "", err
	}
	return out.ChallengeID, nil
}
