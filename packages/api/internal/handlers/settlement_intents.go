package handlers

import (
	"context"
	"encoding/json"
	"log"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kzn-labs/conduit/api/internal/auth"
	"github.com/kzn-labs/conduit/api/internal/currency"
	apierrors "github.com/kzn-labs/conduit/api/internal/errors"
	"github.com/kzn-labs/conduit/api/internal/fx"
	"github.com/kzn-labs/conduit/api/internal/links"
	"github.com/kzn-labs/conduit/api/internal/models"
	"github.com/kzn-labs/conduit/api/internal/webhooks"
)

type SettlementIntents struct {
	Pool       *pgxpool.Pool
	StableFX   *fx.StableFXProvider
	AppBaseURL string
	Webhooks   *webhooks.Dispatcher
	// ArcRPC is used by RecordDirectSettlement to fetch a same-currency
	// payment's tx receipt and verify on-chain that the settle token actually
	// reached the merchant — the record endpoint never trusts the caller's word.
	ArcRPC string
}

type createIntentRequest struct {
	Amount           *bigAmount     `json:"amount"` // string or number; see big_amount.go
	SettleCurrency   string         `json:"settle_currency"`
	SettleAddress    string         `json:"settle_address"`
	AcceptCurrencies []string       `json:"accept_currencies"`
	Reference        string         `json:"reference"`
	ExpiresIn        int64          `json:"expires_in"`
	Metadata         map[string]any `json:"metadata"`
	// SourceChain: "arc" (default, today's behavior, no bridge) or a CCTP
	// source domain name like "solana". Non-"arc" runs a bridging pre-stage
	// (internal/bridge) before the existing quote/settle path -- see
	// internal/bridge/README.md.
	SourceChain string `json:"source_chain"`
	// ReturnURL is where the hosted checkout sends the buyer once the payment
	// settles -- the merchant's own "thank you" page. Required for the mobile
	// redirect flow (wallet in-app browsers can't open a tab, so conduit.js
	// navigates in place and the buyer must be sent back).
	//
	// Only honoured on this authenticated (sk_) path, never from the browser:
	// a browser-supplied return URL would let anyone craft a checkout link that
	// redirects a paying buyer to a phishing site.
	ReturnURL string `json:"return_url"`
}

// validReturnURL keeps the stored redirect target to absolute http(s) URLs, so
// a stored value can never be a javascript:/data: payload that the checkout
// would then navigate to.
func validReturnURL(raw string) bool {
	if raw == "" {
		return true // optional
	}
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	return (u.Scheme == "https" || u.Scheme == "http") && u.Host != ""
}

type intentResponse struct {
	ID               string         `json:"id"`
	Status           string         `json:"status"`
	Amount           string         `json:"amount"`
	SettleCurrency   string         `json:"settle_currency"`
	SettleAddress    string         `json:"settle_address"`
	AcceptCurrencies []string       `json:"accept_currencies"`
	Reference        string         `json:"reference,omitempty"`
	Metadata         map[string]any `json:"metadata"`
	ExpiresAt        time.Time      `json:"expires_at"`
	Created          time.Time      `json:"created"`
	HostedURL        string         `json:"hosted_url"`
	QRPayload        string         `json:"qr_payload"`
	SourceChain      string         `json:"source_chain"`
}

func (h *SettlementIntents) Create(w http.ResponseWriter, r *http.Request) {
	principal, _ := auth.FromContext(r.Context())

	var req createIntentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "body"))
		return
	}
	if req.Amount == nil || req.Amount.Sign() <= 0 {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "amount"))
		return
	}
	if _, ok := currency.ByISO(req.SettleCurrency); !ok {
		writeErr(w, apierrors.E(apierrors.CodeCurrencyNotSupported, "settle_currency"))
		return
	}
	if req.SettleAddress == "" {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "settle_address"))
		return
	}
	if !validReturnURL(req.ReturnURL) {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "return_url"))
		return
	}
	expiresIn := req.ExpiresIn
	if expiresIn <= 0 {
		expiresIn = 3600
	}
	if req.AcceptCurrencies == nil {
		req.AcceptCurrencies = []string{}
	}
	if req.SourceChain == "" {
		req.SourceChain = "arc"
	}

	ctx := r.Context()
	q := queryable(ctx, h.Pool)

	id := models.NewID("si")
	expiresAt := time.Now().Add(time.Duration(expiresIn) * time.Second)
	metadataJSON, _ := json.Marshal(req.Metadata)
	if req.Metadata == nil {
		metadataJSON = []byte("{}")
	}

	_, err := q.Exec(ctx,
		`INSERT INTO settlement_intents
		 (id, account_id, amount, settle_currency, settle_address, accept_currencies, status, reference, metadata, expires_at, livemode, source_chain, return_url)
		 VALUES ($1,$2,$3,$4,$5,$6,'created',$7,$8,$9,$10,$11,$12)`,
		id, principal.AccountID, req.Amount.String(), req.SettleCurrency, req.SettleAddress,
		req.AcceptCurrencies, nullIfEmpty(req.Reference), metadataJSON, expiresAt, principal.Livemode, req.SourceChain,
		nullIfEmpty(req.ReturnURL),
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	writeJSON(w, http.StatusCreated, h.toResponse(id, req.Amount.String(), "created", req.SettleCurrency,
		req.SettleAddress, req.AcceptCurrencies, req.Reference, req.Metadata, expiresAt, time.Now(), req.SourceChain))
}

