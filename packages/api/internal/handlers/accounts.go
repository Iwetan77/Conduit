package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kzn-labs/conduit/api/internal/auth"
	apierrors "github.com/kzn-labs/conduit/api/internal/errors"
	"github.com/kzn-labs/conduit/api/internal/models"
)

type Accounts struct {
	Pool           *pgxpool.Pool
	PrivyVerifier  *auth.PrivyVerifier
	CircleVerifier *auth.CircleVerifier
}

type createAccountRequest struct {
	Name           string `json:"name"`
	SettleCurrency string `json:"settle_currency"`
	SettleAddress  string `json:"settle_address"`
	Livemode       bool   `json:"livemode"`
}

type accountResponse struct {
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	LogoURL        *string `json:"logo_url,omitempty"`
	SettleCurrency string  `json:"settle_currency"`
	SettleAddress  string  `json:"settle_address"`
	Livemode       bool    `json:"livemode"`
	// APIKey is only ever present in the create response, exactly once.
	APIKey *createdKey `json:"api_key,omitempty"`
}
type createdKey struct {
	Key    string `json:"key"`
	Prefix string `json:"prefix"`
	Suffix string `json:"suffix"`
}

func (h *Accounts) Create(w http.ResponseWriter, r *http.Request) {
	var req createAccountRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "body"))
		return
	}
	if req.Name == "" || req.SettleCurrency == "" || req.SettleAddress == "" {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "name, settle_currency, settle_address are required"))
		return
	}

	ctx := r.Context()
	q := queryable(ctx, h.Pool)

	accountID := models.NewID("acct")
	_, err := q.Exec(ctx,
		`INSERT INTO accounts (id, name, settle_currency, settle_address, livemode) VALUES ($1,$2,$3,$4,$5)`,
		accountID, req.Name, req.SettleCurrency, req.SettleAddress, req.Livemode,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	fullKey, prefix, suffix, hash, err := auth.GenerateKey(auth.KeyTypeSecret, req.Livemode)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	keyID := models.NewID("key")
	_, err = q.Exec(ctx,
		`INSERT INTO api_keys (id, account_id, key_hash, prefix, suffix, type, livemode) VALUES ($1,$2,$3,$4,$5,'sk',$6)`,
		keyID, accountID, hash, prefix, suffix, req.Livemode,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	writeJSON(w, http.StatusCreated, accountResponse{
		ID: accountID, Name: req.Name, SettleCurrency: req.SettleCurrency,
		SettleAddress: req.SettleAddress, Livemode: req.Livemode,
		APIKey: &createdKey{Key: fullKey, Prefix: prefix, Suffix: suffix},
	})
}

type createFromPrivyRequest struct {
	Name           string `json:"name"`
	SettleCurrency string `json:"settle_currency"`
	SettleAddress  string `json:"settle_address"` // defaults to LoginWallet if empty
	LoginWallet    string `json:"login_wallet"`   // the payer's Privy embedded wallet address
}
type privyAccountResponse struct {
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	LogoURL        *string `json:"logo_url,omitempty"`
	SettleCurrency string  `json:"settle_currency"`
	SettleAddress  string  `json:"settle_address"`
	LoginWallet    string  `json:"login_wallet"`
	Livemode       bool    `json:"livemode"`
}

// CreateFromPrivy is POST /v1/accounts/privy -- the dashboard's login
// bootstrap. Verifies the Privy access token itself (this route is NOT
// behind auth.Middleware, since a brand-new Privy user has no account yet
// for the middleware to resolve against). Idempotent: a merchant who
// already onboarded just gets their existing account back, not a
// duplicate -- the frontend calls this on every login, not only the first.
func (h *Accounts) CreateFromPrivy(w http.ResponseWriter, r *http.Request) {
	authHeader := r.Header.Get("Authorization")
	if !strings.HasPrefix(authHeader, "Bearer ") {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}
	privyUserID, err := h.PrivyVerifier.Verify(strings.TrimPrefix(authHeader, "Bearer "))
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}
	h.bootstrapAccount(w, r, auth.ProviderPrivy, privyUserID)
}

