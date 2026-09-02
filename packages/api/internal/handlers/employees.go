package handlers

// The people a business pays.
//
// Adding somebody by @username is the primary path, and that is not a
// convenience. Part I of this work spent its whole length removing the places
// where an address could be typed, because a typed address is unrecoverable
// when wrong and looks identical when right. Reintroducing a text box here --
// on the list of people who get paid every month, automatically, without
// anyone re-reading it -- would be the worst place to reopen it.
//
// A raw address is still accepted, because some recipients have no Conduit
// account and never will. It carries the same weight as an unverified payout
// destination: it is the caller's assertion, and nothing here can check it.
//
// The username is RESOLVED once and the address stored. Names are for reading;
// addresses are for paying. If a username were resolved at pay time instead, a
// name that changed hands between hiring somebody and paying them would send
// their salary to whoever holds it now.

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kzn-labs/conduit/api/internal/auth"
	"github.com/kzn-labs/conduit/api/internal/currency"
	apierrors "github.com/kzn-labs/conduit/api/internal/errors"
	"github.com/kzn-labs/conduit/api/internal/models"
)

type Employees struct {
	Pool *pgxpool.Pool
}

type employeeResponse struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Address     string  `json:"address"`
	Username    *string `json:"username"`
	PayCurrency string  `json:"pay_currency"`
	PayType     string  `json:"pay_type"`
	// Null for a variable employee, by construction. Present rather than
	// omitted so a client can tell "no amount" from "field missing".
	Amount *string `json:"amount"`
	// Which group they are in, or null for ungrouped. A run scoped to a group
	// pays only its members; a run with no group named pays everybody, which is
	// what every existing account gets.
	GroupID   *string   `json:"group_id"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

const employeeColumns = `id, name, address, username, pay_currency, pay_type,
                         amount::text, group_id, status, created_at, updated_at`

func scanEmployee(row pgx.Row) (employeeResponse, error) {
	var e employeeResponse
	err := row.Scan(&e.ID, &e.Name, &e.Address, &e.Username, &e.PayCurrency,
		&e.PayType, &e.Amount, &e.GroupID, &e.Status, &e.CreatedAt, &e.UpdatedAt)
	return e, err
}

// resolveRecipient turns a username or an address into the address to pay.
//
// Both are accepted and they are not equivalent. A username is looked up here
// and now, against an account that exists; an address is taken on trust because
// there is nothing to check it against.
func (h *Employees) resolveRecipient(r *http.Request, username, address string) (string, *string, *apierrors.APIError) {
	username = strings.TrimPrefix(strings.TrimSpace(username), "@")
	address = strings.TrimSpace(address)

	if username != "" {
		var resolved string
		err := h.Pool.QueryRow(r.Context(),
			`SELECT settle_address FROM accounts WHERE lower(username) = lower($1)`,
			username,
		).Scan(&resolved)
		if errors.Is(err, pgx.ErrNoRows) {
			return "", nil, apierrors.E(apierrors.CodeNotFound, "username")
		}
		if err != nil {
			return "", nil, apierrors.E(apierrors.CodeInternal, "")
		}
		// Both stored: the address is what gets paid, the name is what gets
		// shown. Showing a hex string on a payroll confirmation screen is how a
		// wrong line goes unnoticed.
		return resolved, &username, nil
	}

	if !common.IsHexAddress(address) {
		return "", nil, apierrors.E(apierrors.CodeInvalidRequest, "username or address")
	}
	return address, nil, nil
}

type employeeRequest struct {
	Name        string  `json:"name"`
	Username    string  `json:"username"`
	Address     string  `json:"address"`
	PayCurrency string  `json:"pay_currency"`
	PayType     string  `json:"pay_type"`
	Amount      *string `json:"amount"`
	// Optional. Omitted or empty means ungrouped, which is where everybody who
	// existed before groups did stays.
	GroupID *string `json:"group_id"`
}

// Create is POST /v1/employees.
func (h *Employees) Create(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}
	var req employeeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "body"))
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "name"))
		return
	}
	info, ok := currency.ByISO(req.PayCurrency)
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeCurrencyNotSupported, "pay_currency"))
		return
	}
	amount, e := validatePay(req.PayType, req.Amount)
	if e != nil {
		writeErr(w, e)
		return
	}
	address, username, e := h.resolveRecipient(r, req.Username, req.Address)
	if e != nil {
		writeErr(w, e)
		return
	}

	// A group id that is not this account's is refused, not ignored. Silently
	// dropping it would put the person in the ungrouped list, where the next
	// group-scoped run would not pay them and nothing would say why.
	if req.GroupID != nil && strings.TrimSpace(*req.GroupID) != "" {
		if !groupBelongsTo(r.Context(), h.Pool, *req.GroupID, principal.AccountID) {
			writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "group_id"))
			return
		}
	} else {
		req.GroupID = nil
	}

	id := models.NewID("emp")
	row := h.Pool.QueryRow(r.Context(),
		`INSERT INTO employees (id, account_id, name, address, username, pay_currency, pay_type, amount, group_id)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		 RETURNING `+employeeColumns,
		id, principal.AccountID, strings.TrimSpace(req.Name), address, username,
		info.ISO, req.PayType, amount, req.GroupID,
	)
	out, err := scanEmployee(row)
	if err != nil {
		// The unique index: this person is already on the payroll. Two rows for
		// one address is how somebody gets paid twice in a single run.
		writeErr(w, apierrors.E(apierrors.CodeEmployeeExists, "address"))
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// validatePay enforces the one rule that cannot be left to the database alone,
// because a rejection here can explain itself.
func validatePay(payType string, amount *string) (*string, *apierrors.APIError) {
	switch payType {
	case "fixed":
		if amount == nil || strings.TrimSpace(*amount) == "" {
			return nil, apierrors.E(apierrors.CodeInvalidRequest, "amount is required for a fixed employee")
		}
		n, ok := new(big.Int).SetString(strings.TrimSpace(*amount), 10)
		if !ok || n.Sign() <= 0 {
			return nil, apierrors.E(apierrors.CodeInvalidRequest, "amount")
		}
		s := n.String()
		return &s, nil
	case "variable":
		// Refused rather than ignored. An amount stored against somebody paid a
		// different sum every month is a number that will eventually be paid by
		// accident, and silently dropping it hides that the caller believed
		// otherwise.
		if amount != nil && strings.TrimSpace(*amount) != "" {
			return nil, apierrors.E(apierrors.CodeInvalidRequest,
				"a variable employee has no fixed amount; it is given per run")
		}
		return nil, nil
	default:
		return nil, apierrors.E(apierrors.CodeInvalidRequest, "pay_type must be fixed or variable")
	}
}

// List is GET /v1/employees. Archived are excluded unless asked for: they are
// kept for history, not for looking at every day.
func (h *Employees) List(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}
	includeArchived := r.URL.Query().Get("include_archived") == "true"
	rows, err := h.Pool.Query(r.Context(),
		`SELECT `+employeeColumns+`
		   FROM employees
		  WHERE account_id = $1 AND ($2 OR status <> 'archived')
		  ORDER BY created_at DESC`,
		principal.AccountID, includeArchived,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	defer rows.Close()
	out := []employeeResponse{}
	for rows.Next() {
		e, err := scanEmployee(rows)
		if err != nil {
			writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
			return
		}
		out = append(out, e)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

// Update is PATCH /v1/employees/{id}.
//
// Deliberately does NOT move the address. Changing where a person is paid is
// not an edit to their record, it is a different person as far as the money is
// concerned -- and doing it silently on a row that a scheduled run reads is the
// shape of a payroll going to the wrong place with nobody looking.
func (h *Employees) Update(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}
	id := pathParam(r, "id")
	var req struct {
		Name        *string `json:"name"`
		PayCurrency *string `json:"pay_currency"`
		PayType     *string `json:"pay_type"`
		Amount      *string `json:"amount"`
		Status      *string `json:"status"`
		// Moving somebody between groups IS a normal edit, unlike moving their
		// address: it changes which run pays them, not where the money goes.
		// A caller that omits it leaves the group alone; sending "" clears it.
		GroupID *string `json:"group_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "body"))
		return
	}

	var current employeeResponse
	row := h.Pool.QueryRow(r.Context(),
		`SELECT `+employeeColumns+` FROM employees WHERE id = $1 AND account_id = $2`,
		id, principal.AccountID)
	current, err := scanEmployee(row)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
		return
	}
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	payType := current.PayType
	if req.PayType != nil {
		payType = *req.PayType
	}
	// Validated against the type the row will END UP with, not the one it had.
	// Switching somebody from variable to fixed without giving an amount, or
	// the reverse while leaving one behind, are both rows the run cannot use.
	amountIn := req.Amount
	if amountIn == nil && req.PayType == nil {
		amountIn = current.Amount
	}
	amount, e := validatePay(payType, amountIn)
	if e != nil {
		writeErr(w, e)
		return
	}

	if req.PayCurrency != nil {
		if _, ok := currency.ByISO(*req.PayCurrency); !ok {
			writeErr(w, apierrors.E(apierrors.CodeCurrencyNotSupported, "pay_currency"))
			return
		}
	}
	if req.Status != nil && *req.Status != "active" && *req.Status != "paused" {
		// Archiving has its own route: it is an end state, not a field to set,
		// and it should read as a decision at the call site.
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "status must be active or paused"))
		return
	}

	// Three states, and they are not the same: absent leaves the group as it
	// is, "" removes them from theirs, and an id moves them. A single COALESCE
	// cannot say all three, hence the explicit flag.
	groupID := current.GroupID
	if req.GroupID != nil {
		if strings.TrimSpace(*req.GroupID) == "" {
			groupID = nil
		} else {
			if !groupBelongsTo(r.Context(), h.Pool, *req.GroupID, principal.AccountID) {
				writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "group_id"))
				return
			}
			groupID = req.GroupID
		}
	}

	row = h.Pool.QueryRow(r.Context(),
		`UPDATE employees
		    SET name = COALESCE($1, name),
		        pay_currency = COALESCE($2, pay_currency),
		        pay_type = $3,
		        amount = $4,
		        status = COALESCE($5, status),
		        group_id = $6,
		        updated_at = now()
		  WHERE id = $7 AND account_id = $8
		  RETURNING `+employeeColumns,
		req.Name, req.PayCurrency, payType, amount, req.Status, groupID, id, principal.AccountID)
	out, err := scanEmployee(row)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Archive is POST /v1/employees/{id}/archive — the only way an employee leaves
