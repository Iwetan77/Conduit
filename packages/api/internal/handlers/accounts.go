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
	CircleVerifier *auth.CircleVerifier
}

type createAccountRequest struct {
	Name           string `json:"name"`
	SettleCurrency string `json:"settle_currency"`
	SettleAddress  string `json:"settle_address"`
	Livemode       bool   `json:"livemode"`
}

type accountResponse struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	LogoURL *string `json:"logo_url,omitempty"`
	// Null until claimed. The app uses exactly this to decide whether to ask
	// for one, so it must be present on the response rather than omitted when
	// empty -- an absent field and an unclaimed name would be indistinguishable.
	Username       *string `json:"username"`
	SettleCurrency string  `json:"settle_currency"`
	SettleAddress  string  `json:"settle_address"`
	// False until the owner has explicitly said where business income should
	// land. The dashboard gates on this, so it must be present on every
	// response rather than omitted when unset -- absent and false have to mean
	// the same thing to a client, and only one of them does if it is omitted.
	PayoutConfirmed bool `json:"payout_confirmed"`
	// Whether this account has a settlement wallet of its own yet.
	//
	// Present on every response rather than omitted when false, for the same
	// reason as PayoutConfirmed above: the dashboard decides whether to run
	// provisioning from exactly this field, and an absent one has to mean the
	// same thing as false to a client.
	SettlementWalletReady bool `json:"settlement_wallet_ready"`
	// How settle_address was arrived at. Null on rows written before the
	// writers set it -- which is a real state, not an error, so it is nullable
	// rather than defaulted to something that would be a claim.
	SettleAddressSource *string `json:"settle_address_source"`
	Livemode            bool    `json:"livemode"`
	// APIKey is only ever present in the create response, exactly once.
	APIKey *createdKey `json:"api_key,omitempty"`
}
type createdKey struct {
	Key    string `json:"key"`
	Prefix string `json:"prefix"`
	Suffix string `json:"suffix"`
}

// storefrontSource is the source a storefront records for the address it
// inherited.
//
// Never 'provisioned', whatever the parent says: no wallet was created for this
// row, so claiming one would be false and the present-together constraint would
// refuse it anyway. A storefront under a provisioned parent holds that parent's
// address, which from the storefront's own point of view came from outside it.
// bootstrapSource says where a freshly bootstrapped account's address came
// from: the wallet that signed in, or something the caller named.
func bootstrapSource(settleAddress, loginWallet string) string {
	if loginWallet != "" && strings.EqualFold(settleAddress, loginWallet) {
		return sourceLoginWallet
	}
	return sourceExternal
}

