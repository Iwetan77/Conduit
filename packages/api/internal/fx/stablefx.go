package fx

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/kzn-labs/conduit/api/internal/currency"
	apierrors "github.com/kzn-labs/conduit/api/internal/errors"
	"github.com/kzn-labs/conduit/api/internal/httpx"
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
		httpClient: httpx.Client(15 * time.Second),
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
	ID        string          `json:"id"`
	Rate      string          `json:"rate"`
	From      quoteAmount     `json:"from"`
	To        quoteAmount     `json:"to"`
	CreatedAt time.Time       `json:"createdAt"`
	ExpiresAt time.Time       `json:"expiresAt"`
	Fee       string          `json:"fee"`
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
		switch env.Code {
		case 3008: // "At least one of the quote currencies is invalid."
			return Quote{}, apierrors.E(apierrors.CodeFxNoRoute, "")
		case 3005: // "The quote amount is invalid." — below/above StableFX's quotable range
			return Quote{}, apierrors.E(apierrors.CodeFxInvalidAmount, "amount")
		default:
			// Genuinely unrecognized upstream error — internal is honest here (we
			// don't have a mapped code for it) but log-worthy; the raw code/message
			// never reaches the client per spec §2.6, only this generic fallback.
			return Quote{}, apierrors.E(apierrors.CodeFxProviderUnavailable, "")
		}
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
//
//	POST /:id/quote    -> returns Quote.RawTypedData            (sig #1 target)
//	POST /:id/prepare  -> takes sig #1, returns FundingTypedData (sig #2 target)
//	POST /:id/confirm  -> takes sig #2, submits on-chain
//
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
		// An expired or already-consumed quote is the one failure the payer can
		// actually act on: show a fresh rate and ask again. Everything else is
		// opaque to them by design (spec §2.6), so it stays generic.
		msg := strings.ToLower(tradeEnv.Message)
		if strings.Contains(msg, "expired") || strings.Contains(msg, "no longer valid") {
			return Preparation{}, apierrors.E(apierrors.CodeFxQuoteExpired, "")
		}
		return Preparation{}, fmt.Errorf("stablefx trade creation failed (%d): %s", tradeEnv.Code, tradeEnv.Message)
	}

	// Trade creation is async: Circle's relayer calls FxEscrow.recordTrade() on
	// -chain (needs both taker+maker signed permits) before a contractTradeId
	// exists. Poll GET /trades/:id until it appears (observed live: status
	// moves "pending" -> "pending_settlement" within a few seconds). Not
	// documented anywhere; found by testing.
	contractTradeID := tradeEnv.Data.ContractTradeID
	tradeID := tradeEnv.Data.ID
	// Checked BEFORE sleeping. The old loop slept 500ms first, so a trade that
	// already carried a contractTradeId -- which the create response sometimes
	// returns outright -- still cost half a second to notice. See poll.go.
	poll(ctx, time.Now().Add(10*time.Second), func() bool {
		if contractTradeID != "" {
			return true
		}
		var getEnv struct {
			Data *struct {
				ContractTradeID string `json:"contractTradeId"`
				Status          string `json:"status"`
			} `json:"data"`
		}
		if _, err := p.get(ctx, "/v1/exchange/stablefx/trades/"+tradeID, &getEnv); err == nil && getEnv.Data != nil {
			contractTradeID = getEnv.Data.ContractTradeID
		}
		return contractTradeID != ""
	})
	if contractTradeID == "" {
		return Preparation{}, fmt.Errorf("stablefx trade %s never got a contractTradeId after polling", tradeID)
	}

	var presignEnv presignResponseEnvelope
	presignReq := presignRequest{ContractTradeIDs: []string{contractTradeID}, Type: "taker"}
	status, err = p.post(ctx, "/v1/exchange/stablefx/signatures/funding/presign", presignReq, &presignEnv)
	if err != nil {
		return Preparation{}, apierrors.E(apierrors.CodeFxProviderUnavailable, "")
	}
	if status != http.StatusOK && status != http.StatusCreated {
		return Preparation{}, fmt.Errorf("stablefx presign failed (%d): %s", presignEnv.Code, presignEnv.Message)
	}

	var ftd struct {
		Message struct {
			Permitted struct {
				Token  string `json:"token"`
				Amount string `json:"amount"`
			} `json:"permitted"`
			Spender  string          `json:"spender"`
			Nonce    string          `json:"nonce"`
			Deadline string          `json:"deadline"`
			Witness  json.RawMessage `json:"witness"`
		} `json:"message"`
	}
	if err := json.Unmarshal(presignEnv.Data.TypedData, &ftd); err != nil {
		return Preparation{}, fmt.Errorf("stablefx: unmarshal presign typedData: %w", err)
	}

	return Preparation{
		Provider:                p.Name(),
		ContractTradeID:         contractTradeID,
		FundingTypedData:        presignEnv.Data.TypedData,
		StableFXTradeID:         tradeID,
		StableFXPermittedToken:  ftd.Message.Permitted.Token,
		StableFXPermittedAmount: ftd.Message.Permitted.Amount,
		StableFXSpender:         ftd.Message.Spender,
		StableFXNonce:           ftd.Message.Nonce,
		StableFXDeadline:        ftd.Message.Deadline,
		StableFXWitnessMessage:  ftd.Message.Witness,
	}, nil
}