// the list.
//
// Never a delete. A removed row breaks the history of every run that paid them:
// the run still records what it paid, and the person it paid becomes a dangling
// id. Somebody leaving is an ordinary event and must not corrupt the record of
// what they were owed while they were there.
func (h *Employees) Archive(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}
	row := h.Pool.QueryRow(r.Context(),
		`UPDATE employees SET status = 'archived', updated_at = now()
		  WHERE id = $1 AND account_id = $2
		  RETURNING `+employeeColumns,
		pathParam(r, "id"), principal.AccountID)
	out, err := scanEmployee(row)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
		return
	}
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ReassignAddress is POST /v1/employees/{id}/reassign_address.
//
// The one sanctioned way an employee's payment address moves.
//
// `Update` refuses to touch the address, and that refusal is right: changing
// where somebody is paid is not an edit to their record, it is a different
// destination for their salary. But with no alternative, an employee who
// genuinely changed wallet had to be archived and re-added -- which severs the
// link every past run holds to them, the exact history the archive rule exists
// to protect. So this exists, separately, deliberately, and audited.
//
// Requires the new address TWICE. Double entry, the way a bank asks for an
// account number twice, because this is the one field here that is
// unrecoverable when wrong and looks identical when right: twenty bytes of
// valid hex covers a wallet on another chain, an exchange deposit that will
// never credit an Arc token, and every typo that happens to land in range.
// Nothing can check it, so the only defence is making the caller say it twice.
func (h *Employees) ReassignAddress(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}
	var req struct {
		Address string `json:"address"`
		// Must equal Address. See above.
		ConfirmAddress string  `json:"confirm_address"`
		Note           *string `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "body"))
		return
	}
	addr := strings.TrimSpace(req.Address)
	confirm := strings.TrimSpace(req.ConfirmAddress)

	if !common.IsHexAddress(addr) {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "address"))
		return
	}
	if !strings.EqualFold(addr, confirm) {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest,
			"address and confirm_address must match — this is the check that catches a typo in the one field nothing else can verify"))
		return
	}
	// Checksummed on the way in, so the stored form is canonical and two
	// casings of one address can never become two different employees.
	addr = common.HexToAddress(addr).Hex()

	id := pathParam(r, "id")
	ctx := r.Context()

	tx, err := h.Pool.Begin(ctx)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	defer tx.Rollback(ctx)

	// Locked, so a concurrent reassign cannot read the same old address and
	// write two audit rows that both claim to be the move.
	var oldAddr, status string
	if err := tx.QueryRow(ctx,
		`SELECT address, status FROM employees WHERE id = $1 AND account_id = $2 FOR UPDATE`,
		id, principal.AccountID).Scan(&oldAddr, &status); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
		return
	}
	if status == "archived" {
		// Archived is an end state. Moving a departed employee's address is
		// either a mistake or somebody trying to redirect a final payment.
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest,
			"this employee is archived; reinstate them before moving their address"))
		return
	}
	if strings.EqualFold(oldAddr, addr) {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest,
			"that is already their address"))
		return
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO employee_address_changes (id, employee_id, account_id, old_address, new_address, note)
		 VALUES ($1,$2,$3,$4,$5,$6)`,
		models.NewID("eac"), id, principal.AccountID, oldAddr, addr, req.Note); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	// The username goes with it. It was resolved to the OLD address when they
	// were added, so leaving it attached would display a name that now points
	// somewhere else -- the worst possible label on a payroll line. A caller
	// who wants the new address named can re-add the username deliberately.
	row := tx.QueryRow(ctx,
		`UPDATE employees SET address = $1, username = NULL, updated_at = now()
		  WHERE id = $2 AND account_id = $3
		  RETURNING `+employeeColumns,
		addr, id, principal.AccountID)
	out, err := scanEmployee(row)
	if err != nil {
		// The unique index on (account_id, lower(address)): somebody else on
		// this payroll is already paid there.
		writeErr(w, apierrors.E(apierrors.CodeEmployeeExists, "address"))
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	writeJSON(w, http.StatusOK, out)
}

