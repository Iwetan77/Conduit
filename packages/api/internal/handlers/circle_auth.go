package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/kzn-labs/conduit/api/internal/circle"
	apierrors "github.com/kzn-labs/conduit/api/internal/errors"
)

// CircleAuth fronts Circle's User-Controlled Wallets API for the browser.
//
// It exists for one reason: the Circle API key is a server-side secret. The Web
// SDK needs device tokens and challenge ids that only an API-key-holder can
// mint, so those calls have to happen here. Everything the browser receives —
// device token, user token, challenge id — is scoped by Circle to one user or
// one device, and is meant to be held client-side.
//
// These routes are deliberately NOT behind auth.Middleware. A user signing in
// for the first time has no Conduit account and no key to present; the identity
// being established IS the point of the call. Circle's own token is what
// authorises the user-scoped ones.
type CircleAuth struct {
	Client *circle.Client
	// Blockchains the wallet is created on. Arc is where Conduit settles;
	// anything else would produce a wallet that can't pay.
	Blockchains []string
}

// upstream renders a failed Circle call.
//
// E(CodeInternal, …) puts the detail in `param` and serves the registry's
// "An internal error occurred." as the message, so a client that reads
// `message` — every client — sees nothing about the cause. Nothing logged it
// either, which left a failing Circle call with no observable cause anywhere:
// not in the response, not in the API log. Log it here so the server always
// knows what Circle actually said.
func (h *CircleAuth) upstream(w http.ResponseWriter, op string, err error) {
	log.Printf("circle: %s failed: %v", op, err)
	writeErr(w, apierrors.E(apierrors.CodeInternal, err.Error()))
}

func (h *CircleAuth) available(w http.ResponseWriter) bool {
	if h.Client == nil || !h.Client.Configured() {
		writeErr(w, apierrors.E(apierrors.CodeNotFound, "circle wallets are not configured"))
		return false
	}
	return true
}

// userToken reads Circle's session token from the request. Sent as a header
// rather than in the body so it never lands in a URL or a request log.
func userToken(r *http.Request) string {
	return strings.TrimSpace(r.Header.Get("X-Circle-User-Token"))
}

// StartLogin is POST /v1/auth/circle/device — step one of Google sign-in.
// Returns the device token the Web SDK needs to run the OAuth flow.
func (h *CircleAuth) StartLogin(w http.ResponseWriter, r *http.Request) {
	if !h.available(w) {
		return
	}
	var req struct {
		DeviceID string `json:"device_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.DeviceID) == "" {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "device_id"))
		return
	}

	session, err := h.Client.StartSocialLogin(r.Context(), req.DeviceID)
	if err != nil {
		h.upstream(w, "device token", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"device_token":          session.DeviceToken,
		"device_encryption_key": session.DeviceEncryptionKey,
	})
}

// Initialize is POST /v1/auth/circle/initialize — creates the signed-in user's
// wallets. Returns an empty challenge_id when they already exist, which the
// browser treats as "nothing to execute", not as an error.
func (h *CircleAuth) Initialize(w http.ResponseWriter, r *http.Request) {
	if !h.available(w) {
		return
	}
	token := userToken(r)
	if token == "" {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, "X-Circle-User-Token"))
		return
	}
	challengeID, err := h.Client.InitializeUser(r.Context(), token, h.Blockchains)
	if err != nil {
		h.upstream(w, "initialize user", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"challenge_id": challengeID})
}

// Wallets is GET /v1/auth/circle/wallets — the signed-in user's wallets.
func (h *CircleAuth) Wallets(w http.ResponseWriter, r *http.Request) {
	if !h.available(w) {
		return
	}
	token := userToken(r)
	if token == "" {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, "X-Circle-User-Token"))
		return
	}
	wallets, err := h.Client.ListWallets(r.Context(), token)
	if err != nil {
		h.upstream(w, "list wallets", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": wallets})
}

// SignTypedData is POST /v1/auth/circle/sign_typed_data — prepares an EIP-712
// signature. The signature is produced in the browser when the user executes
// the returned challenge; nothing here can sign on a user's behalf.
func (h *CircleAuth) SignTypedData(w http.ResponseWriter, r *http.Request) {
	if !h.available(w) {
		return
	}
	token := userToken(r)
	if token == "" {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, "X-Circle-User-Token"))
		return
	}
	var req struct {
		WalletID string          `json:"wallet_id"`
		Data     json.RawMessage `json:"data"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.WalletID == "" || len(req.Data) == 0 {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "wallet_id, data"))
		return
	}

	// Circle takes the typed-data document as a STRING and signs it verbatim.
	// Forwarding the caller's raw JSON — rather than decoding and re-encoding
	// it — keeps the signed bytes byte-identical to what the caller intended,
	// which is what makes the recovered signer reproducible. A round trip
	// through a Go map would reorder keys and change the hash.
	challengeID, err := h.Client.SignTypedDataChallenge(r.Context(), token, req.WalletID, string(req.Data))
	if err != nil {
		h.upstream(w, "sign typed data", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"challenge_id": challengeID})
}