type createDirectIntentRequest struct {
	createIntentRequest
	// PayerWallet is the connected wallet the payer is sending from. It is
	// the account key for a direct send -- not a credential.
	PayerWallet string `json:"payer_wallet"`
}

// CreateDirect is POST /v1/settlement_intents/direct -- the unauthenticated
// direct-send path, for a payer who has connected a wallet and nothing else.
//
// Why this exists: cross-currency settles through Circle StableFX, which
// prices and delivers against a settlement intent. settlement_intents.account_id
// is NOT NULL, so an intent needs an owner row. Routing that through Privy
// sign-in meant "send EURC while holding USDC" demanded an account, which is
// not what a direct send is. This provisions a wallet-keyed personal account
// instead (idempotent -- see migration 0008) and creates the intent under it.
//
// On the security boundary: this is deliberately open, exactly like
// payment_links/{id}/pay and the bridge routes. Creating an intent moves no
// money and grants no read access to anyone else's data -- the caller supplies
// their own settle_address, and every subsequent step (quote, prepare,
// confirm) requires the payer's own wallet signature over Circle's EIP-712
// payloads. The worst an abuser gets is orphan rows in their own account.
// Intents are always testmode here: livemode is false, so this can never
// mint a live-mode owner row.
func (h *SettlementIntents) CreateDirect(w http.ResponseWriter, r *http.Request) {
	var req createDirectIntentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "body"))
		return
	}
	if req.PayerWallet == "" {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "payer_wallet"))
		return
	}
	if req.Amount == nil || req.Amount.Sign() <= 0 {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "amount"))
		return
	}
	// settlement_intents.settle_currency stores an ISO code ("USD"), but the
	// payer surface speaks token symbols ("USDC") -- that's what the wallet
	// and the currency picker deal in. Accept either and normalize, the same
	// way Quote already resolves pay_currency by symbol then ISO.
	settleInfo, ok := currency.BySymbol(req.SettleCurrency)
	if !ok {
		settleInfo, ok = currency.ByISO(req.SettleCurrency)
		if !ok {
			writeErr(w, apierrors.E(apierrors.CodeCurrencyNotSupported, "settle_currency"))
			return
		}
	}
	req.SettleCurrency = settleInfo.ISO

	if req.SettleAddress == "" {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "settle_address"))
		return
	}

	ctx := r.Context()
	accountID, err := h.personalAccountForWallet(ctx, req.PayerWallet, req.SettleCurrency)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	expiresIn := req.ExpiresIn
	if expiresIn <= 0 {
		expiresIn = 3600
	}
	if req.AcceptCurrencies == nil {
		req.AcceptCurrencies = []string{}
	}
	if req.SourceChain == "" {
		req.SourceChain = "arc"
	}

	id := models.NewID("si")
	expiresAt := time.Now().Add(time.Duration(expiresIn) * time.Second)
	metadataJSON, _ := json.Marshal(req.Metadata)
	if req.Metadata == nil {
		metadataJSON = []byte("{}")
	}

	_, err = h.Pool.Exec(ctx,
		`INSERT INTO settlement_intents
		 (id, account_id, amount, settle_currency, settle_address, accept_currencies, status, reference, metadata, expires_at, livemode, source_chain)
		 VALUES ($1,$2,$3,$4,$5,$6,'created',$7,$8,$9,false,$10)`,
		id, accountID, req.Amount.String(), req.SettleCurrency, req.SettleAddress,
		req.AcceptCurrencies, nullIfEmpty(req.Reference), metadataJSON, expiresAt, req.SourceChain,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	writeJSON(w, http.StatusCreated, h.toResponse(id, req.Amount.String(), "created", req.SettleCurrency,
		req.SettleAddress, req.AcceptCurrencies, req.Reference, req.Metadata, expiresAt, time.Now(), req.SourceChain))
}

// personalAccountForWallet returns the wallet-keyed personal account for
// `wallet`, creating it on first use. Idempotent: the partial unique index
// from migration 0008 turns a concurrent double-insert into a conflict we
// resolve by re-reading, so a payer never accumulates one account per send.
func (h *SettlementIntents) personalAccountForWallet(ctx context.Context, wallet, settleCurrency string) (string, error) {
	// "Has no login identity" is the test for a personal account, and it has to
	// name every column an identity can live in. It used to check
	// privy_user_id alone, which stopped meaning that the moment migration 0014
	// moved identity to auth_provider/auth_subject: a merchant signed in with
	// Circle has privy_user_id NULL, so their MERCHANT account matched here and
	// every payer-created link was attached to it -- shown under the business
	// name and recorded against the merchant's books.
	lookup := `SELECT id FROM accounts
	           WHERE privy_user_id IS NULL AND auth_subject IS NULL
	             AND lower(login_wallet) = lower($1)`

	var accountID string
	err := h.Pool.QueryRow(ctx, lookup, wallet).Scan(&accountID)
	if err == nil {
		return accountID, nil
	}
	if err != pgx.ErrNoRows {
		return "", err
	}

	accountID = models.NewID("acct")
	// Shown to the payer as display_name on /pay for payer-created (si_) links,
	// so it must be presentable. Just "Personal" -- the wallet address is
	// already rendered, shortened, right below it on the pay screen, so
	// appending the full 42-char address here only produced an ugly overflowing
	// "Personal 0xa51dd4...b0..." header on mobile.
	name := "Personal"
	_, err = h.Pool.Exec(ctx,
		`INSERT INTO accounts (id, name, settle_currency, settle_address, login_wallet, livemode)
		 VALUES ($1,$2,$3,$4,$5,false)
		 ON CONFLICT DO NOTHING`,
		accountID, name, settleCurrency, wallet, wallet,
	)
	if err != nil {
		return "", err
	}

	// ON CONFLICT DO NOTHING means a racing request may have won; re-read
	// rather than assuming our id landed.
	if scanErr := h.Pool.QueryRow(ctx, lookup, wallet).Scan(&accountID); scanErr != nil {
		return "", scanErr
	}
	return accountID, nil
}