// Delete is DELETE /v1/employees/{id}.
//
// A real delete, and only when it is genuinely safe.
//
// Archiving is the right end state for somebody who has been PAID: their rows
// in payroll_run_items are the record of money that actually moved, and
// removing the employee they point at turns that history into a set of
// dangling ids. That is the whole reason nothing here was ever hard-deleted.
//
// But that reasoning only covers people with history. Somebody added by
// mistake, with a typo in their address, or during a test has no history to
// protect -- and telling a merchant their only option is to "archive" a row
// that never meant anything leaves a permanent list of things they cannot
// clean up. "Why can't I remove people" is a fair question when the answer is
// a rule that does not apply to the person being removed.
//
// So: delete when no payroll run has ever referenced them, refuse otherwise
// and say to archive instead. The check is a real query rather than a guess at
// status, because a run can reference somebody who is already archived.
func (h *Employees) Delete(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}
	id := pathParam(r, "id")
	ctx := r.Context()

	// Owned by this account, checked before anything is counted or removed.
	var exists bool
	if err := h.Pool.QueryRow(ctx,
		`SELECT true FROM employees WHERE id = $1 AND account_id = $2`,
		id, principal.AccountID).Scan(&exists); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
		return
	}

	var paidLines int
	if err := h.Pool.QueryRow(ctx,
		`SELECT count(*) FROM payroll_run_items WHERE employee_id = $1`, id).Scan(&paidLines); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	if paidLines > 0 {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest,
			fmt.Sprintf(
				"this person appears on %d payroll line(s), which record money that actually moved. Archive them instead — that removes them from future runs and keeps the history intact.",
				paidLines,
			)))
		return
	}

	// The audit trail goes with them. It exists to explain how a PAID person's
	// address changed over time, and there is nothing to explain about somebody
	// no run ever touched.
	tx, err := h.Pool.Begin(ctx)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `DELETE FROM employee_address_changes WHERE employee_id = $1`, id); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	tag, err := tx.Exec(ctx, `DELETE FROM employees WHERE id = $1 AND account_id = $2`, id, principal.AccountID)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