// SignMessage is POST /v1/auth/circle/sign_message — prepares an EIP-191
// personal_sign.
func (h *CircleAuth) SignMessage(w http.ResponseWriter, r *http.Request) {
	if !h.available(w) {
		return
	}
	token := userToken(r)
	if token == "" {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, "X-Circle-User-Token"))
		return
	}
	var req struct {
		WalletID     string `json:"wallet_id"`
		Message      string `json:"message"`
		EncodedByHex bool   `json:"encoded_by_hex"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.WalletID == "" || req.Message == "" {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "wallet_id, message"))
		return
	}
	challengeID, err := h.Client.SignMessageChallenge(r.Context(), token, req.WalletID, req.Message, req.EncodedByHex)
	if err != nil {
		h.upstream(w, "sign message", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"challenge_id": challengeID})
}

// ContractExecution is POST /v1/auth/circle/contract_execution — one
// eth_sendTransaction. Returns a challenge the user must execute; Circle
// broadcasts only after they authorise it.
func (h *CircleAuth) ContractExecution(w http.ResponseWriter, r *http.Request) {
	if !h.available(w) {
		return
	}
	token := userToken(r)
	if token == "" {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, "X-Circle-User-Token"))
		return
	}
	var req struct {
		WalletID string `json:"wallet_id"`
		To       string `json:"to"`
		Data     string `json:"data"`
		Amount   string `json:"amount"`
		FeeLevel string `json:"fee_level"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.WalletID == "" || req.To == "" {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "wallet_id, to"))
		return
	}
	// Calldata is forwarded verbatim. Re-encoding a call we were handed is the
	// one way to execute something other than what the caller asked for.
	challengeID, err := h.Client.CreateContractExecutionChallenge(r.Context(), token, circle.ContractExecution{
		WalletID:        req.WalletID,
		ContractAddress: req.To,
		CallData:        req.Data,
		Amount:          req.Amount,
		FeeLevel:        req.FeeLevel,
	})
	if err != nil {
		h.upstream(w, "contract execution", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"challenge_id": challengeID})
}

// Transaction is GET /v1/auth/circle/transactions/{id} — the bridge between
// Circle's transaction id and the tx hash every EIP-1193 caller expects. The
// browser polls this until a hash exists or the transaction fails.
func (h *CircleAuth) Transaction(w http.ResponseWriter, r *http.Request) {
	if !h.available(w) {
		return
	}
	token := userToken(r)
	if token == "" {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, "X-Circle-User-Token"))
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "id"))
		return
	}
	tx, err := h.Client.GetTransaction(r.Context(), token, id)
	if err != nil {
		h.upstream(w, "get transaction", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":           tx.ID,
		"state":        tx.State,
		"tx_hash":      tx.TxHash,
		"failed":       tx.Failed(),
		"error_reason": tx.ErrorReason,
	})
}