type publicIntentResponse struct {
	ID             string    `json:"id"`
	Status         string    `json:"status"`
	Amount         string    `json:"amount"`
	SettleCurrency string    `json:"settle_currency"`
	SourceChain    string    `json:"source_chain"`
	ExpiresAt      time.Time `json:"expires_at"`
	// DisplayName/LogoURL: Phase 4 recipient identity -- a payer looking at
	// a bare hex address won't pay; the business name is what they need to
	// see first. settle_address is still available for verification (the
	// payer surface renders it secondary, e.g. on hover/expand) but is
	// deliberately not the primary label anymore.
	DisplayName   string  `json:"display_name"`
	LogoURL       *string `json:"logo_url,omitempty"`
	SettleAddress string  `json:"settle_address"`
	// ReturnURL: where to send the buyer after settling. Safe to expose --
	// it was set by the merchant's own server with their secret key, and the
	// checkout has to know it to complete the mobile redirect flow.
	ReturnURL string `json:"return_url,omitempty"`
}

// GetPublic is GET /v1/settlement_intents/:id/public -- unauthenticated,
// for the payer surface (/pay/[id]). A payer landing on a bare payment link
// has no API key at all, so this exposes only what's safe to show a
// stranger: amount, currency, status, source_chain, expiry, and the
// recipient's display identity. Deliberately omits account_id, reference,
// and metadata.
func (h *SettlementIntents) GetPublic(w http.ResponseWriter, r *http.Request) {
	id := pathParam(r, "id")

	var resp publicIntentResponse
	resp.ID = id
	err := h.Pool.QueryRow(r.Context(),
		`SELECT si.amount::text, si.status, si.settle_currency, si.source_chain, si.expires_at, si.settle_address,
		        a.name, a.logo_url, COALESCE(si.return_url,'')
		 FROM settlement_intents si JOIN accounts a ON a.id = si.account_id
		 WHERE si.id = $1`,
		id,
	).Scan(&resp.Amount, &resp.Status, &resp.SettleCurrency, &resp.SourceChain, &resp.ExpiresAt, &resp.SettleAddress,
		&resp.DisplayName, &resp.LogoURL, &resp.ReturnURL)
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

func (h *SettlementIntents) Get(w http.ResponseWriter, r *http.Request) {
	id := pathParam(r, "id")
	principal, _ := auth.FromContext(r.Context())

	var amount, status, settleCurrency, settleAddress, reference, sourceChain string
	var acceptCurrencies []string
	var metadataJSON []byte
	var expiresAt, created time.Time

	err := h.Pool.QueryRow(r.Context(),
		`SELECT amount::text, status, settle_currency, settle_address, accept_currencies,
		        COALESCE(reference,''), metadata, expires_at, created_at, source_chain
		 FROM settlement_intents WHERE id = $1 AND account_id = $2`,
		id, principal.AccountID,
	).Scan(&amount, &status, &settleCurrency, &settleAddress, &acceptCurrencies, &reference, &metadataJSON, &expiresAt, &created, &sourceChain)
	if err != nil {
		if err == pgx.ErrNoRows {
			writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
			return
		}
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	var metadata map[string]any
	json.Unmarshal(metadataJSON, &metadata)

	resp := h.toResponse(id, amount, status, settleCurrency, settleAddress, acceptCurrencies, reference, metadata, expiresAt, created, sourceChain)
	writeJSON(w, http.StatusOK, resp)
}

// List implements GET /v1/settlement_intents — the dashboard's Settlements
// screen (v2 spec §3.1) lists off this. Not in the original spec's endpoint
// table (only GET /:id was listed) but needed for the dashboard to have
// anything to show; a reasonable, minimal addition.
func (h *SettlementIntents) List(w http.ResponseWriter, r *http.Request) {
	principal, _ := auth.FromContext(r.Context())

	res, qErr := h.Pool.Query(r.Context(),
		`SELECT id, amount::text, status, settle_currency, settle_address, accept_currencies,
		        COALESCE(reference,''), metadata, expires_at, created_at, source_chain
		 FROM settlement_intents WHERE account_id = $1 ORDER BY created_at DESC LIMIT 100`,
		principal.AccountID,
	)
	if qErr != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	defer res.Close()

	var results []intentResponse
	for res.Next() {
		var id, amount, status, settleCurrency, settleAddress, reference, sourceChain string
		var acceptCurrencies []string
		var metadataJSON []byte
		var expiresAt, created time.Time
		if err := res.Scan(&id, &amount, &status, &settleCurrency, &settleAddress, &acceptCurrencies, &reference, &metadataJSON, &expiresAt, &created, &sourceChain); err != nil {
			writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
			return
		}
		var metadata map[string]any
		json.Unmarshal(metadataJSON, &metadata)
		results = append(results, h.toResponse(id, amount, status, settleCurrency, settleAddress, acceptCurrencies, reference, metadata, expiresAt, created, sourceChain))
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": results})
}

func (h *SettlementIntents) Cancel(w http.ResponseWriter, r *http.Request) {
	id := pathParam(r, "id")
	principal, _ := auth.FromContext(r.Context())

	tag, err := h.Pool.Exec(r.Context(),
		`UPDATE settlement_intents SET status = 'canceled', updated_at = now()
		 WHERE id = $1 AND account_id = $2 AND status IN ('created','quoted')`,
		id, principal.AccountID,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, apierrors.E(apierrors.CodeIntentAlreadySettled, "id"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "canceled"})
}

type quoteResponse struct {
	Provider    string          `json:"provider"`
	Rate        string          `json:"rate"`
	PayAmount   string          `json:"pay_amount"`
	PayCurrency string          `json:"pay_currency"`
	ExpiresAt   int64           `json:"expires_at"`
	TypedData   json.RawMessage `json:"typed_data,omitempty"`
}

// Quote implements POST /:id/quote. Per the v2 spec §2.2: this is deliberately
// the ONLY step allowed to happen before the payer is present — it does not
// create a StableFX trade (that's Prepare), so there's no cost to calling it
// speculatively or re-calling it on expiry.
func (h *SettlementIntents) Quote(w http.ResponseWriter, r *http.Request) {
	id := pathParam(r, "id")
	accountID, acctErr := h.resolveIntentAccount(r.Context(), id)
	if acctErr != nil {
		writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
		return
	}

	var quoteBody struct {
		PayCurrency string `json:"pay_currency"`
		// PayAddress is the wallet that will SIGN the two EIP-712 payloads.
		// Circle recovers the signer from the quote signature and checks it
		// against the address we register on the trade, so this must be the
		// payer -- not the recipient.
		PayAddress string `json:"pay_address"`
	}
	if err := json.NewDecoder(r.Body).Decode(&quoteBody); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "body"))
		return
	}
	payCurrency := quoteBody.PayCurrency

	var amountStr, settleCurrencyISO, settleAddress, status string
	err := h.Pool.QueryRow(r.Context(),
		`SELECT amount::text, settle_currency, settle_address, status FROM settlement_intents WHERE id = $1 AND account_id = $2`,
		id, accountID,
	).Scan(&amountStr, &settleCurrencyISO, &settleAddress, &status)
	if err != nil {
		if err == pgx.ErrNoRows {
			writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
			return
		}
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	if status == "settled" {
		writeErr(w, apierrors.E(apierrors.CodeIntentAlreadySettled, "id"))
		return
	}

	settleInfo, ok := currency.ByISO(settleCurrencyISO)
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeCurrencyNotSupported, "settle_currency"))
		return
	}
	if payCurrency == "" {
		payCurrency = settleInfo.Symbol
	}
	payInfo, ok := currency.BySymbol(payCurrency)
	if !ok {
		payInfo, ok = currency.ByISO(payCurrency)
		if !ok {
			writeErr(w, apierrors.E(apierrors.CodeCurrencyNotSupported, "pay_currency"))
			return
		}
	}

	amount, _ := new(big.Int).SetString(amountStr, 10)

	// The payer signs; the recipient receives. Storing settle_address here --
	// as this did -- made Circle verify the payer's signature against the
	// RECIPIENT's address and reject every cross-wallet trade with "the
	// provided signature could not be verified against the expected address".
	// It went unnoticed because docs/quickstart.md pays itself, where the two
	// addresses are the same key. Falling back to settleAddress preserves
	// exactly that case for callers that don't send pay_address.
	payAddress := strings.TrimSpace(quoteBody.PayAddress)
	if payAddress == "" {
		payAddress = settleAddress
	}

	var q fx.Quote
	if payInfo.Symbol == settleInfo.Symbol {
		q, err = fx.DirectProvider{}.Quote(r.Context(), payInfo.Symbol, settleInfo.Symbol, amount, settleAddress)
	} else {
		q, err = h.StableFX.Quote(r.Context(), payInfo.Symbol, settleInfo.Symbol, amount, settleAddress)
	}
	if err != nil {
		if apiErr, ok := err.(*apierrors.APIError); ok {
			writeErr(w, apiErr)
			return
		}
		// The client message is deliberately generic, but the real cause must
		// not vanish: "trade creation failed (400): ..." and "never got a
		// contractTradeId" both used to surface as the same opaque string,
		// leaving no way to tell them apart without a wallet signature.
		log.Printf("fx: intent=%s stage=%s err=%v", id, "provider", err)
		writeErr(w, apierrors.E(apierrors.CodeFxProviderUnavailable, ""))
		return
	}

	_, _ = h.Pool.Exec(r.Context(), `UPDATE settlement_intents SET status = 'quoted', updated_at = now() WHERE id = $1 AND status = 'created'`, id)

	// Persist the fx_trade row in 'quoted' state so /prepare can find the
	// exact quote (and its signable typed data) that /confirm's caller is
	// about to authorize. Direct (same-currency) quotes don't need this —
	// there's no StableFX trade to create for them.
	if q.Provider == "stablefx" {
		tradeID := models.NewID("fxt")
		expiresAt := time.Unix(q.ExpiresAt, 0)
		_, err = h.Pool.Exec(r.Context(),
			`INSERT INTO fx_trades (id, intent_id, provider, state, pay_currency, pay_amount, pay_address, rate, quote_id, quote_expires_at, quote_typed_data)
			 VALUES ($1,$2,'stablefx','quoted',$3,$4,$5,$6,$7,$8,$9)`,
			tradeID, id, payInfo.Symbol, q.FromAmount.String(), payAddress, q.Rate, q.QuoteID, expiresAt, q.RawTypedData,
		)
		if err != nil {
			writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
			return
		}
	}

	writeJSON(w, http.StatusOK, quoteResponse{
		Provider: q.Provider, Rate: q.Rate, PayAmount: q.FromAmount.String(),
		PayCurrency: payInfo.Symbol, ExpiresAt: q.ExpiresAt, TypedData: q.RawTypedData,
	})
}

