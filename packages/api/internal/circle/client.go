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
	"net/url"
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

// SignMessageChallenge prepares an EIP-191 personal_sign.
func (c *Client) SignMessageChallenge(ctx context.Context, userToken, walletID, message string, encodedByHex bool) (string, error) {
	var out struct {
		ChallengeID string `json:"challengeId"`
	}
	err := c.doUser(ctx, http.MethodPost, "/v1/w3s/user/sign/message", userToken, map[string]any{
		"walletId": walletID,
		"message":  message,
		// personal_sign carries arbitrary bytes as hex. Saying so is what stops
		// Circle signing the literal characters "0x…" instead of the bytes.
		"encodedByHex": encodedByHex,
	}, &out)
	if err != nil {
		return "", err
	}
	return out.ChallengeID, nil
}

// ContractExecution is one eth_sendTransaction, in Circle's terms.
//
// CallData is the ABI-encoded call exactly as an EIP-1193 caller already
// produces it. Circle also accepts abiFunctionSignature + abiParameters, but
// that would mean decoding calldata we were handed and re-encoding it, which
// can only introduce a difference between the call the caller asked for and
// the one that executes. The two forms are mutually exclusive.
type ContractExecution struct {
	WalletID        string
	ContractAddress string
	CallData        string
	// Amount of native currency to send, as a DECIMAL string in whole units
	// (Circle's convention here, not minor units). Empty for a pure call.
	Amount   string
	FeeLevel string
}

// CreateContractExecutionChallenge asks Circle to prepare a contract call. The
// user authorises it in the browser by executing the returned challenge;
// Circle then broadcasts. Nothing here can move funds on its own.
func (c *Client) CreateContractExecutionChallenge(ctx context.Context, userToken string, ex ContractExecution) (string, error) {
	feeLevel := ex.FeeLevel
	if feeLevel == "" {
		feeLevel = "MEDIUM"
	}
	body := map[string]any{
		"idempotencyKey":  uuid.NewString(),
		"walletId":        ex.WalletID,
		"contractAddress": ex.ContractAddress,
		"callData":        ex.CallData,
		"feeLevel":        feeLevel,
	}
	if ex.Amount != "" {
		body["amount"] = ex.Amount
	}
	var out struct {
		ChallengeID string `json:"challengeId"`
	}
	if err := c.doUser(ctx, http.MethodPost, "/v1/w3s/user/transactions/contractExecution", userToken, body, &out); err != nil {
		return "", err
	}
	return out.ChallengeID, nil
}

// Transaction is Circle's view of a submitted transaction.
//
// The whole reason this type exists is that Circle hands back an id of its own
// and a state machine, while every EIP-1193 caller expects a tx hash. TxHash
// is empty until Circle has actually broadcast.
type Transaction struct {
	ID          string `json:"id"`
	State       string `json:"state"`
	TxHash      string `json:"txHash"`
	Blockchain  string `json:"blockchain"`
	ErrorReason string `json:"errorReason"`
	WalletID    string `json:"walletId"`
	// The contract called. Used to confirm a newly-appeared transaction is the
	// one just sent rather than something else the wallet did.
	ContractAddress string `json:"contractAddress"`
	Operation       string `json:"operation"`
	CreateDate      string `json:"createDate"`
}

// Terminal failure states. A transaction in any of these will never produce a
// hash, so a poller that waits for one would spin until its own timeout and
// then report "timed out" for something that had already definitively failed.
func (t Transaction) Failed() bool {
	switch t.State {
	case "FAILED", "DENIED", "CANCELLED":
		return true
	}
	return false
}

// ListRecentTransactions returns a wallet's most recent transactions, newest
// first.
//
// This is how the browser gets from "the challenge completed" to a tx hash,
// and the route is indirect because Circle offers no direct one: the create
// call returns only a challengeId, and a completed CREATE_TRANSACTION
// challenge reports the challenge's own type and status — no transaction id
// anywhere.
//
// Tagging the execution with refId was the obvious answer and does not work.
// Circle accepts refId on a contract execution and then omits it from every
// transaction it returns, so the tag is write-only. Verified against the live
// API, not inferred: a completed contract execution comes back with id, state,
// txHash, contractAddress and createDate, and no refId field at all.
//
// So the caller correlates instead — snapshot the ids before sending, and the
// new one afterwards is the send. That stays correct even with two sends in
// flight, which "take the most recent" would not.
func (c *Client) ListRecentTransactions(ctx context.Context, userToken, walletID string) ([]Transaction, error) {
	var out struct {
		Transactions []Transaction `json:"transactions"`
	}
	q := url.Values{}
	q.Set("walletIds", walletID)
	q.Set("order", "DESC")
	q.Set("pageSize", "20")
	// Without includeAll, Circle filters to tokens it monitors. Conduit's
	// currencies on Arc are not all in that set, and a transaction missing
	// from the list is indistinguishable from one that has not happened yet.
	q.Set("includeAll", "true")
	if err := c.doUser(ctx, http.MethodGet, "/v1/w3s/transactions?"+q.Encode(), userToken, nil, &out); err != nil {
		return nil, err
	}
	return out.Transactions, nil
}

// GetTransaction reads one transaction by Circle's id.
func (c *Client) GetTransaction(ctx context.Context, userToken, id string) (*Transaction, error) {
	var out struct {
		Transaction Transaction `json:"transaction"`
	}
	if err := c.doUser(ctx, http.MethodGet, "/v1/w3s/transactions/"+url.PathEscape(id), userToken, nil, &out); err != nil {
		return nil, err
	}
	return &out.Transaction, nil
}