func storefrontSource(parent *string) string {
	if parent != nil && *parent == sourceLoginWallet {
		return sourceLoginWallet
	}
	return sourceExternal
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
		// 'external': supplied by whoever created the account. An API-key
		// account has no Circle identity to provision a wallet from, so this
		// stays a caller-supplied address -- but it is now recorded as one
		// rather than being indistinguishable from an address we chose.
		`INSERT INTO accounts (id, name, settle_currency, settle_address, settle_address_source, livemode)
		 VALUES ($1,$2,$3,$4,'external',$5)`,
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

// Named for the job, not the provider. These were createFromPrivyRequest and
// privyAccountResponse; the shapes never had anything to do with Privy, which
// is why the Circle bootstrap reused them verbatim and why the names outlived
// their accuracy by a whole migration.
type bootstrapAccountRequest struct {
	Name           string `json:"name"`
	SettleCurrency string `json:"settle_currency"`
	SettleAddress  string `json:"settle_address"` // defaults to LoginWallet if empty
	LoginWallet    string `json:"login_wallet"`   // the signed-in user's wallet address
}
type bootstrapAccountResponse struct {
	// SessionToken is Conduit's own dashboard session, issued here so the
	// identity provider is not on the hot path. Without it every subsequent
	// request re-verifies with the provider -- for Circle that is a network
	// call, measured between 280ms and 7.6s on a polling dashboard.
	SessionToken   string  `json:"session_token,omitempty"`
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	LogoURL        *string `json:"logo_url,omitempty"`
	SettleCurrency string  `json:"settle_currency"`
	SettleAddress  string  `json:"settle_address"`
	LoginWallet    string  `json:"login_wallet"`
	Livemode       bool    `json:"livemode"`
}

// CreateFromPrivy stood here, serving POST /v1/accounts/privy. Removed in
// Phase 7 along with the route and PrivyVerifier. CreateFromCircle below is
// the like-for-like replacement -- same bootstrapAccount, same idempotency,
// different credential.

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
	var existing bootstrapAccountResponse
	var loginWallet *string
	var sessionVersion int
	err := h.Pool.QueryRow(ctx,
		`SELECT id, name, logo_url, settle_currency, settle_address, login_wallet, livemode, session_version
		 FROM accounts WHERE auth_provider = $1 AND auth_subject = $2`,
		provider, subject,
	).Scan(&existing.ID, &existing.Name, &existing.LogoURL, &existing.SettleCurrency, &existing.SettleAddress, &loginWallet, &existing.Livemode, &sessionVersion)
	if err == nil {
		if loginWallet != nil {
			existing.LoginWallet = *loginWallet
		}
		// Signed at the account's CURRENT version, so a token minted by this
		// login survives while every token from before the last sign-out does
		// not.
		existing.SessionToken = auth.NewSessionToken(existing.ID, sessionVersion)
		writeJSON(w, http.StatusOK, existing)
		return
	}
	if err != pgx.ErrNoRows {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	// First login -- onboard.
	var req bootstrapAccountRequest
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
	// privy_user_id is not written at all any more -- nothing can produce a
	// Privy identity. The column still exists (old rows carry it, and migration
	// 0014's rollback reads it), so new rows leave it NULL, which is exactly
	// what the personal-account predicate in settlement_intents.go expects:
	// "no identity" means BOTH privy_user_id and auth_subject are NULL.
	_, err = h.Pool.Exec(ctx,
		// 'login_wallet': settleAddress below defaults to the wallet that signed
		// in. Recorded rather than left blank, because that default is exactly
		// the thing provisioning exists to replace -- and a row that does not
		// say where its address came from cannot be told apart from a choice.
		`INSERT INTO accounts (id, name, settle_currency, settle_address, auth_provider, auth_subject, login_wallet, settle_address_source, livemode)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false)`,
		accountID, req.Name, req.SettleCurrency, settleAddress, provider, subject, req.LoginWallet,
		bootstrapSource(settleAddress, req.LoginWallet),
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	writeJSON(w, http.StatusCreated, bootstrapAccountResponse{
		// A new account starts at version 0, the column default.
		SessionToken: auth.NewSessionToken(accountID, 0),
		ID:           accountID, Name: req.Name, SettleCurrency: req.SettleCurrency,
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
		`SELECT id, name, logo_url, username, settle_currency, settle_address,
		        payout_confirmed_at IS NOT NULL,
		        -- Ready means BOTH halves are there. The constraint added with
		        -- the column already guarantees they move together, so this is
		        -- belt and braces -- but this is the field the dashboard gates
		        -- provisioning on, and a half-written row reading as ready
		        -- would silently stop anyone from ever finishing.
		        (settle_wallet_id IS NOT NULL AND settle_address_source = 'provisioned'),
		        settle_address_source,
		        livemode
		   FROM accounts WHERE id = $1`,
		principal.AccountID,
	).Scan(&resp.ID, &resp.Name, &resp.LogoURL, &resp.Username,
		&resp.SettleCurrency, &resp.SettleAddress, &resp.PayoutConfirmed,
		&resp.SettlementWalletReady, &resp.SettleAddressSource, &resp.Livemode)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// Logout revokes every session token issued for the calling account.
//
// Clearing the browser's copy of a token is not revocation: the token stays
// valid for the rest of its 12 hours wherever else it has reached. Bumping the
// account's session_version invalidates all of them at once, since the version
// is inside the signed payload and compared on every request.
//
// Deliberately all sessions and not just this one. There is no per-session id
// to revoke individually, and the case that matters -- signing out because a
// device or a token may be in someone else's hands -- is the case where ending
// only the session you are holding is no use.
//
// Restricted to session callers. An sk_ key has no session to end, and letting
// a leaked key sign the merchant's dashboard out would hand an attacker a
// denial of service against the account's own owner.
// ConfirmPayoutAddress records that the owner has decided where business
// income lands, WITHOUT changing the address.
//
// The other half of the payout gate. Setting a new address confirms it
// implicitly (see Update), but "keep sending it to the wallet I sign in with"
// is an equally valid answer and needs somewhere to be recorded -- otherwise a
// one-person business is asked the same question at every sign-in forever, and
// a prompt that cannot be answered is one people learn to dismiss unread.
//
// Deliberately does not take an address. A caller that wants to CHANGE the
// address uses Update, which validates it; letting this endpoint set one too
// would be a second, unvalidated path to the field that decides where money
// goes.
func (h *Accounts) ConfirmPayoutAddress(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}
	if _, err := h.Pool.Exec(r.Context(),
		`UPDATE accounts SET payout_confirmed_at = now() WHERE id = $1`,
		principal.AccountID,
	); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"payout_confirmed": true})
}

func (h *Accounts) Logout(w http.ResponseWriter, r *http.Request) {
	principal, _ := auth.FromContext(r.Context())
	if principal.KeyType != auth.KeyTypeSession {
		writeErr(w, apierrors.E(apierrors.CodeForbidden, "session required"))
		return
	}

	if _, err := h.Pool.Exec(r.Context(),
		`UPDATE accounts SET session_version = session_version + 1 WHERE id = $1`,
		principal.AccountID,
	); err != nil {
		// Must not report success on a failed bump: the caller would believe
		// the session was ended when it is still live.
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	w.WriteHeader(http.StatusNoContent)
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

	// settle_address is no longer settable here.
	//
	// It used to be, validated only as "20 bytes of well-formed hex" -- which
	// accepts an address on another chain, an exchange deposit address that will
	// never credit an Arc token, a contract that cannot receive, and any typo
	// that happens to be well formed. Settlement is on-chain and final, so none
	// of those are recoverable.
	//
	// The account settles to the wallet provisioned for it. Sending income
	// somewhere else is a deliberate act with its own confirmation and its own
	// proof of control, not a field on a general-purpose update.
	if e := rejectSuppliedSettleAddress(req.SettleAddress); e != nil {
		writeErr(w, e)
		return
	}

	ctx := r.Context()
	tag, err := h.Pool.Exec(ctx,
		`UPDATE accounts SET
		   name = COALESCE($1, name),
		   logo_url = COALESCE($2, logo_url),
		   settle_currency = COALESCE($3, settle_currency)
		 WHERE id = $4 AND (id = $5 OR parent_id = $5)`,
		req.Name, req.LogoURL, req.SettleCurrency, id, principal.AccountID,
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
	if req.Name == "" || req.SettleCurrency == "" {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "name, settle_currency are required"))
		return
	}
	if e := rejectSuppliedSettleAddress(&req.SettleAddress); req.SettleAddress != "" && e != nil {
		writeErr(w, e)
		return
	}

	ctx := r.Context()
	// A storefront is a place the same business takes money, not a different
	// business. It inherits the parent's address, snapshotted -- so a parent
	// that later moves its settlement does not silently drag its storefronts
	// with it, and a storefront can never point somewhere the parent did not.
	settleAddress, e := deriveSettleAddress(ctx, h.Pool, principal.AccountID)
	if e != nil {
		writeErr(w, e)
		return
	}
	var parentSource *string
	_ = h.Pool.QueryRow(ctx, `SELECT settle_address_source FROM accounts WHERE id = $1`,
		principal.AccountID).Scan(&parentSource)

	accountID := models.NewID("acct")
	_, err := h.Pool.Exec(ctx,
		`INSERT INTO accounts (id, parent_id, name, settle_currency, settle_address, settle_address_source, livemode)
		 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		accountID, principal.AccountID, req.Name, req.SettleCurrency, settleAddress,
		// Mirrors the parent, because it IS the parent's address. Never
		// 'provisioned': no wallet was created for this row, and the
		// present-together constraint would refuse the claim anyway.
		storefrontSource(parentSource), req.Livemode,
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
		SettleAddress: settleAddress, Livemode: req.Livemode,
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