type prepareRequest struct {
	QuoteMessage   json.RawMessage `json:"quote_message"`
	QuoteSignature string          `json:"quote_signature"`
}
type prepareResponse struct {
	FundingTypedData json.RawMessage `json:"funding_typed_data"`
}

// Prepare implements POST /:id/prepare — accepts the payer's signature over
// the quote's own typed data (sig #1, see stablefx.go's PrepareWithSignature
// doc comment for why this exists), creates the StableFX trade, and returns
// the funding typed data for the payer to sign next (sig #2, -> /confirm).
func (h *SettlementIntents) Prepare(w http.ResponseWriter, r *http.Request) {
	id := pathParam(r, "id")
	accountID, acctErr := h.resolveIntentAccount(r.Context(), id)
	if acctErr != nil {
		writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
		return
	}

	var req prepareRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.QuoteSignature == "" {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "quote_message, quote_signature"))
		return
	}

	var trade struct {
		id, payCurrency, payAmount, settleCurrencyISO, payAddress string
		rate                                                      string
		quoteID                                                   string
		quoteExpiresAt                                            time.Time
	}
	err := h.Pool.QueryRow(r.Context(),
		`SELECT ft.id, ft.pay_currency, ft.pay_amount::text, si.settle_currency, ft.pay_address, ft.rate, ft.quote_id, ft.quote_expires_at
		 FROM fx_trades ft JOIN settlement_intents si ON si.id = ft.intent_id
		 WHERE ft.intent_id = $1 AND si.account_id = $2 AND ft.state = 'quoted'
		 ORDER BY ft.created_at DESC LIMIT 1`,
		id, accountID,
	).Scan(&trade.id, &trade.payCurrency, &trade.payAmount, &trade.settleCurrencyISO, &trade.payAddress, &trade.rate, &trade.quoteID, &trade.quoteExpiresAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
			return
		}
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	// Circle's quotes carry a ~3.5-5s TTL (docs/fx-capability.md), and the
	// payer has to open a wallet and approve an EIP-712 payload in between the
	// quote and this call. No human does that in five seconds, so rejecting a
	// stale quote HERE made cross-currency structurally impossible: every real
	// payment failed with fx_quote_expired before Circle was ever asked.
	//
	// docs/fx-timing.md assumed /prepare could re-quote and then hand back
	// typed data to sign. It can't: Circle requires a signature over the
	// QUOTE's own typed data before a trade exists (see PrepareWithSignature),
	// which puts the human strictly between quote and prepare.
	//
	// So Circle is the authority on its own quote's validity. Attempt the
	// trade and let it decide; a rejection maps to fx_quote_expired below and
	// the payer is shown a fresh rate to approve.
	if time.Now().After(trade.quoteExpiresAt) {
		log.Printf("fx: intent=%s quote %s past local TTL by %s, attempting anyway",
			id, trade.quoteID, time.Since(trade.quoteExpiresAt).Round(time.Millisecond))
	}

	settleInfo, _ := currency.ByISO(trade.settleCurrencyISO)
	payAmount, _ := new(big.Int).SetString(trade.payAmount, 10)
	q := fx.Quote{Provider: "stablefx", QuoteID: trade.quoteID, FromCurrency: trade.payCurrency, ToCurrency: settleInfo.Symbol, FromAmount: payAmount, Rate: trade.rate}

	prep, err := h.StableFX.PrepareWithSignature(r.Context(), q, trade.payAddress, req.QuoteMessage, req.QuoteSignature)
	if err != nil {
		if apiErr, ok := err.(*apierrors.APIError); ok {
			writeErr(w, apiErr)
			return
		}
		// The client message is deliberately generic, but the real cause must
		// not vanish: "trade creation failed (400): ..." and "never got a
		// contractTradeId" both used to surface as the same opaque string,
		// leaving no way to tell them apart without a wallet signature.
		_, _ = h.Pool.Exec(r.Context(),
			`UPDATE fx_trades SET last_error = $2, updated_at = now() WHERE id = $1`,
			trade.id, err.Error())
		log.Printf("fx: intent=%s stage=%s err=%v", id, "provider", err)
		writeErr(w, apierrors.E(apierrors.CodeFxProviderUnavailable, ""))
		return
	}

	_, err = h.Pool.Exec(r.Context(),
		`UPDATE fx_trades SET state = 'presigned', contract_trade_id = $1, stablefx_trade_uuid = $2, funding_typed_data = $3, updated_at = now() WHERE id = $4`,
		prep.ContractTradeID, prep.StableFXTradeID, prep.FundingTypedData, trade.id,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	_, _ = h.Pool.Exec(r.Context(), `UPDATE settlement_intents SET status = 'funding', updated_at = now() WHERE id = $1`, id)

	// Stash the fields Submit() needs, so /confirm doesn't have to re-derive
	// them from funding_typed_data JSON. Reuses the witness/witness_type_string
	// columns for the Permit2 fields Submit actually needs (spender/nonce/
	// deadline/token/amount packed as JSON) since this provider never
	// constructs an on-chain Permit2 call itself — see stablefx.go.
	permit2JSON, _ := json.Marshal(map[string]string{
		"token": prep.StableFXPermittedToken, "amount": prep.StableFXPermittedAmount,
		"spender": prep.StableFXSpender, "nonce": prep.StableFXNonce, "deadline": prep.StableFXDeadline,
	})
	_, _ = h.Pool.Exec(r.Context(),
		`UPDATE fx_trades SET witness = $1, witness_type_string = $2 WHERE id = $3`,
		string(permit2JSON), string(prep.StableFXWitnessMessage), trade.id,
	)

	writeJSON(w, http.StatusOK, prepareResponse{FundingTypedData: prep.FundingTypedData})
}

