package fx

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"time"

	"github.com/kzn-labs/conduit/api/internal/currency"
	apierrors "github.com/kzn-labs/conduit/api/internal/errors"
)

// StableFXProvider talks to Circle's real StableFX sandbox/production API.
// Base URL selection matters: TEST_API_KEY-prefixed keys only work against
// api-sandbox.circle.com — api.circle.com 401s them (found empirically in
// Phase 0; not documented anywhere). See docs/fx-capability.md.
type StableFXProvider struct {
	baseURL    string
	apiKey     string
	httpClient *http.Client
}

func NewStableFXProvider(baseURL, apiKey string) *StableFXProvider {
	return &StableFXProvider{
		baseURL:    baseURL,
		apiKey:     apiKey,
		httpClient: &http.Client{Timeout: 15 * time.Second},
	}
}

func (p *StableFXProvider) Name() string { return "stablefx" }

type quoteRequest struct {
	From             quoteAmount `json:"from"`
	To               quoteAmount `json:"to"`
	Tenor            string      `json:"tenor"`
	Type             string      `json:"type"`
	RecipientAddress string      `json:"recipientAddress"`
}
type quoteAmount struct {
	Currency string `json:"currency"`
	Amount   string `json:"amount,omitempty"`
}
type quoteResponseEnvelope struct {
	Data *quoteResponseData `json:"data"`
	// error shape: {"code":3008,"message":"..."}
	Code    int    `json:"code"`
	Message string `json:"message"`
}
type quoteResponseData struct {
	ID        string      `json:"id"`
	Rate      string      `json:"rate"`
	From      quoteAmount `json:"from"`
	To        quoteAmount `json:"to"`
	CreatedAt time.Time   `json:"createdAt"`
	ExpiresAt time.Time   `json:"expiresAt"`
	Fee       string      `json:"fee"`
	TypedData json.RawMessage `json:"typedData"`
}

// Quote requests a tradable RFQ from StableFX for exactly `settleAmount` of
// `to` (the recipient currency), paid in `from` (the payer currency). Per the
// v2 spec §2.2: do NOT call this until the payer is present and ready — the
// observed TTL is ~3.5s (docs/fx-capability.md), far shorter than the
// architecture doc originally assumed.
func (p *StableFXProvider) Quote(ctx context.Context, from, to string, settleAmount *big.Int, recipientAddress string) (Quote, error) {
	fromInfo, ok := currency.BySymbol(from)
	if !ok {
		return Quote{}, apierrors.E(apierrors.CodeCurrencyNotSupported, "from")
	}
	toInfo, ok := currency.BySymbol(to)
	if !ok {
		return Quote{}, apierrors.E(apierrors.CodeCurrencyNotSupported, "to")
	}

	humanAmount := formatHumanAmount(settleAmount, toInfo.Decimals)

	reqBody := quoteRequest{
		From:             quoteAmount{Currency: fromISOOrSymbol(fromInfo)},
		To:               quoteAmount{Currency: fromISOOrSymbol(toInfo), Amount: humanAmount},
		Tenor:            "instant",
		Type:             "tradable",
		RecipientAddress: recipientAddress,
	}
	// StableFX wants amount on exactly one side; put it on `to` since intents
	// are always denominated in settle_currency (recipient's desired amount).
	reqBody.From.Amount = ""

	var env quoteResponseEnvelope
	status, err := p.post(ctx, "/v1/exchange/stablefx/quotes", reqBody, &env)
	if err != nil {
		return Quote{}, apierrors.E(apierrors.CodeFxProviderUnavailable, "")
	}
	if status != http.StatusOK && status != http.StatusCreated {
		if env.Code == 3008 {
			return Quote{}, apierrors.E(apierrors.CodeFxNoRoute, "")
		}
		return Quote{}, fmt.Errorf("stablefx quote failed (%d): %s", env.Code, env.Message)
	}

	fromAmt, _ := parseHumanAmount(env.Data.From.Amount, fromInfo.Decimals)
	toAmt, _ := parseHumanAmount(env.Data.To.Amount, toInfo.Decimals)

	return Quote{
		Provider:     p.Name(),
		QuoteID:      env.Data.ID,
		FromCurrency: from,
		ToCurrency:   to,
		FromAmount:   fromAmt,
		ToAmount:     toAmt,
		Rate:         env.Data.Rate,
		ExpiresAt:    env.Data.ExpiresAt.Unix(),
		RawTypedData: env.Data.TypedData,
	}, nil
}