// CreateFromCircle is POST /v1/accounts/circle -- the same bootstrap for a
// Circle login. The Circle user token comes in its own header rather than as a
// Bearer token: it is Circle's credential, not a Conduit key, and must never
// be resolvable by the same path that resolves sk_/pk_ keys.
//
// Verification is a call to Circle, because unlike a Privy JWT this token is
// opaque to us. That cost is acceptable here precisely because this is the
// authentication boundary and runs once per login.
func (h *Accounts) CreateFromCircle(w http.ResponseWriter, r *http.Request) {
	if h.CircleVerifier == nil {
		writeErr(w, apierrors.E(apierrors.CodeNotFound, "circle auth is not configured"))
		return
	}
	token := strings.TrimSpace(r.Header.Get("X-Circle-User-Token"))
	if token == "" {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, "X-Circle-User-Token"))
		return
	}
	circleUserID, err := h.CircleVerifier.Verify(r.Context(), token)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}
	h.bootstrapAccount(w, r, auth.ProviderCircle, circleUserID)
}

// bootstrapAccount is the shared login bootstrap, once the caller has proven
// which (provider, subject) they are.
//
// Shared rather than copied per provider on purpose. The two flows differ only
// in how the subject is established; everything after that -- idempotency, the
// required fields, the settle-address default, which columns get written -- is
// identical, and a second copy would drift. The provider is passed in because
// it is half the identity key, never defaulted.
//
// Idempotent: a merchant who already onboarded gets their existing account
// back, not a duplicate. The frontend calls this on every login, not only the
// first.
func (h *Accounts) bootstrapAccount(w http.ResponseWriter, r *http.Request, provider, subject string) {
	ctx := r.Context()

	// Already onboarded -- return the existing account, don't re-create.
	var existing privyAccountResponse
	var loginWallet *string
	err := h.Pool.QueryRow(ctx,
		`SELECT id, name, logo_url, settle_currency, settle_address, login_wallet, livemode
		 FROM accounts WHERE auth_provider = $1 AND auth_subject = $2`,
		provider, subject,
	).Scan(&existing.ID, &existing.Name, &existing.LogoURL, &existing.SettleCurrency, &existing.SettleAddress, &loginWallet, &existing.Livemode)
	if err == nil {
		if loginWallet != nil {
			existing.LoginWallet = *loginWallet
		}
		writeJSON(w, http.StatusOK, existing)
		return
	}
	if err != pgx.ErrNoRows {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	// First login -- onboard.
	var req createFromPrivyRequest
	if decodeErr := json.NewDecoder(r.Body).Decode(&req); decodeErr != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "body"))
		return
	}
	if req.Name == "" || req.SettleCurrency == "" || req.LoginWallet == "" {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "name, settle_currency, login_wallet are required"))
		return
	}
	settleAddress := req.SettleAddress
	if settleAddress == "" {
		settleAddress = req.LoginWallet // settle address defaults to the login wallet, separately editable later
	}

	accountID := models.NewID("acct")
	// privy_user_id is written only for a Privy identity. Writing a Circle
	// subject into a column named privy_user_id would make the rollback path
	// for migration 0014 -- "fall back to privy_user_id" -- resolve Circle
	// users as Privy ones.
	var privyUserID *string
	if provider == auth.ProviderPrivy {
		privyUserID = &subject
	}
	_, err = h.Pool.Exec(ctx,
		`INSERT INTO accounts (id, name, settle_currency, settle_address, privy_user_id, auth_provider, auth_subject, login_wallet, livemode)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false)`,
		accountID, req.Name, req.SettleCurrency, settleAddress, privyUserID, provider, subject, req.LoginWallet,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	writeJSON(w, http.StatusCreated, privyAccountResponse{
		ID: accountID, Name: req.Name, SettleCurrency: req.SettleCurrency,
		SettleAddress: settleAddress, LoginWallet: req.LoginWallet, Livemode: false,
	})
}

