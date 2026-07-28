package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kzn-labs/conduit/api/internal/auth"
	apierrors "github.com/kzn-labs/conduit/api/internal/errors"
	"github.com/kzn-labs/conduit/api/internal/models"
	"github.com/kzn-labs/conduit/api/internal/webhooks"
)

type WebhookEndpoints struct {
	Pool       *pgxpool.Pool
	Dispatcher *webhooks.Dispatcher
}

type createWebhookEndpointRequest struct {
	URL           string   `json:"url"`
	EnabledEvents []string `json:"enabled_events"`
}
type webhookEndpointResponse struct {
	ID            string   `json:"id"`
	URL           string   `json:"url"`
	Secret        string   `json:"secret,omitempty"` // only present in the create response
	EnabledEvents []string `json:"enabled_events"`
}

func (h *WebhookEndpoints) Create(w http.ResponseWriter, r *http.Request) {
	principal, _ := auth.FromContext(r.Context())
	var req createWebhookEndpointRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.URL == "" {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "url"))
		return
	}
	secret, err := webhooks.NewSecret()
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	id := models.NewID("we")
	_, err = h.Pool.Exec(r.Context(),
		`INSERT INTO webhook_endpoints (id, account_id, url, secret, enabled_events) VALUES ($1,$2,$3,$4,$5)`,
		id, principal.AccountID, req.URL, secret, req.EnabledEvents,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	writeJSON(w, http.StatusCreated, webhookEndpointResponse{ID: id, URL: req.URL, Secret: secret, EnabledEvents: req.EnabledEvents})
}

func (h *WebhookEndpoints) List(w http.ResponseWriter, r *http.Request) {
	principal, _ := auth.FromContext(r.Context())
	rows, err := h.Pool.Query(r.Context(),
		`SELECT id, url, enabled_events FROM webhook_endpoints WHERE account_id = $1 ORDER BY created_at DESC`,
		principal.AccountID,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	defer rows.Close()
	var results []webhookEndpointResponse
	for rows.Next() {
		var e webhookEndpointResponse
		if err := rows.Scan(&e.ID, &e.URL, &e.EnabledEvents); err != nil {
			writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
			return
		}
		results = append(results, e)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": results})
}

type deliveryResponse struct {
	ID           string  `json:"id"`
	EventType    string  `json:"event_type"`
	Attempt      int     `json:"attempt"`
	ResponseCode *int    `json:"response_code,omitempty"`
	DeliveredAt  *string `json:"delivered_at,omitempty"`
}

func (h *WebhookEndpoints) Deliveries(w http.ResponseWriter, r *http.Request) {
	endpointID := pathParam(r, "id")
	principal, _ := auth.FromContext(r.Context())

	var owns bool
	h.Pool.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM webhook_endpoints WHERE id = $1 AND account_id = $2)`, endpointID, principal.AccountID).Scan(&owns)
	if !owns {
		writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
		return
	}

	rows, err := h.Pool.Query(r.Context(),
		`SELECT id, event_type, attempt, response_code, delivered_at::text FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY created_at DESC LIMIT 100`,
		endpointID,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	defer rows.Close()
	var results []deliveryResponse
	for rows.Next() {
		var d deliveryResponse
		var deliveredAt *string
		if err := rows.Scan(&d.ID, &d.EventType, &d.Attempt, &d.ResponseCode, &deliveredAt); err != nil {
			writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
			return
		}
		d.DeliveredAt = deliveredAt
		results = append(results, d)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": results})
}

func (h *WebhookEndpoints) ReplayDelivery(w http.ResponseWriter, r *http.Request) {
	deliveryID := pathParam(r, "id")
	principal, _ := auth.FromContext(r.Context())

	var owns bool
	err := h.Pool.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM webhook_deliveries wd JOIN webhook_endpoints we ON we.id = wd.endpoint_id WHERE wd.id = $1 AND we.account_id = $2)`,
		deliveryID, principal.AccountID,
	).Scan(&owns)
	if err != nil || !owns {
		writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
		return
	}

	if err := h.Dispatcher.Replay(r.Context(), deliveryID); err != nil {
		if err == pgx.ErrNoRows {
			writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
			return
		}
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": deliveryID, "status": "replayed"})
}