// fundRequest / fundPermit2 mirror POST /v1/exchange/stablefx/fund's real body
// shape (found by testing — not documented). This is NOT an on-chain call:
// per the DISCOVERY below, our own contracts can never redeem this signature,
// so "submission" here means handing it to Circle, whose relayer settles on
// FxEscrow directly.
type fundRequest struct {
	Type      string      `json:"type"`
	Signature string      `json:"signature"`
	Permit2   fundPermit2 `json:"permit2"`
}
type fundPermit2 struct {
	Permitted fundTokenPermissions `json:"permitted"`
	Spender   string               `json:"spender"`
	Nonce     string               `json:"nonce"`
	Deadline  string               `json:"deadline"`
	Witness   json.RawMessage      `json:"witness"`
}
type fundTokenPermissions struct {
	Token  string `json:"token"`
	Amount string `json:"amount"`
}

// Submit hands the payer's funding signature to Circle's OWN relayer via
// POST /v1/exchange/stablefx/fund, then polls trade status until it reaches a
// terminal state. Returns the maker-delivery leg's tx hash — the on-chain
// transaction that actually paid the recipient — for the caller to record as
// this settlement's tx_hash.
//
// DISCOVERY (verified live on Arc testnet, real signature, real balance delta
// confirmed exact): the funding permit StableFX's presign endpoint returns is
// signed with `spender` = Circle's own relayer contract, not our
// our own contracts. Permit2.permitWitnessTransferFrom authenticates the caller as
// msg.sender and requires it to equal the signed spender — a call from our own
// contract (as ConduitRouter.executeWithFX attempts) always reverts on
// signature verification; only Circle's relayer can ever redeem this
// signature. There is no on-chain call for Conduit to make here at all —
// submission IS this REST call. See ConduitRouter.sol's executeWithFX doc
// comment for the full writeup; that function is consequently dead code for
// the StableFX rail.
//
// Also verified live: the recipient receives EXACTLY the `settleAmount`
// requested in Quote() — despite the quote response's own `to.amount` field
// echoing back a grossed-up (requested+fee) figure. Trust the on-chain
// delivery, not that echoed number; the fee comes out of the payer's side
// (their `from.amount`/pay_amount), never out of what the recipient nets.
// This resolves the "fee gross-up" open question from earlier live testing.
// Submit funds the trade and waits for it to settle.
//
// Kept for callers that genuinely want both. The payer-facing path does NOT:
// see SubmitFunding and AwaitSettlement, which is the same work split at the
// point where the payer stops needing to watch.
func (p *StableFXProvider) Submit(ctx context.Context, prep Preparation, fundingSignature string) (makerDeliverTxHash string, err error) {
	if err := p.SubmitFunding(ctx, prep, fundingSignature); err != nil {
		return "", err
	}
	return p.AwaitSettlement(ctx, prep)
}

// SubmitFunding hands Circle the payer's funding signature. One round trip.
//
// Split from the waiting deliberately. This is the part the payer's browser has
// to be present for -- it is where a bad signature or an unfundable trade is
// rejected, and where an error is still theirs to act on. Everything after it
// is Circle's relayer landing three transactions on Arc, which the payer can be
// told about rather than made to sit through.
func (p *StableFXProvider) SubmitFunding(ctx context.Context, prep Preparation, fundingSignature string) error {
	req := fundRequest{
		Type:      "taker",
		Signature: fundingSignature,
		Permit2: fundPermit2{
			Permitted: fundTokenPermissions{Token: prep.StableFXPermittedToken, Amount: prep.StableFXPermittedAmount},
			Spender:   prep.StableFXSpender,
			Nonce:     prep.StableFXNonce,
			Deadline:  prep.StableFXDeadline,
			Witness:   prep.StableFXWitnessMessage,
		},
	}
	var empty json.RawMessage
	status, err := p.post(ctx, "/v1/exchange/stablefx/fund", req, &empty)
	if err != nil {
		return apierrors.E(apierrors.CodeFxProviderUnavailable, "")
	}
	if status != http.StatusOK && status != http.StatusCreated {
		return fmt.Errorf("stablefx fund submission failed (%d)", status)
	}
	return nil
}

