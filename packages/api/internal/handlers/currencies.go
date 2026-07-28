package handlers

import (
	"net/http"

	"github.com/kzn-labs/conduit/api/internal/currency"
)

type Currencies struct{}

type currencyResponse struct {
	ISO      string `json:"iso"`
	Symbol   string `json:"symbol"`
	Token    string `json:"token"`
	Decimals int    `json:"decimals"`
}

// List returns GET /v1/currencies. Per the v2 spec: "what is actually
// routable right now... read CurrencyRegistry, then confirm each pair against
// StableFX (or AMM fallback). Never a static list." This currently returns
// currency.All() (the Phase 0-confirmed static bootstrap table) directly —
// the live cross-check against CurrencyRegistry.sol + StableFX/AMM coverage
// per pair is NOT yet implemented (needs an eth client wired here + would be
// slow to do synchronously on every request without caching). Flagged as
// remaining work in whereistopped.md — don't treat this endpoint as fully
// spec-compliant yet.
func (h *Currencies) List(w http.ResponseWriter, r *http.Request) {
	all := currency.All()
	out := make([]currencyResponse, 0, len(all))
	for _, c := range all {
		out = append(out, currencyResponse{ISO: c.ISO, Symbol: c.Symbol, Token: c.Token, Decimals: c.Decimals})
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}
