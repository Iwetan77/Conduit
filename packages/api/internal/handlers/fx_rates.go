package handlers

import (
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/kzn-labs/conduit/api/internal/currency"
	apierrors "github.com/kzn-labs/conduit/api/internal/errors"
	"github.com/kzn-labs/conduit/api/internal/fx"
)

// FxRates serves indicative FX rates BEFORE anyone commits to anything.
//
// Why this exists: every rate in the product used to arrive at signing time —
// the payer picked a currency, started a checkout, and only saw the rate on the
// wallet prompt they were already being asked to approve. That's too late to
// decide with. Worse, whether a pair is routable at all (only USDC pairs are)
// and whether the amount clears the provider's ~1.00 USD floor were both
// discoverable only by failing.
//
// This endpoint answers all three questions with no side effects: no settlement
// intent, no fx_trades row, no status transition, no state of any kind. The
// provider's own Quote is already side-effect-free (creating a trade is
// Prepare's job, not Quote's), so this is just that call, exposed.
//
// Public and unauthenticated for the same reason as the other payer-facing
// routes: a payer comparing what they'll receive has no API key, and a rate is
// public market data that commits nobody to anything.
type FxRates struct {
	StableFX *fx.StableFXProvider

	// Quotes carry a ~3.5s TTL, and a payer surface may re-ask as they type.
	// A short shared cache keeps a screenful of UI from becoming a burst of
	// upstream calls, without ever serving a rate older than its own TTL.
	mu    sync.Mutex
	cache map[string]cachedRate
}

type cachedRate struct {
	resp      fxRateResponse
	expiresAt time.Time
}

const fxRateCacheTTL = 2 * time.Second

// Indicative quotes need a recipient address for the provider's typed data, but
// nobody is settling here. A well-formed placeholder keeps the request valid
// without implying a destination; callers who know the real one (the hosted
// checkout does — it's on the public intent) can pass `address` and get a quote
// bound to it.
const indicativeRecipient = "0x0000000000000000000000000000000000000001"

type fxRateResponse struct {
	From string `json:"from"`
	To   string `json:"to"`
	// Amount is what was asked for, in minor units of `to` — the same
	// denomination settlement intents use (the recipient's desired amount).
	Amount string `json:"amount"`
	// PayAmount is what the payer would send, in minor units of `from`.
	PayAmount string `json:"pay_amount"`
	Rate      string `json:"rate"`
	Provider  string `json:"provider"`
	ExpiresAt int64  `json:"expires_at,omitempty"`
	// Indicative is always true: this rate is for display. The firm rate is the
	// one returned by POST /settlement_intents/{id}/quote at payment time.
	Indicative bool `json:"indicative"`
}

// Get is GET /v1/fx/rates?from=USDC&to=EURC&amount=5000000[&address=0x…].
func (h *FxRates) Get(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	fromInfo, ok := resolveCurrency(q.Get("from"))
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeCurrencyNotSupported, "from"))
		return
	}
	toInfo, ok := resolveCurrency(q.Get("to"))
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeCurrencyNotSupported, "to"))
		return
	}
	amount, ok := new(big.Int).SetString(strings.TrimSpace(q.Get("amount")), 10)
	if !ok || amount.Sign() <= 0 {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "amount"))
		return
	}
	recipient := strings.TrimSpace(q.Get("address"))
	if recipient == "" {
		recipient = indicativeRecipient
	}

	key := fromInfo.Symbol + "|" + toInfo.Symbol + "|" + amount.String() + "|" + recipient
	if cached, ok := h.lookup(key); ok {
		writeJSON(w, http.StatusOK, cached)
		return
	}

	// Same-currency is not an FX trade at all — it settles directly on-chain at
	// 1:1, so don't ask a provider (and don't let an outage make it look
	// unavailable).
	var quote fx.Quote
	var err error
	if fromInfo.Symbol == toInfo.Symbol {
		quote, err = fx.DirectProvider{}.Quote(r.Context(), fromInfo.Symbol, toInfo.Symbol, amount, recipient)
	} else {
		quote, err = h.StableFX.Quote(r.Context(), fromInfo.Symbol, toInfo.Symbol, amount, recipient)
	}
	if err != nil {
		// Pass the provider's own verdict through unchanged — "no route for this
		// pair" and "amount below the minimum" are precisely the two answers a
		// caller needs here, and they're the whole reason this endpoint exists.
		if apiErr, ok := err.(*apierrors.APIError); ok {
			writeErr(w, apiErr)
			return
		}
		writeErr(w, apierrors.E(apierrors.CodeFxProviderUnavailable, ""))
		return
	}

	resp := fxRateResponse{
		From:       fromInfo.Symbol,
		To:         toInfo.Symbol,
		Amount:     amount.String(),
		PayAmount:  quote.FromAmount.String(),
		Rate:       quote.Rate,
		Provider:   quote.Provider,
		ExpiresAt:  quote.ExpiresAt,
		Indicative: true,
	}
	h.store(key, resp)
	writeJSON(w, http.StatusOK, resp)
}

// resolveCurrency accepts either an on-chain symbol ("USDC") or an ISO code
// ("USD"), the same way the payer surface and the intent API each speak their
// own namespace.
func resolveCurrency(raw string) (currency.Info, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return currency.Info{}, false
	}
	if info, ok := currency.BySymbol(raw); ok {
		return info, true
	}
	return currency.ByISO(raw)
}

func (h *FxRates) lookup(key string) (fxRateResponse, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	entry, ok := h.cache[key]
	if !ok || time.Now().After(entry.expiresAt) {
		return fxRateResponse{}, false
	}
	return entry.resp, true
}

func (h *FxRates) store(key string, resp fxRateResponse) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.cache == nil {
		h.cache = map[string]cachedRate{}
	}
	// Bounded: this is keyed by caller-supplied values, so it must not grow
	// without limit. Entries live ~2s; clearing wholesale past a sane size is
	// simpler than per-key eviction and costs at most one extra upstream call.
	if len(h.cache) > 512 {
		h.cache = map[string]cachedRate{}
	}
	h.cache[key] = cachedRate{resp: resp, expiresAt: time.Now().Add(fxRateCacheTTL)}
}
