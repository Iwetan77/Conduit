package handlers

// Groups of the people a business pays.
//
// One person routinely runs more than one business, and the roster was a single
// flat list per account: everybody they pay, from every business, in one
// column. Paying one business's staff meant pausing everybody else and
// remembering to unpause them afterwards — a manual step whose failure mode is
// paying the wrong people, silently, next month.
//
// A group is the SCOPE OF A PAYROLL RUN and nothing else. It is not a
// permission, not a department, not an org chart. Keeping it that small is what
// stops it growing into a second access-control system that has to be right.
//
// Deliberately not built here:
//
//   - Nesting. A group inside a group makes "who does this run pay" a graph
//     walk, and the answer to that question must be obvious to somebody about
//     to move money.
//   - Membership in more than one group. An employee has one group_id, so a
//     person cannot be paid twice by two overlapping runs — the failure a
//     many-to-many table would introduce, and the exact failure the unique
//     index on (account_id, address) exists to prevent elsewhere.

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kzn-labs/conduit/api/internal/auth"
	apierrors "github.com/kzn-labs/conduit/api/internal/errors"
	"github.com/kzn-labs/conduit/api/internal/models"
)

type EmployeeGroups struct {
	Pool *pgxpool.Pool
}

type employeeGroupResponse struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// How many active people are in it. The list screen shows this, and doing it
	// in the same query avoids the client firing one count per group.
	Members   int       `json:"members"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Long enough for "Lagos kitchen staff", short enough not to break the picker
// it is rendered in.
const maxGroupNameLen = 60

func groupName(raw string) (string, *apierrors.APIError) {
	name := strings.TrimSpace(raw)
	if name == "" {
		return "", apierrors.E(apierrors.CodeInvalidRequest, "name")
	}
	if len(name) > maxGroupNameLen {
		return "", apierrors.E(apierrors.CodeInvalidRequest, "name is too long")
	}
	return name, nil
}

// Create is POST /v1/employee_groups.
func (h *EmployeeGroups) Create(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "body"))
		return
	}
	name, e := groupName(req.Name)
	if e != nil {
		writeErr(w, e)
		return
	}

	id := models.NewID("egrp")
	var out employeeGroupResponse
	err := h.Pool.QueryRow(r.Context(),
		`INSERT INTO employee_groups (id, account_id, name) VALUES ($1,$2,$3)
		 RETURNING id, name, created_at, updated_at`,
		id, principal.AccountID, name,
	).Scan(&out.ID, &out.Name, &out.CreatedAt, &out.UpdatedAt)
	if err != nil {
		// The unique index on (account_id, lower(name)). Two groups whose names
		// differ only in case is how a merchant pays half a team and believes
		// they paid all of it.
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "a group with that name already exists"))
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// List is GET /v1/employee_groups.
func (h *EmployeeGroups) List(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}
	// LEFT JOIN, so a group with nobody in it still lists. An empty group is a
	// normal intermediate state — it is what a merchant has for the thirty
	// seconds between making one and filling it — and hiding it would look like
	// the create silently failed.
	rows, err := h.Pool.Query(r.Context(),
		`SELECT g.id, g.name, g.created_at, g.updated_at,
		        count(e.id) FILTER (WHERE e.status = 'active') AS members
		   FROM employee_groups g
		   LEFT JOIN employees e ON e.group_id = g.id
		  WHERE g.account_id = $1
		  GROUP BY g.id
		  ORDER BY g.created_at`,
		principal.AccountID,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	defer rows.Close()
	out := []employeeGroupResponse{}
	for rows.Next() {
		var g employeeGroupResponse
		if err := rows.Scan(&g.ID, &g.Name, &g.CreatedAt, &g.UpdatedAt, &g.Members); err != nil {
			writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
			return
		}
		out = append(out, g)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

// Update is PATCH /v1/employee_groups/{id}. Renames, and nothing else.
func (h *EmployeeGroups) Update(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "body"))
		return
	}
	name, e := groupName(req.Name)
	if e != nil {
		writeErr(w, e)
		return
	}

	var out employeeGroupResponse
	err := h.Pool.QueryRow(r.Context(),
		`UPDATE employee_groups SET name = $1, updated_at = now()
		  WHERE id = $2 AND account_id = $3
		 RETURNING id, name, created_at, updated_at`,
		name, pathParam(r, "id"), principal.AccountID,
	).Scan(&out.ID, &out.Name, &out.CreatedAt, &out.UpdatedAt)
	if err == pgx.ErrNoRows {
		writeErr(w, apierrors.E(apierrors.CodeNotFound, ""))
		return
	}
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "a group with that name already exists"))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Delete is DELETE /v1/employee_groups/{id}.
//
// Removes the GROUP, never the people in it. The column is ON DELETE SET NULL,
// so its members return to ungrouped: still listed, still payable, and their
// payroll history still intact. Deleting people here would orphan the run items
// that record what they were paid, which is the record this whole feature
// exists to keep straight.
func (h *EmployeeGroups) Delete(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}
	tag, err := h.Pool.Exec(r.Context(),
		`DELETE FROM employee_groups WHERE id = $1 AND account_id = $2`,
		pathParam(r, "id"), principal.AccountID,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, apierrors.E(apierrors.CodeNotFound, ""))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// groupBelongsTo reports whether a group id is this account's, for handlers that
// accept one as a filter.
//
// Checked rather than trusted, and the reason is not abstract: an unchecked
// group id in a payroll request would let one account scope a run by another
// account's group. It would pay nobody — the employee query is still filtered by
// account — but it would silently pay NOBODY, which on a payroll screen reads as
// "done" rather than as "wrong".
func groupBelongsTo(ctx context.Context, pool *pgxpool.Pool, groupID, accountID string) bool {
	var one int
	err := pool.QueryRow(ctx,
		`SELECT 1 FROM employee_groups WHERE id = $1 AND account_id = $2`,
		groupID, accountID,
	).Scan(&one)
	return err == nil
}