func (h *Accounts) Get(w http.ResponseWriter, r *http.Request) {
	id := pathParam(r, "id")
	principal, _ := auth.FromContext(r.Context())

	var resp accountResponse
	err := h.Pool.QueryRow(r.Context(),
		`SELECT id, name, logo_url, settle_currency, settle_address, livemode FROM accounts WHERE id = $1 AND (id = $2 OR parent_id = $2)`,
		id, principal.AccountID,
	).Scan(&resp.ID, &resp.Name, &resp.LogoURL, &resp.SettleCurrency, &resp.SettleAddress, &resp.Livemode)
	if err != nil {
		if err == pgx.ErrNoRows {
			writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
			return
		}
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// Me is GET /v1/accounts/me -- the authenticated caller's own account,
// without needing to know its id up front (the dashboard's Settings page
// uses this to load what to edit).
func (h *Accounts) Me(w http.ResponseWriter, r *http.Request) {
	principal, _ := auth.FromContext(r.Context())

	var resp accountResponse
	err := h.Pool.QueryRow(r.Context(),
		`SELECT id, name, logo_url, settle_currency, settle_address, livemode FROM accounts WHERE id = $1`,
		principal.AccountID,
	).Scan(&resp.ID, &resp.Name, &resp.LogoURL, &resp.SettleCurrency, &resp.SettleAddress, &resp.Livemode)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

type updateAccountRequest struct {
	Name           *string `json:"name"`
	LogoURL        *string `json:"logo_url"`
	SettleCurrency *string `json:"settle_currency"`
	SettleAddress  *string `json:"settle_address"`
}

// Update is PATCH /v1/accounts/:id -- partial update, restricted to the
// caller's own account or a direct subaccount (same ownership rule as Get).
// Phase 4: this is how a merchant sets display name/logo/settle
// currency/settle address from the dashboard.
func (h *Accounts) Update(w http.ResponseWriter, r *http.Request) {
	id := pathParam(r, "id")
	principal, _ := auth.FromContext(r.Context())

	var req updateAccountRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "body"))
		return
	}
	if req.Name != nil && *req.Name == "" {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "name"))
		return
	}

	ctx := r.Context()
	tag, err := h.Pool.Exec(ctx,
		`UPDATE accounts SET
		   name = COALESCE($1, name),
		   logo_url = COALESCE($2, logo_url),
		   settle_currency = COALESCE($3, settle_currency),
		   settle_address = COALESCE($4, settle_address)
		 WHERE id = $5 AND (id = $6 OR parent_id = $6)`,
		req.Name, req.LogoURL, req.SettleCurrency, req.SettleAddress, id, principal.AccountID,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
		return
	}

	var resp accountResponse
	err = h.Pool.QueryRow(ctx,
		`SELECT id, name, logo_url, settle_currency, settle_address, livemode FROM accounts WHERE id = $1`,
		id,
	).Scan(&resp.ID, &resp.Name, &resp.LogoURL, &resp.SettleCurrency, &resp.SettleAddress, &resp.Livemode)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// CreateSub creates a subaccount (a "location" in dashboard terms) under the