type confirmRequest struct {
	FundingSignature string `json:"funding_signature"`
}
type confirmResponse struct {
	Status string `json:"status"`
	TxHash string `json:"tx_hash,omitempty"`
}

// Confirm implements POST /:id/confirm — accepts the payer's signature over
// the funding typed data (sig #2) and hands it to Circle's relayer. See
// stablefx.go's Submit doc comment for why this is a REST call to Circle, not
// an on-chain transaction Conduit constructs itself.
func (h *SettlementIntents) Confirm(w http.ResponseWriter, r *http.Request) {
	id := pathParam(r, "id")
	accountID, acctErr := h.resolveIntentAccount(r.Context(), id)
	if acctErr != nil {
		writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
		return
	}

	var req confirmRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.FundingSignature == "" {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "funding_signature"))
		return
	}

	var tradeID, tradeUUID, permit2JSON, witnessMessage string
	err := h.Pool.QueryRow(r.Context(),
		`SELECT ft.id, ft.stablefx_trade_uuid, ft.witness, ft.witness_type_string
		 FROM fx_trades ft JOIN settlement_intents si ON si.id = ft.intent_id
		 WHERE ft.intent_id = $1 AND si.account_id = $2 AND ft.state = 'presigned'
		 ORDER BY ft.created_at DESC LIMIT 1`,
		id, accountID,
	).Scan(&tradeID, &tradeUUID, &permit2JSON, &witnessMessage)
	if err != nil {
		if err == pgx.ErrNoRows {
			writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
			return
		}
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	var permit2 struct{ Token, Amount, Spender, Nonce, Deadline string }
	json.Unmarshal([]byte(permit2JSON), &permit2)

	prep := fx.Preparation{
		StableFXTradeID: tradeUUID, StableFXPermittedToken: permit2.Token, StableFXPermittedAmount: permit2.Amount,
		StableFXSpender: permit2.Spender, StableFXNonce: permit2.Nonce, StableFXDeadline: permit2.Deadline,
		StableFXWitnessMessage: []byte(witnessMessage),
	}

	_, _ = h.Pool.Exec(r.Context(), `UPDATE fx_trades SET state = 'submitted', funding_signature = $1, updated_at = now() WHERE id = $2`, req.FundingSignature, tradeID)

	makerTxHash, err := h.StableFX.Submit(r.Context(), prep, req.FundingSignature)
	if err != nil {
		// Persist the reason, not just log it. The payer has signed twice by
		// now, so this is the worst possible place to lose why it failed --
		// and a log line on the running host is unreachable to anyone
		// debugging from the database side.
		_, _ = h.Pool.Exec(r.Context(),
			`UPDATE fx_trades SET state = 'failed', last_error = $2, updated_at = now() WHERE id = $1`,
			tradeID, err.Error())
		log.Printf("fx: intent=%s stage=submit trade=%s err=%v", id, tradeID, err)
		writeErr(w, apierrors.E(apierrors.CodeFxProviderUnavailable, ""))
		return
	}

	_, _ = h.Pool.Exec(r.Context(), `UPDATE fx_trades SET state = 'settled', updated_at = now() WHERE id = $1`, tradeID)
	_, _ = h.Pool.Exec(r.Context(), `UPDATE settlement_intents SET status = 'settled', updated_at = now() WHERE id = $1`, id)

	// Now — and only now, with money actually delivered — is the payment link
	// (if this intent came from one) genuinely paid. This is the transition that
	// used to fire prematurely at checkout start; see payment_links.go Pay().
	_, _ = h.Pool.Exec(r.Context(),
		links.SettleByIntentSQL,
		id)

	// Record settlements + balance_transactions so GET /v1/balance_transactions
	// and the CSV export have something to show for FX-routed settlements
	// (the indexer only ever sees direct/AMM ConduitRouter events — see its
	// package doc comment — so this path has to record its own rows).
	// KNOWN GAP: fee is recorded as 0 here. StableFX's quote response does
	// carry a real fee figure but Confirm doesn't have it in scope at this
	// point (would need threading it through from Quote via fx_trades) --
	// noted in whereistopped.md, not fixed this session.
	var settleAmount, settleCurrency, payCurrency, payAmount, rate, fxPayerAddress string
	h.Pool.QueryRow(r.Context(),
		`SELECT si.amount::text, si.settle_currency, ft.pay_currency, ft.pay_amount::text,
		        COALESCE(ft.rate::text,''), COALESCE(ft.pay_address,'')
		 FROM settlement_intents si JOIN fx_trades ft ON ft.id = $1 WHERE si.id = $2`,
		tradeID, id,
	).Scan(&settleAmount, &settleCurrency, &payCurrency, &payAmount, &rate, &fxPayerAddress)

	settlementRowID := models.NewID("stl")
	h.Pool.Exec(r.Context(),
		`INSERT INTO settlements (id, intent_id, fx_trade_id, tx_hash, receipt_id, pay_currency, pay_amount, settle_amount, rate_applied, fee, block_number, log_index, settled_at, payer_address)
		 VALUES ($1,$2,$3,$4,$4,$5,$6,$7,NULLIF($8,'')::numeric,0,0,0,now(),NULLIF($9,''))`,
		settlementRowID, id, tradeID, makerTxHash, payCurrency, payAmount, settleAmount, rate, fxPayerAddress,
	)
	balanceTxID := models.NewID("btx")
	h.Pool.Exec(r.Context(),
		`INSERT INTO balance_transactions (id, account_id, settlement_id, type, gross, fee, net, currency)
		 VALUES ($1,$2,$3,'settlement',$4,0,$4,$5)`,
		balanceTxID, accountID, settlementRowID, settleAmount, settleCurrency,
	)

	if h.Webhooks != nil {
		_ = h.Webhooks.Enqueue(r.Context(), accountID, "settlement.succeeded",
			links.SettledPayload(r.Context(), h.Pool, id, makerTxHash))
	}

	writeJSON(w, http.StatusOK, confirmResponse{Status: "settled", TxHash: makerTxHash})
}

