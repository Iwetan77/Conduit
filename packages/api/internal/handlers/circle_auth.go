package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
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
	// Blockchains to provision wallets on.
	//
	// Arc is where Conduit settles. The rest exist so a payer signed in with
	// Google can pay from USDC they hold on another chain: Circle wallets are
	// per-blockchain, so a wallet that exists only on Arc cannot deposit into
	// Gateway from Base or Polygon, and the cross-chain path is impossible
	// without them.
	Blockchains []string
	// Fallback if the list above is rejected.
	//
	// This runs on the LOGIN path. A single blockchain identifier that Circle
	// does not accept would otherwise 400 the whole call and lock every user
	// out — a chain list is not worth taking sign-in down for.
	FallbackBlockchains []string
}

// upstream renders a failed Circle call.
//
// The error text goes to the log and only to the log. `param` is serialised
// into the response body (see errors.Error), and every /v1/auth/circle/* route
// is unauthenticated, so anything put there is readable by anyone who can
// reach the API — this previously passed err.Error(), which handed back
// whatever Circle had said verbatim.
//
// `op` is a fixed string chosen at the call site, so it names which call
// failed without carrying anything from upstream. That is enough to correlate
// a client report with the log line that has the detail.
func (h *CircleAuth) upstream(w http.ResponseWriter, op string, err error) {
	log.Printf("circle: %s failed: %v", op, err)
	writeErr(w, apierrors.E(apierrors.CodeInternal, op))
}

// approvalSpender reports whether calldata is an ERC-20 approve, and to whom.
//
// approve(address,uint256) is 4 bytes of selector, then the spender left-padded
// into 32 bytes, then the amount. Anything shorter is not a well-formed approve
// and is left alone -- this is a targeted refusal, not a calldata parser.
func approvalSpender(data string) (string, bool) {
	raw := strings.TrimPrefix(strings.TrimSpace(data), "0x")
	// 8 hex chars of selector + 64 of spender + 64 of amount.
	if len(raw) < 8+64+64 {
		return "", false
	}
	if !strings.EqualFold(raw[:8], "095ea7b3") { // approve(address,uint256)
		return "", false
	}
	return "0x" + raw[8+24:8+64], true
}

// The only spenders this app ever asks a payer to approve. Lowercase for
// comparison; addresses are compared case-insensitively because callers send
// mixed-case checksummed forms.
func allowedApprovalSpender(spender string) bool {
	allowed := []string{
		// ConduitPayroll. Read from the environment, exactly like the router
		// and from the same variable the payroll handler hands the browser as
		// its `spender` -- so the address this guard permits and the address
		// the browser is told to approve cannot drift apart. Hardcoding it
		// here would let a redeploy break payroll silently.
		//
		// It was simply missing, and the resulting refusal was correct
		// behaviour on a wrong list: every payroll run failed at the approve
		// with "approvals are only built for Conduit's own contracts", which
		// is true of the guard and false of the contract.
		strings.ToLower(strings.TrimSpace(os.Getenv("CONDUIT_PAYROLL_ADDRESS"))),
		"0x000000000022d473030f116ddee9f6b43ac78ba3", // Permit2
		"0x0077777d7eba4688bdef3e311b846f25870a19b9", // Circle Gateway Wallet
		"0x0022222abe238cc2c7bb1f21003f0a260052475b", // Circle Gateway Minter
		"0x867650f5eae8df91445971f14d89fd84f0c9a9f8", // Circle StableFX FxEscrow
	}
	// Every router this deployment has ever had, not just the current one.
	//
	// CONDUIT_ROUTER_ADDRESS accepts a comma-separated list, and this is why.
	// A router redeploy is not atomic: the API picks up the new address on its
	// next deploy, the browser picks it up on ITS next build, and in between
	// the browser asks for an approval to the router it still knows about. The
	// guard then refuses -- "approvals are only built for Conduit's own
	// contracts" -- over an approval to a contract that IS ours. Every payment
	// fails for the length of that window, which is exactly what happened.
	//
	// Accepting an old router is safe. An ERC-20 allowance to it can only be
	// spent BY it, `execute` requires msg.sender to be the payer, and the
	// cross-currency entry point takes Permit2 signatures rather than
	// allowances. A stale approval to an abandoned Conduit router is spendable
	// only by the person who granted it.
	//
	// What this must never become is a wildcard. The list is explicit, it comes
	// from configuration rather than from the request, and the whole point of
	// the guard -- refusing approve(attacker, max) inside a prompt that looks
	// like ours -- is untouched.
	for _, raw := range strings.Split(os.Getenv("CONDUIT_ROUTER_ADDRESS"), ",") {
		if v := strings.ToLower(strings.TrimSpace(raw)); v != "" {
			allowed = append(allowed, v)
		}
	}

	s := strings.ToLower(strings.TrimSpace(spender))
	for _, a := range allowed {
		if a != "" && a == s {
			return true
		}
	}
	return false
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

// offendingBlockchain finds which chain Circle complained about.
//
// Circle's rejection names the identifier it did not accept, so the retry can
// remove exactly that one rather than guessing or giving up on all of them.
// Matching on the identifiers WE sent, not on parsing Circle's message
// structure: the message wording is theirs to change, but a chain id we asked
// for either appears in it or it does not.
func offendingBlockchain(errText string, sent []string) string {
	for _, c := range sent {
		if strings.Contains(errText, c) {
			return c
		}
	}
	return ""
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
		// Never let a chain list break sign-in.
		//
		// This used to collapse straight to FallbackBlockchains, which is Arc
		// alone -- so ONE blockchain identifier Circle would not accept cost
		// that user every other chain, and with them the whole cross-chain
		// payment path, silently and permanently. The blast radius of a typo,
		// or of Circle retiring a testnet, was "this account can only ever pay
		// on Arc".
		//
		// Drop chains one at a time instead. Circle names the offending
		// identifier in its error, so the retry is targeted rather than
		// scattergun, and a user loses exactly the chain that failed.
		remaining := append([]string(nil), h.Blockchains...)
		for len(remaining) > 1 && err != nil {
			bad := offendingBlockchain(err.Error(), remaining)
			if bad == "" {
				break // Not a chain problem; the fallback below is the last resort.
			}
			log.Printf("circle: initialize rejected %s (%v); retrying without it", bad, err)
			filtered := remaining[:0:0]
			for _, c := range remaining {
				if c != bad {
					filtered = append(filtered, c)
				}
			}
			remaining = filtered
			challengeID, err = h.Client.InitializeUser(r.Context(), token, remaining)
		}
		if err != nil && len(h.FallbackBlockchains) > 0 {
			// Still failing, and we no longer know why. Retry with the minimum
			// that must work, and say loudly which chains were lost.
			log.Printf("circle: initialize with %v failed (%v); retrying with %v", h.Blockchains, err, h.FallbackBlockchains)
			challengeID, err = h.Client.InitializeUser(r.Context(), token, h.FallbackBlockchains)
		}
	}
	if err != nil {
		h.upstream(w, "initialize user", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"challenge_id": challengeID})
}