// authenticated caller's account — its own settle_currency/settle_address and
// its own sk_ key, but parent_id set so Accounts.List/Get and the
// Conduit-Account header switch (auth.go) recognize it as a child. This
// endpoint isn't in the original spec's table (only bare POST /v1/accounts
// is) but the Locations dashboard screen has nothing to create rows with
// otherwise, and the schema already carries accounts.parent_id for exactly
// this.
func (h *Accounts) CreateSub(w http.ResponseWriter, r *http.Request) {
	principal, _ := auth.FromContext(r.Context())

	var req createAccountRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "body"))
		return
	}
	if req.Name == "" || req.SettleCurrency == "" || req.SettleAddress == "" {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "name, settle_currency, settle_address are required"))
		return
	}

	ctx := r.Context()
	accountID := models.NewID("acct")
	_, err := h.Pool.Exec(ctx,
		`INSERT INTO accounts (id, parent_id, name, settle_currency, settle_address, livemode) VALUES ($1,$2,$3,$4,$5,$6)`,
		accountID, principal.AccountID, req.Name, req.SettleCurrency, req.SettleAddress, req.Livemode,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	fullKey, prefix, suffix, hash, err := auth.GenerateKey(auth.KeyTypeSecret, req.Livemode)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	keyID := models.NewID("key")
	_, err = h.Pool.Exec(ctx,
		`INSERT INTO api_keys (id, account_id, key_hash, prefix, suffix, type, livemode) VALUES ($1,$2,$3,$4,$5,'sk',$6)`,
		keyID, accountID, hash, prefix, suffix, req.Livemode,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	writeJSON(w, http.StatusCreated, accountResponse{
		ID: accountID, Name: req.Name, SettleCurrency: req.SettleCurrency,
		SettleAddress: req.SettleAddress, Livemode: req.Livemode,
		APIKey: &createdKey{Key: fullKey, Prefix: prefix, Suffix: suffix},
	})
}

func (h *Accounts) List(w http.ResponseWriter, r *http.Request) {
	principal, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(),
		`SELECT id, name, logo_url, settle_currency, settle_address, livemode FROM accounts WHERE id = $1 OR parent_id = $1 ORDER BY created_at DESC`,
		principal.AccountID,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	defer rows.Close()

	var results []accountResponse
	for rows.Next() {
		var a accountResponse
		if err := rows.Scan(&a.ID, &a.Name, &a.LogoURL, &a.SettleCurrency, &a.SettleAddress, &a.Livemode); err != nil {
			writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
			return
		}
		results = append(results, a)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": results})
}

// ── API keys ────────────────────────────────────────────────────────────────
//
// A key's full secret is returned exactly once, at the moment it is created,
// and stored only as a hash. List never re-exposes it.
//
// Create exists because that "exactly once" was a dead end for storefronts: a
// storefront gets its own sk_ key at CreateSub, and a restaurant wiring its
// point-of-sale to Conduit needs that key to mint a per-bill payment link. If
// the one response carrying it is missed, the storefront's credential is real,
// live, and permanently unreachable. Minting a fresh one is the only way back.
//
// Rotation is deliberately two steps -- create the new key, deploy it, then
// revoke the old one -- rather than one atomic "rotate" that invalidates the
// running key immediately. A till mid-service must not lose its credential the
// instant someone clicks a button in a dashboard.

type ApiKeys struct{ Pool *pgxpool.Pool }

type apiKeyResponse struct {
	ID        string  `json:"id"`
	Prefix    string  `json:"prefix"`
	Suffix    string  `json:"suffix"`
	Type      string  `json:"type"`
	Livemode  bool    `json:"livemode"`
	RevokedAt *string `json:"revoked_at,omitempty"`
}

// Create implements POST /v1/accounts/{id}/api_keys: mint a new sk_ key for
// the caller's own account or one of its storefronts. The secret is in this
// response and nowhere else, ever again.
func (h *ApiKeys) Create(w http.ResponseWriter, r *http.Request) {
	accountID := pathParam(r, "id")
	principal, _ := auth.FromContext(r.Context())
	ctx := r.Context()

	// Same containment rule as Accounts.Get: your own account, or a storefront
	// beneath it. Never another merchant's, and never a sibling's.
	var livemode bool
	err := h.Pool.QueryRow(ctx,
		`SELECT livemode FROM accounts WHERE id = $1 AND (id = $2 OR parent_id = $2)`,
		accountID, principal.AccountID,
	).Scan(&livemode)
	if err != nil {
		if err == pgx.ErrNoRows {
			writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
			return
		}
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	fullKey, prefix, suffix, hash, err := auth.GenerateKey(auth.KeyTypeSecret, livemode)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	keyID := models.NewID("key")
	if _, err := h.Pool.Exec(ctx,
		`INSERT INTO api_keys (id, account_id, key_hash, prefix, suffix, type, livemode) VALUES ($1,$2,$3,$4,$5,'sk',$6)`,
		keyID, accountID, hash, prefix, suffix, livemode,
	); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"id":         keyID,
		"account_id": accountID,
		"key":        fullKey,
		"prefix":     prefix,
		"suffix":     suffix,
		"livemode":   livemode,
	})
}

// Revoke implements POST /v1/api_keys/{id}/revoke -- the second half of a
// rotation, run once the replacement key is deployed. Scoped to keys belonging
// to the caller's account or its storefronts, and idempotent: revoking an
// already-revoked key is a no-op success, not an error.
func (h *ApiKeys) Revoke(w http.ResponseWriter, r *http.Request) {
	keyID := pathParam(r, "id")
	principal, _ := auth.FromContext(r.Context())

	tag, err := h.Pool.Exec(r.Context(),
		`UPDATE api_keys SET revoked_at = now()
		 WHERE id = $1 AND revoked_at IS NULL
		   AND account_id IN (SELECT id FROM accounts WHERE id = $2 OR parent_id = $2)`,
		keyID, principal.AccountID,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	if tag.RowsAffected() == 0 {
		// Either it doesn't exist, isn't ours, or was already revoked. Confirm
		// the first two are not the case before reporting success.
		var exists bool
		if err := h.Pool.QueryRow(r.Context(),
			`SELECT true FROM api_keys WHERE id = $1
			   AND account_id IN (SELECT id FROM accounts WHERE id = $2 OR parent_id = $2)`,
			keyID, principal.AccountID,
		).Scan(&exists); err != nil {
			writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": keyID, "status": "revoked"})
}

// List returns key metadata for the caller's own account -- prefix and last
// four only, never the secret.
func (h *ApiKeys) List(w http.ResponseWriter, r *http.Request) {
	principal, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(),
		`SELECT id, prefix, suffix, type, livemode, revoked_at::text
		 FROM api_keys WHERE account_id = $1 ORDER BY created_at DESC`,
		principal.AccountID,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	defer rows.Close()

	var results []apiKeyResponse
	for rows.Next() {
		var k apiKeyResponse
		var revokedAt *string
		if err := rows.Scan(&k.ID, &k.Prefix, &k.Suffix, &k.Type, &k.Livemode, &revokedAt); err != nil {
			writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
			return
		}
		k.RevokedAt = revokedAt
		results = append(results, k)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": results})
}
