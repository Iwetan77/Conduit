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