// CreateWallet is POST /v1/auth/circle/wallets — an ADDITIONAL wallet for a
// user who already has one, returned as a challenge for the browser to execute.
//
// Separate from Initialize because Circle makes it separate: /user/initialize
// answers 409 for a user who already has wallets, so first login and every
// wallet after it are genuinely different calls. A new merchant therefore runs
// two challenges, which is not a design choice available to us.
//
// Only Arc, and not because a settlement wallet on another chain would be
// unusable in principle -- because Conduit settles on Arc, so an address
// anywhere else is one no payment can reach.
func (h *CircleAuth) CreateWallet(w http.ResponseWriter, r *http.Request) {
	if !h.available(w) {
		return
	}
	token := userToken(r)
	if token == "" {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, "X-Circle-User-Token"))
		return
	}
	var req struct {
		// Carried back on the wallet in ListWallets so the browser can find the
		// one it just made. A hint for lookup, never an identity -- the server
		// re-reads the wallet by id before recording anything.
		RefID string `json:"ref_id"`
		Name  string `json:"name"`
	}
	// A body is optional here; an absent one just means no metadata.
	_ = json.NewDecoder(r.Body).Decode(&req)

	challengeID, err := h.Client.CreateWallet(r.Context(), token,
		h.FallbackBlockchains, strings.TrimSpace(req.Name), strings.TrimSpace(req.RefID))
	if err != nil {
		h.upstream(w, "create wallet", err)
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

	// Refuse to build an approval in favour of a stranger.
	//
	// This route forwards an arbitrary `to` and an arbitrary `data` to Circle
	// for anyone holding a user token. Circle still demands the user's PIN, so
	// it cannot move funds on its own -- but it will happily construct
	// `approve(attacker, max)` and present it to the user as a Conduit prompt,
	// which is the whole of a social-engineering attack against a stolen token.
	//
	// Constrained by SPENDER rather than by an allowlist of target addresses:
	// this app approves only its own contracts, while the token being approved
	// differs per chain, so an address allowlist would have to enumerate USDC
	// on every supported chain and would break a cross-chain deposit the day one
	// was missed. The spender set is small, fixed and chain-independent.
	if spender, isApprove := approvalSpender(req.Data); isApprove && !allowedApprovalSpender(spender) {
		log.Printf("circle: refused an approval to a non-Conduit spender %s", spender)
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest,
			"approvals are only built for Conduit's own contracts"))
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

// FindTransaction is GET /v1/auth/circle/transactions?wallet_id= — the
// wallet's recent transactions, newest first.
//
// The browser snapshots the ids before sending and looks for the new one
// afterwards. See circle.ListRecentTransactions for why correlation is done
// this way and not with a refId.
func (h *CircleAuth) FindTransaction(w http.ResponseWriter, r *http.Request) {
	if !h.available(w) {
		return
	}
	token := userToken(r)
	if token == "" {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, "X-Circle-User-Token"))
		return
	}
	walletID := r.URL.Query().Get("wallet_id")
	if walletID == "" {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "wallet_id"))
		return
	}
	txs, err := h.Client.ListRecentTransactions(r.Context(), token, walletID)
	if err != nil {
		h.upstream(w, "list transactions", err)
		return
	}
	out := make([]map[string]any, 0, len(txs))
	for _, tx := range txs {
		out = append(out, map[string]any{
			"id":               tx.ID,
			"state":            tx.State,
			"tx_hash":          tx.TxHash,
			"failed":           tx.Failed(),
			"error_reason":     tx.ErrorReason,
			"contract_address": tx.ContractAddress,
			"operation":        tx.Operation,
			"create_date":      tx.CreateDate,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
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