type tradeRequest struct {
	IdempotencyKey string          `json:"idempotencyKey"`
	QuoteID        string          `json:"quoteId"`
	Address        string          `json:"address"`
	Message        json.RawMessage `json:"message"`
	Signature      string          `json:"signature"`
}
type tradeResponseEnvelope struct {
	Data *struct {
		ID              string `json:"id"`
		ContractTradeID string `json:"contractTradeId"`
		Status          string `json:"status"`
	} `json:"data"`
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type presignRequest struct {
	ContractTradeIDs []string `json:"contractTradeIds"`
	Type             string   `json:"type"`
}
type presignResponseEnvelope struct {
	Data *struct {
		TypedData json.RawMessage `json:"typedData"`
	} `json:"data"`
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// Prepare exists only to satisfy the Provider interface's uniform shape for
// provider-agnostic callers (e.g. AmmProvider, which has nothing to presign).
// StableFX needs the payer's signature over the QUOTE's own typed data before
// it can create a trade — use PrepareWithSignature instead. See the package
// doc comment on the two-signature flow this discovers.
func (p *StableFXProvider) Prepare(ctx context.Context, q Quote, payer, recipient string) (Preparation, error) {
	return Preparation{}, fmt.Errorf("fx: StableFXProvider.Prepare requires quoteSignature — call PrepareWithSignature")
}

// PrepareWithSignature is StableFX's real second step, called from
// POST /v1/settlement_intents/:id/prepare.
//
// DISCOVERY (deviates from the v2 build spec's assumed single-signature flow —
// flagged and resolved with the user rather than picked silently): Circle's
// real taker quickstart requires the payer to sign the QUOTE's own typed data
// (returned by Quote(), primaryType PermitWitnessTransferFrom for the FX swap
// itself) BEFORE a trade can even be created — this is `quoteSignature`/
// `quoteMessage` below, sig #1. Only once StableFX has that does it hand back
// the SEPARATE funding-presign typed data (sig #2, what the caller passes on
// to /confirm). So the full signable-moments count is two, not one:
//   POST /:id/quote    -> returns Quote.RawTypedData            (sig #1 target)
//   POST /:id/prepare  -> takes sig #1, returns FundingTypedData (sig #2 target)
//   POST /:id/confirm  -> takes sig #2, submits on-chain
// This still fits the spec's 3-endpoint shape exactly — no new endpoint
// needed, just one more field on the /prepare request (quoteSignature).
func (p *StableFXProvider) PrepareWithSignature(ctx context.Context, q Quote, payer string, quoteMessage json.RawMessage, quoteSignature string) (Preparation, error) {
	var tradeEnv tradeResponseEnvelope
	tradeReq := tradeRequest{
		IdempotencyKey: q.QuoteID, // quote id is unique per RFQ; reusing it as the trade idempotency key ties them
		QuoteID:        q.QuoteID,
		Address:        payer,
		Message:        quoteMessage,
		Signature:      quoteSignature,
	}
	status, err := p.post(ctx, "/v1/exchange/stablefx/trades", tradeReq, &tradeEnv)
	if err != nil {
		return Preparation{}, apierrors.E(apierrors.CodeFxProviderUnavailable, "")
	}
	if status != http.StatusOK && status != http.StatusCreated {
		return Preparation{}, fmt.Errorf("stablefx trade creation failed (%d): %s", tradeEnv.Code, tradeEnv.Message)
	}

	var presignEnv presignResponseEnvelope
	presignReq := presignRequest{ContractTradeIDs: []string{tradeEnv.Data.ContractTradeID}, Type: "taker"}
	status, err = p.post(ctx, "/v1/exchange/stablefx/signatures/funding/presign", presignReq, &presignEnv)
	if err != nil {
		return Preparation{}, apierrors.E(apierrors.CodeFxProviderUnavailable, "")
	}
	if status != http.StatusOK && status != http.StatusCreated {
		return Preparation{}, fmt.Errorf("stablefx presign failed (%d): %s", presignEnv.Code, presignEnv.Message)
	}

	// witness = keccak256(abi.encode(SingleTradeWitness{ id: contractTradeId })).
	// Computed on-chain by ConduitRouter's caller (handlers layer), not here —
	// this method only returns what StableFX gave us; witness hashing needs the
	// ABI encoder, kept in internal/onchain to avoid importing go-ethereum's abi
	// package into every fx provider.
	return Preparation{
		Provider:         p.Name(),
		ContractTradeID:  tradeEnv.Data.ContractTradeID,
		FundingTypedData: presignEnv.Data.TypedData,
	}, nil
}

func (p *StableFXProvider) Submit(ctx context.Context, prep Preparation, signature string) (string, error) {
	// Real on-chain submission lives in internal/onchain.SubmitFX — this method
	// is intentionally NOT implemented here to keep the fx package free of
	// go-ethereum tx-signing concerns; handlers wire onchain.SubmitFX directly.
	// Kept as a documented no-op so StableFXProvider still satisfies Provider.
	return "", fmt.Errorf("fx: use internal/onchain.SubmitFX directly, not StableFXProvider.Submit")
}

func (p *StableFXProvider) post(ctx context.Context, path string, body, out any) (int, error) {
	buf, err := json.Marshal(body)
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+path, bytes.NewReader(buf))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+p.apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := p.httpClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, err
	}
	if err := json.Unmarshal(respBody, out); err != nil {
		return resp.StatusCode, fmt.Errorf("stablefx: unmarshal response: %w (body: %s)", err, respBody)
	}
	return resp.StatusCode, nil
}