// AwaitSettlement polls until Circle's maker leg has delivered, or fails.
//
// Runs detached from the payer's request. It takes as long as three Arc
// transactions take, which is not a wait a browser should be holding a socket
// open through -- and holding one through it was also a correctness bug: the
// server's WriteTimeout is 30s while this deadline is 60s, so a payment that
// settled at 35 seconds was reported to the payer as a network failure while
// the money had already moved.
func (p *StableFXProvider) AwaitSettlement(ctx context.Context, prep Preparation) (makerDeliverTxHash string, err error) {

	// Discovered live (2026-07-29): the top-level trade `status` field does not
	// reliably reach "settled"/"complete" even when the maker leg has already
	// delivered funds — it can sit at an intermediate value like
	// "maker_funded" indefinitely if the OTHER leg (taker, i.e. our payer)
	// fails, e.g. TRANSFER_FROM_FAILED on insufficient balance. Waiting on the
	// top-level status alone means a failed taker leg just silently burns the
	// full 60s timeout instead of surfacing the real error. Check both legs'
	// individual status directly instead: makerDeliver.status=="success" with
	// a populated txHash is the real completion signal (that's the money the
	// recipient actually received); a "failed" on either leg is reported
	// immediately with StableFX's own errorDetails, not a generic timeout.
	// Checked BEFORE sleeping, and on a ramp rather than a flat second.
	//
	// The old loop slept a full second at the top of every iteration, so the
	// fastest this could ever report a settled trade was one second after it
	// settled -- plus, on average, another half from the granularity. That is
	// a guaranteed 1.5s on a path measured at 11.5s, spent asleep before
	// anybody asked. Circle frequently has the answer immediately. See poll.go.
	deadline := time.Now().Add(60 * time.Second)
	var settledTxHash string
	var pollErr error

	poll(ctx, deadline, func() bool {
		var tradeEnv struct {
			Data *struct {
				Status               string `json:"status"`
				ContractTransactions struct {
					TakerDeliver struct {
						Status       string `json:"status"`
						TxHash       string `json:"txHash"`
						ErrorDetails string `json:"errorDetails"`
					} `json:"takerDeliver"`
					MakerDeliver struct {
						Status       string `json:"status"`
						TxHash       string `json:"txHash"`
						ErrorDetails string `json:"errorDetails"`
					} `json:"makerDeliver"`
				} `json:"contractTransactions"`
			} `json:"data"`
		}
		var raw json.RawMessage
		st, err := p.get(ctx, "/v1/exchange/stablefx/trades/"+prep.StableFXTradeID, &raw)
		if err != nil || st != http.StatusOK || raw == nil {
			return false
		}
		if err := json.Unmarshal(raw, &tradeEnv); err != nil || tradeEnv.Data == nil {
			return false
		}
		ct := tradeEnv.Data.ContractTransactions
		if ct.MakerDeliver.Status == "success" && ct.MakerDeliver.TxHash != "" {
			settledTxHash = ct.MakerDeliver.TxHash
			return true
		}
		// A failure is a RESULT, not a reason to keep waiting. Returning true
		// stops the poll; pollErr carries StableFX's own words rather than a
		// generic timeout sixty seconds later.
		if ct.TakerDeliver.Status == "failed" {
			pollErr = fmt.Errorf("stablefx trade %s: taker funding failed: %s", prep.StableFXTradeID, ct.TakerDeliver.ErrorDetails)
			return true
		}
		if ct.MakerDeliver.Status == "failed" {
			pollErr = fmt.Errorf("stablefx trade %s: maker delivery failed: %s", prep.StableFXTradeID, ct.MakerDeliver.ErrorDetails)
			return true
		}
		if tradeEnv.Data.Status == "failed" || tradeEnv.Data.Status == "breached" {
			pollErr = fmt.Errorf("stablefx trade %s ended in status %s", prep.StableFXTradeID, tradeEnv.Data.Status)
			return true
		}
		return false
	})

	if pollErr != nil {
		return "", pollErr
	}
	if settledTxHash != "" {
		return settledTxHash, nil
	}
	return "", fmt.Errorf("stablefx trade %s did not settle within 60s", prep.StableFXTradeID)
}

func (p *StableFXProvider) get(ctx context.Context, path string, out any) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.baseURL+path, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+p.apiKey)
	resp, err := p.httpClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, err
	}
	if err := json.Unmarshal(body, out); err != nil {
		return resp.StatusCode, fmt.Errorf("stablefx: unmarshal response: %w", err)
	}
	return resp.StatusCode, nil
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