// erc20TransferTopic is keccak256("Transfer(address,address,uint256)") — the
// topic[0] of every ERC-20 Transfer log. RecordDirectSettlement scans for one
// of these paying the settle token to the merchant.
var erc20TransferTopic = crypto.Keccak256Hash([]byte("Transfer(address,address,uint256)"))

type recordSettlementRequest struct {
	TxHash string `json:"tx_hash"`
}

// RecordDirectSettlement is POST /v1/settlement_intents/:id/record — the
// missing server-side recording for SAME-CURRENCY direct pays.
//
// Why this exists: a same-currency pay (USD merchant, USDC payer) settles
// straight on-chain via ConduitRouter in the payer's browser (see
// ArcSettlePanel). The money moves and PaymentSettled fires, but nothing on
// the server ever marked the intent settled: the indexer keys off
// settlement_intents.declaration_id, which the API never writes, so it's always
// NULL and never matches. Cross-currency (/confirm) and cross-chain (bridge)
// both record their own settlement server-side; this closes the same gap for
// the direct path, so the gateway's most common case actually fires a webhook
// and flips the merchant's checkout to "payment received".
//
// Unauthenticated, exactly like quote/prepare/confirm: a payer opening a
// hosted checkout or QR has no API key, and the intent id is the capability.
// It moves no money and grants no cross-account read. The report is never
// trusted — we fetch the tx receipt from Arc and verify the settle token
// actually reached the merchant's settle_address for at least the intent
// amount before recording anything. Idempotent on (tx_hash, log_index).
func (h *SettlementIntents) RecordDirectSettlement(w http.ResponseWriter, r *http.Request) {
	id := pathParam(r, "id")
	ctx := r.Context()

	var req recordSettlementRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "tx_hash"))
		return
	}
	txHash := strings.TrimSpace(req.TxHash)
	if !strings.HasPrefix(txHash, "0x") || len(txHash) != 66 {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "tx_hash"))
		return
	}

	var accountID, amountStr, settleISO, settleAddress, status string
	err := h.Pool.QueryRow(ctx,
		`SELECT account_id, amount::text, settle_currency, settle_address, status FROM settlement_intents WHERE id = $1`, id,
	).Scan(&accountID, &amountStr, &settleISO, &settleAddress, &status)
	if err != nil {
		if err == pgx.ErrNoRows {
			writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
			return
		}
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	if status == "settled" {
		// Already recorded (a retried report, or the indexer beat us). Report
		// success rather than erroring so the payer surface never sees a spurious
		// failure after the money has already landed.
		writeJSON(w, http.StatusOK, confirmResponse{Status: "settled", TxHash: txHash})
		return
	}

	settleInfo, ok := currency.ByISO(settleISO)
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeCurrencyNotSupported, "settle_currency"))
		return
	}
	amount, ok := new(big.Int).SetString(amountStr, 10)
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	if h.ArcRPC == "" {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	client, err := ethclient.DialContext(ctx, h.ArcRPC)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	defer client.Close()

	receipt, err := client.TransactionReceipt(ctx, common.HexToHash(txHash))
	if err != nil {
		// Not mined / unknown hash — the caller reported a tx we can't see.
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "tx_hash not found"))
		return
	}
	if receipt.Status != types.ReceiptStatusSuccessful {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "tx reverted"))
		return
	}

	// The only thing that makes this intent settled: an on-chain ERC-20
	// Transfer of the settle token, to the merchant's settle_address, for at
	// least the intent amount, inside the reported tx. We verify that directly
	// rather than trusting a PaymentSettled event (which would tie this to the
	// router address, unset in prod) — reaching the merchant's wallet is the
	// fact the merchant is paid on.
	tokenAddr := common.HexToAddress(settleInfo.Token)
	settleAddr := common.HexToAddress(settleAddress)
	var paidAmount *big.Int
	var matchedLogIndex uint
	// Topics[1] of the matched Transfer is who sent it: the payer, straight
	// from the chain, not something a caller can assert.
	var payerAddress string
	for _, lg := range receipt.Logs {
		if lg.Address != tokenAddr || len(lg.Topics) != 3 || lg.Topics[0] != erc20TransferTopic {
			continue
		}
		to := common.BytesToAddress(lg.Topics[2].Bytes())
		if to != settleAddr {
			continue
		}
		value := new(big.Int).SetBytes(lg.Data)
		if value.Cmp(amount) >= 0 {
			paidAmount = value
			matchedLogIndex = lg.Index
			payerAddress = common.BytesToAddress(lg.Topics[1].Bytes()).Hex()
			break
		}
	}
	if paidAmount == nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "tx does not settle this intent"))
		return
	}

	// Idempotent record. The unique (tx_hash, log_index) constraint means a
	// double report — or the indexer having beaten us — inserts nothing and we
	// skip the balance_transaction + webhook so neither ever fires twice.
	settlementID := models.NewID("stl")
	tag, err := h.Pool.Exec(ctx,
		`INSERT INTO settlements (id, intent_id, tx_hash, receipt_id, pay_currency, pay_amount, settle_amount, rate_applied, fee, block_number, log_index, settled_at, payer_address)
		 VALUES ($1,$2,$3,$3,$4,$5,$6,1,0,$7,$8,now(),NULLIF($9,''))
		 ON CONFLICT (tx_hash, log_index) DO NOTHING`,
		settlementID, id, txHash, settleInfo.Symbol, paidAmount.String(), amountStr,
		receipt.BlockNumber.Uint64(), matchedLogIndex, payerAddress,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	if tag.RowsAffected() == 0 {
		writeJSON(w, http.StatusOK, confirmResponse{Status: "settled", TxHash: txHash})
		return
	}

	_, _ = h.Pool.Exec(ctx, `UPDATE settlement_intents SET status = 'settled', updated_at = now() WHERE id = $1`, id)
	_, _ = h.Pool.Exec(ctx,
		links.SettleByIntentSQL,
		id)

	balanceTxID := models.NewID("btx")
	_, _ = h.Pool.Exec(ctx,
		`INSERT INTO balance_transactions (id, account_id, settlement_id, type, gross, fee, net, currency)
		 VALUES ($1,$2,$3,'settlement',$4,0,$4,$5)`,
		balanceTxID, accountID, settlementID, amountStr, settleInfo.Symbol,
	)

	if h.Webhooks != nil {
		_ = h.Webhooks.Enqueue(ctx, accountID, "settlement.succeeded",
			links.SettledPayload(ctx, h.Pool, id, txHash))
	}

	writeJSON(w, http.StatusOK, confirmResponse{Status: "settled", TxHash: txHash})
}

