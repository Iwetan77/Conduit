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
	Pool          *pgxpool.Pool
	PrivyVerifier *auth.PrivyVerifier
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
	token := strings.TrimPrefix(authHeader, "Bearer ")
	privyUserID, err := h.PrivyVerifier.Verify(token)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}

	ctx := r.Context()

	// Already onboarded -- return the existing account, don't re-create.
	var existing privyAccountResponse
	var loginWallet *string
	err = h.Pool.QueryRow(ctx,
		`SELECT id, name, logo_url, settle_currency, settle_address, login_wallet, livemode FROM accounts WHERE privy_user_id = $1`,
		privyUserID,
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
	_, err = h.Pool.Exec(ctx,
		`INSERT INTO accounts (id, name, settle_currency, settle_address, privy_user_id, login_wallet, livemode)
		 VALUES ($1,$2,$3,$4,$5,$6,false)`,
		accountID, req.Name, req.SettleCurrency, settleAddress, privyUserID, req.LoginWallet,
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

// ── API keys (list only — the full secret is only ever returned once, at
//    creation time inside Accounts.Create; this never re-exposes it) ──────────

type ApiKeys struct{ Pool *pgxpool.Pool }

type apiKeyResponse struct {
	ID        string  `json:"id"`
	Prefix    string  `json:"prefix"`
	Suffix    string  `json:"suffix"`
	Type      string  `json:"type"`
	Livemode  bool    `json:"livemode"`
	RevokedAt *string `json:"revoked_at,omitempty"`
}

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
