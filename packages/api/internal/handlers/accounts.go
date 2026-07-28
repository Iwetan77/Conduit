package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kzn-labs/conduit/api/internal/auth"
	apierrors "github.com/kzn-labs/conduit/api/internal/errors"
	"github.com/kzn-labs/conduit/api/internal/models"
)

type Accounts struct{ Pool *pgxpool.Pool }

type createAccountRequest struct {
	Name           string `json:"name"`
	SettleCurrency string `json:"settle_currency"`
	SettleAddress  string `json:"settle_address"`
	Livemode       bool   `json:"livemode"`
}

type accountResponse struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	SettleCurrency string `json:"settle_currency"`
	SettleAddress  string `json:"settle_address"`
	Livemode       bool   `json:"livemode"`
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

func (h *Accounts) Get(w http.ResponseWriter, r *http.Request) {
	id := pathParam(r, "id")
	principal, _ := auth.FromContext(r.Context())

	var resp accountResponse
	err := h.Pool.QueryRow(r.Context(),
		`SELECT id, name, settle_currency, settle_address, livemode FROM accounts WHERE id = $1 AND (id = $2 OR parent_id = $2)`,
		id, principal.AccountID,
	).Scan(&resp.ID, &resp.Name, &resp.SettleCurrency, &resp.SettleAddress, &resp.Livemode)
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

func (h *Accounts) List(w http.ResponseWriter, r *http.Request) {
	principal, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(),
		`SELECT id, name, settle_currency, settle_address, livemode FROM accounts WHERE id = $1 OR parent_id = $1 ORDER BY created_at DESC`,
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
		if err := rows.Scan(&a.ID, &a.Name, &a.SettleCurrency, &a.SettleAddress, &a.Livemode); err != nil {
			writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
			return
		}
		results = append(results, a)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": results})
}