func (h *SettlementIntents) toResponse(id, amount, status, settleCurrency, settleAddress string,
	acceptCurrencies []string, reference string, metadata map[string]any, expiresAt, created time.Time, sourceChain string) intentResponse {
	return intentResponse{
		ID: id, Status: status, Amount: amount, SettleCurrency: settleCurrency, SettleAddress: settleAddress,
		AcceptCurrencies: acceptCurrencies, Reference: reference, Metadata: metadata,
		ExpiresAt: expiresAt, Created: created,
		HostedURL:   h.AppBaseURL + "/pay/" + id,
		QRPayload:   id,
		SourceChain: sourceChain,
	}
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// resolveIntentAccount returns the account that owns an intent.
//
// Authenticated callers resolve to their OWN account, so the callers' queries
// (which all carry `AND account_id = $2`) still refuse to touch another
// account's intent -- ownership enforcement is unchanged.
//
// Unauthenticated payer calls resolve to the intent's own account. The intent
// ID is the capability, exactly as it already is for
// POST /payment_links/{id}/pay, GET /settlement_intents/{id}/public and the
// bridge routes: a payer opening a link or QR has no API key, and every path
// beyond this still requires the payer's own wallet signature before any
// funds move.
func (h *SettlementIntents) resolveIntentAccount(ctx context.Context, intentID string) (string, error) {
	if p, ok := auth.FromContext(ctx); ok && p.AccountID != "" {
		return p.AccountID, nil
	}
	var accountID string
	err := h.Pool.QueryRow(ctx,
		`SELECT account_id FROM settlement_intents WHERE id = $1`, intentID,
	).Scan(&accountID)
	return accountID, err
}