// fromISOOrSymbol: StableFX's `currency` field takes token symbols (USDC,
// EURC, BRLA, ...) per every real response observed in Phase 0 — not fiat ISO
// codes. Confirmed empirically (docs/fx-capability.md); nothing in Circle's
// docs states this explicitly.
func fromISOOrSymbol(info currency.Info) string { return info.Symbol }

func formatHumanAmount(raw *big.Int, decimals int) string {
	divisor := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil)
	whole := new(big.Int)
	frac := new(big.Int)
	whole.QuoRem(raw, divisor, frac)
	if frac.Sign() == 0 {
		return whole.String()
	}
	fracStr := frac.String()
	for len(fracStr) < decimals {
		fracStr = "0" + fracStr
	}
	for len(fracStr) > 0 && fracStr[len(fracStr)-1] == '0' {
		fracStr = fracStr[:len(fracStr)-1]
	}
	return whole.String() + "." + fracStr
}

func parseHumanAmount(s string, decimals int) (*big.Int, error) {
	if s == "" {
		return big.NewInt(0), nil
	}
	neg := false
	if s[0] == '-' {
		neg = true
		s = s[1:]
	}
	whole := s
	frac := ""
	for i, c := range s {
		if c == '.' {
			whole = s[:i]
			frac = s[i+1:]
			break
		}
	}
	if len(frac) > decimals {
		frac = frac[:decimals]
	}
	for len(frac) < decimals {
		frac += "0"
	}
	combined := whole + frac
	if combined == "" {
		combined = "0"
	}
	n, ok := new(big.Int).SetString(combined, 10)
	if !ok {
		return nil, fmt.Errorf("invalid amount: %s", s)
	}
	if neg {
		n.Neg(n)
	}
	return n, nil
}
