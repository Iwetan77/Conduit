package handlers

import (
	"context"
	"crypto/ecdsa"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	bridgepkg "github.com/kzn-labs/conduit/api/internal/bridge"
	"github.com/kzn-labs/conduit/api/internal/currency"
	apierrors "github.com/kzn-labs/conduit/api/internal/errors"
	"github.com/kzn-labs/conduit/api/internal/fx"
	"github.com/kzn-labs/conduit/api/internal/models"
	"github.com/kzn-labs/conduit/api/internal/webhooks"
)

// Bridge implements the two payer-facing funding endpoints. Deliberately
// unauthenticated (no auth.Middleware) -- this is the payer surface, and a
// cross-chain payer has no Conduit API key. Backed by Circle Gateway
// (internal/bridge.FundingProvider) -- chain-agnostic at this layer, never
// Solana-typed. See internal/bridge/README.md for the state machine and
// orphan-recovery model this drives, and docs/ubk-capability.md for the
// deposit-then-spend mechanism underneath.
type Bridge struct {
	Pool        *pgxpool.Pool
	Provider    bridgepkg.FundingProvider
	StableFX    *fx.StableFXProvider
	Webhooks    *webhooks.Dispatcher
	RelayerKey  *ecdsa.PrivateKey
	RelayerAddr common.Address
	// StaleAfter is how long a bridge_transfers row can sit without forward
	// progress before ReconcileOrphanedBridges treats it as orphaned.
	StaleAfter time.Duration
}

type bridgeInitiateRequest struct {
	// Step 1: payer requests the funding artifacts.
	PayerAddress string `json:"payer_address,omitempty"`
	USDCAmount   string `json:"usdc_amount,omitempty"`
	// Step 2: payer reports back their signature(s).
	TransferID          string `json:"transfer_id,omitempty"`
	DepositTxHash       string `json:"deposit_tx_hash,omitempty"`
	BurnIntentSignature string `json:"burn_intent_signature,omitempty"` // hex, 0x-prefixed
}

type bridgeInitiateResponse struct {
	TransferID        string `json:"transfer_id"`
	State             string `json:"state"`
	NeedsDeposit      bool   `json:"needs_deposit,omitempty"`
	DepositTxBase64   string `json:"deposit_tx_base64,omitempty"`
	BurnIntentMessage string `json:"burn_intent_message,omitempty"` // hex, for the payer to sign
}

// Initiate is POST /v1/settlement_intents/:id/bridge/initiate. Two calls:
// {payer_address, usdc_amount} returns what to sign (a deposit transaction,
// if the payer's Gateway balance is insufficient, plus always a burn-intent
// message); {transfer_id, burn_intent_signature, deposit_tx_hash?} submits
// the signed intent and kicks off the funding pipeline.
func (h *Bridge) Initiate(w http.ResponseWriter, r *http.Request) {
	intentID := pathParam(r, "id")
	ctx := r.Context()

	var req bridgeInitiateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "body"))
		return
	}

	if req.TransferID != "" {
		h.reportSignature(w, r.Context(), intentID, req)
		return
	}

	if req.PayerAddress == "" || req.USDCAmount == "" {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "payer_address, usdc_amount"))
		return
	}

	var sourceChain, status string
	if err := h.Pool.QueryRow(ctx, `SELECT source_chain, status FROM settlement_intents WHERE id = $1`, intentID).Scan(&sourceChain, &status); err != nil {
		if err == pgx.ErrNoRows {
			writeErr(w, apierrors.E(apierrors.CodeNotFound, "id"))
			return
		}
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	if sourceChain == "arc" {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "intent has no cross-chain source_chain set"))
		return
	}
	if status == "settled" {
		writeErr(w, apierrors.E(apierrors.CodeIntentAlreadySettled, "id"))
		return
	}

	amount, ok := new(big.Int).SetString(req.USDCAmount, 10)
	if !ok || amount.Sign() <= 0 {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "usdc_amount"))
		return
	}

	fundReq, err := h.Provider.PrepareFund(ctx, bridgepkg.Address(req.PayerAddress), amount, bridgepkg.Address(h.RelayerAddr.Hex()))
	if err != nil {
		log.Printf("bridge: PrepareFund failed: %v", err)
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	transferID := models.NewID("brg")
	burnIntentHex := "0x" + hex.EncodeToString(fundReq.BurnIntentMessage)
	_, err = h.Pool.Exec(ctx,
		`INSERT INTO bridge_transfers (id, intent_id, source_domain, dest_domain, burn_amount, message_hex, state)
		 VALUES ($1,$2,$3,$4,$5,$6,'initiated')`,
		transferID, intentID, bridgepkg.SolanaDomain, bridgepkg.ArcDomain, amount.String(), burnIntentHex,
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	fundReq.TransferID = transferID
	h.emitWebhook(ctx, intentID, "bridge.initiated", map[string]any{
		"intent_id": intentID, "transfer_id": transferID, "usdc_amount": amount.String(),
	})

	writeJSON(w, http.StatusCreated, bridgeInitiateResponse{
		TransferID:        transferID,
		State:             string(bridgepkg.StateInitiated),
		NeedsDeposit:      fundReq.NeedsDeposit,
		DepositTxBase64:   fundReq.DepositTxBase64,
		BurnIntentMessage: burnIntentHex,
	})
}

// reportSignature is Initiate's second call: the payer has signed the burn
// intent (and, if needed, the deposit transaction) and reports back. This
// submits the signed intent to Gateway and drives the rest of the pipeline
// in the background so the HTTP response doesn't block -- the client polls
// GET .../bridge/status instead. If the process dies before this background
// work finishes, the row is left mid-pipeline, exactly where the orphan
// reconciler picks it up -- see internal/bridge/reconciler.go.
func (h *Bridge) reportSignature(w http.ResponseWriter, ctx context.Context, intentID string, req bridgeInitiateRequest) {
	var currentState string
	err := h.Pool.QueryRow(ctx,
		`SELECT state FROM bridge_transfers WHERE id = $1 AND intent_id = $2`,
		req.TransferID, intentID,
	).Scan(&currentState)
	if err != nil {
		if err == pgx.ErrNoRows {
			writeErr(w, apierrors.E(apierrors.CodeNotFound, "transfer_id"))
			return
		}
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	if err := bridgepkg.Transition(bridgepkg.State(currentState), bridgepkg.StateBurnSubmitted); err != nil {
		// Already reported (e.g. client retried) -- not an error, just return
		// current state.
		writeJSON(w, http.StatusOK, bridgeInitiateResponse{TransferID: req.TransferID, State: currentState})
		return
	}
	if req.BurnIntentSignature == "" {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "burn_intent_signature"))
		return
	}

	if _, err := h.Pool.Exec(ctx,
		`UPDATE bridge_transfers SET state = 'burn_submitted', source_tx_hash = $1, updated_at = now() WHERE id = $2`,
		req.DepositTxHash, req.TransferID,
	); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	sigBytes, err := hex.DecodeString(strings.TrimPrefix(req.BurnIntentSignature, "0x"))
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "burn_intent_signature"))
		return
	}

	// Fire the rest of the pipeline in the background using a fresh context --
	// r.Context() dies with the HTTP response, but this work must survive it.
	go h.runFundingToSettlement(context.Background(), intentID, req.TransferID, sigBytes)

	writeJSON(w, http.StatusOK, bridgeInitiateResponse{TransferID: req.TransferID, State: string(bridgepkg.StateBurnSubmitted)})
}

// runFundingToSettlement drives a bridge_transfers row from burn_submitted
// through minted, then hands off to settlement. Safe to call again for the
// same row from the reconciler -- every step checks the row's current state
// before advancing it.
func (h *Bridge) runFundingToSettlement(ctx context.Context, intentID, transferID string, burnIntentSig []byte) {
	h.setState(ctx, transferID, bridgepkg.StateBurnConfirmed)
	h.setState(ctx, transferID, bridgepkg.StateAttestationPending)

	// Re-derive the FundRequest's burn intent bytes isn't possible here (the
	// message was only ever held client-side between the two calls) --
	// instead we re-run PrepareFund's deterministic encoding is NOT safe
	// (the salt is random per call). So the message bytes must have been
	// persisted at Initiate time. Simplification for this phase: store them
	// on the bridge_transfers row alongside source_tx_hash.
	var burnIntentMsgHex string
	if err := h.Pool.QueryRow(ctx, `SELECT COALESCE(message_hex, '') FROM bridge_transfers WHERE id = $1`, transferID).Scan(&burnIntentMsgHex); err != nil {
		log.Printf("bridge: read burn intent message for transfer %s: %v", transferID, err)
		h.setState(ctx, transferID, bridgepkg.StateFailed)
		return
	}

	gatewayTransferID, err := h.Provider.Fund(ctx, bridgepkg.FundRequest{
		TransferID:          transferID,
		BurnIntentMessage:   mustDecodeHex(burnIntentMsgHex),
		BurnIntentSignature: burnIntentSig,
	})
	if err != nil {
		log.Printf("bridge: Fund failed for transfer %s: %v", transferID, err)
		h.setState(ctx, transferID, bridgepkg.StateFailed)
		h.emitWebhook(ctx, intentID, "bridge.failed", map[string]any{"intent_id": intentID, "transfer_id": transferID, "reason": err.Error()})
		return
	}
	// Persist Gateway's own transfer id (reusing the attestation column --
	// Gateway owns attestation internally, all Conduit needs to remember is
	// the id to poll) so the reconciler can resume polling without the
	// payer present.
	if _, err := h.Pool.Exec(ctx,
		`UPDATE bridge_transfers SET state = 'attested', attestation = $1, updated_at = now() WHERE id = $2 AND state = 'attestation_pending'`,
		gatewayTransferID, transferID,
	); err != nil {
		log.Printf("bridge: persist gateway transfer id for %s: %v", transferID, err)
		return
	}
	h.emitWebhook(ctx, intentID, "bridge.attested", map[string]any{"intent_id": intentID, "transfer_id": transferID, "gateway_transfer_id": gatewayTransferID})

	h.pollAndCompleteFunding(ctx, intentID, transferID, gatewayTransferID)
}

// pollAndCompleteFunding polls FundingProvider.Status until Arc's forwarder
// has minted (or it fails), then hands off to settlement. Called both from
// a live session and the orphan reconciler.
func (h *Bridge) pollAndCompleteFunding(ctx context.Context, intentID, transferID, gatewayTransferID string) {
	var state string
	if err := h.Pool.QueryRow(ctx, `SELECT state FROM bridge_transfers WHERE id = $1`, transferID).Scan(&state); err != nil {
		log.Printf("bridge: read state for transfer %s: %v", transferID, err)
		return
	}
	if state == string(bridgepkg.StateMinted) || state == string(bridgepkg.StateHandoffToSettlement) {
		return // already done, e.g. a race between a live session and the reconciler
	}

	h.setState(ctx, transferID, bridgepkg.StateMintSubmitted)

	deadline := time.Now().Add(90 * time.Second)
	var status bridgepkg.FundingStatus
	for time.Now().Before(deadline) {
		var err error
		status, err = h.Provider.Status(ctx, gatewayTransferID)
		if err != nil {
			log.Printf("bridge: Status poll failed for transfer %s: %v", transferID, err)
			time.Sleep(5 * time.Second)
			continue
		}
		if status.State == bridgepkg.StateMinted || status.State == bridgepkg.StateFailed {
			break
		}
		time.Sleep(5 * time.Second)
	}

	if status.State != bridgepkg.StateMinted {
		log.Printf("bridge: funding did not complete for transfer %s: %s", transferID, status.FailureReason)
		h.setState(ctx, transferID, bridgepkg.StateFailed)
		h.emitWebhook(ctx, intentID, "bridge.failed", map[string]any{"intent_id": intentID, "transfer_id": transferID, "reason": status.FailureReason})
		return
	}

	if _, err := h.Pool.Exec(ctx,
		`UPDATE bridge_transfers SET state = 'minted', mint_tx_hash = $1, updated_at = now() WHERE id = $2 AND state = 'mint_submitted'`,
		status.MintTxHash, transferID,
	); err != nil {
		log.Printf("bridge: persist mint for transfer %s: %v", transferID, err)
		return
	}
	h.emitWebhook(ctx, intentID, "bridge.minted", map[string]any{"intent_id": intentID, "transfer_id": transferID, "mint_tx_hash": status.MintTxHash})

	// Quote-after-mint ordering: only now, with the USDC actually sitting on
	// Arc, do we ask StableFX for a rate.
	if err := h.settleBridgedIntent(ctx, intentID); err != nil {
		log.Printf("bridge: settlement handoff failed for intent %s: %v", intentID, err)
		return
	}
	h.setState(ctx, transferID, bridgepkg.StateHandoffToSettlement)
}

// settleBridgedIntent runs the intent's existing Quote -> Prepare -> Confirm
// path, but with Conduit's own Arc relayer key producing both payer
// signatures instead of a human wallet. See eip712_sign.go's doc comment for
// why this is safe: the funding intent was the payer's one and only, final
// signature.
func (h *Bridge) settleBridgedIntent(ctx context.Context, intentID string) error {
	var amountStr, settleCurrencyISO, settleAddress string
	if err := h.Pool.QueryRow(ctx,
		`SELECT amount::text, settle_currency, settle_address FROM settlement_intents WHERE id = $1`, intentID,
	).Scan(&amountStr, &settleCurrencyISO, &settleAddress); err != nil {
		return fmt.Errorf("read intent: %w", err)
	}
	settleInfo, ok := currency.ByISO(settleCurrencyISO)
	if !ok {
		return fmt.Errorf("unsupported settle currency %s", settleCurrencyISO)
	}
	amount, _ := new(big.Int).SetString(amountStr, 10)
	relayerAddrHex := h.RelayerAddr.Hex()

	var q fx.Quote
	var prep fx.Preparation
	var err error

	const maxQuoteAttempts = 3
	for attempt := 1; attempt <= maxQuoteAttempts; attempt++ {
		if settleInfo.Symbol == "USDC" {
			q, err = fx.DirectProvider{}.Quote(ctx, "USDC", settleInfo.Symbol, amount, settleAddress)
		} else {
			q, err = h.StableFX.Quote(ctx, "USDC", settleInfo.Symbol, amount, settleAddress)
		}
		if err != nil {
			return fmt.Errorf("quote: %w", err)
		}

		if q.Provider != "stablefx" {
			return fmt.Errorf("bridged settlement into %s (provider=%s) not implemented -- only stablefx-routed bridged settlement is supported", settleInfo.Symbol, q.Provider)
		}

		var quoteSig string
		quoteSig, err = signTypedDataAsRelayer(h.RelayerKey, q.RawTypedData)
		if err != nil {
			return fmt.Errorf("sign quote message: %w", err)
		}
		var envelope struct {
			Message json.RawMessage `json:"message"`
		}
		if err := json.Unmarshal(q.RawTypedData, &envelope); err != nil {
			return fmt.Errorf("unmarshal quote typed data envelope: %w", err)
		}
		prep, err = h.StableFX.PrepareWithSignature(ctx, q, relayerAddrHex, envelope.Message, quoteSig)
		if err == nil {
			break
		}
		if !strings.Contains(err.Error(), "Quote expired") || attempt == maxQuoteAttempts {
			return fmt.Errorf("prepare: %w", err)
		}
		log.Printf("bridge: quote expired before prepare for intent %s, retrying with a fresh quote (attempt %d/%d)", intentID, attempt+1, maxQuoteAttempts)
	}

	_, _ = h.Pool.Exec(ctx, `UPDATE settlement_intents SET status = 'quoted', updated_at = now() WHERE id = $1`, intentID)

	fundingSig, err := signTypedDataAsRelayer(h.RelayerKey, prep.FundingTypedData)
	if err != nil {
		return fmt.Errorf("sign funding typed data: %w", err)
	}
	makerTxHash, err := h.StableFX.Submit(ctx, prep, fundingSig)
	if err != nil {
		return fmt.Errorf("submit: %w", err)
	}

	_, _ = h.Pool.Exec(ctx, `UPDATE settlement_intents SET status = 'settled', updated_at = now() WHERE id = $1`, intentID)

	settlementID := models.NewID("stl")
	h.Pool.Exec(ctx,
		`INSERT INTO settlements (id, intent_id, tx_hash, receipt_id, pay_currency, pay_amount, settle_amount, rate_applied, fee, block_number, log_index, settled_at)
		 VALUES ($1,$2,$3,$3,'USDC',$4,$5,NULLIF($6,'')::numeric,0,0,0,now())`,
		settlementID, intentID, makerTxHash, amount.String(), amountStr, q.Rate,
	)

	var accountID string
	h.Pool.QueryRow(ctx, `SELECT account_id FROM settlement_intents WHERE id = $1`, intentID).Scan(&accountID)
	if accountID != "" {
		balTxID := models.NewID("btx")
		h.Pool.Exec(ctx,
			`INSERT INTO balance_transactions (id, account_id, settlement_id, type, gross, fee, net, currency)
			 VALUES ($1,$2,$3,'settlement',$4,0,$4,$5)`,
			balTxID, accountID, settlementID, amountStr, settleInfo.Symbol,
		)
	}

	h.emitWebhook(ctx, intentID, "settlement.succeeded", map[string]any{"intent_id": intentID, "tx_hash": makerTxHash, "status": "settled"})
	return nil
}

func (h *Bridge) setState(ctx context.Context, transferID string, to bridgepkg.State) {
	var from string
	if err := h.Pool.QueryRow(ctx, `SELECT state FROM bridge_transfers WHERE id = $1`, transferID).Scan(&from); err != nil {
		log.Printf("bridge: read state for transfer %s: %v", transferID, err)
		return
	}
	if err := bridgepkg.Transition(bridgepkg.State(from), to); err != nil {
		log.Printf("bridge: refusing illegal transition for transfer %s: %v", transferID, err)
		return
	}
	if _, err := h.Pool.Exec(ctx, `UPDATE bridge_transfers SET state = $1, updated_at = now() WHERE id = $2`, string(to), transferID); err != nil {
		log.Printf("bridge: write state for transfer %s: %v", transferID, err)
	}
}

func (h *Bridge) emitWebhook(ctx context.Context, intentID, eventType string, payload map[string]any) {
	if h.Webhooks == nil {
		return
	}
	var accountID string
	if err := h.Pool.QueryRow(ctx, `SELECT account_id FROM settlement_intents WHERE id = $1`, intentID).Scan(&accountID); err != nil || accountID == "" {
		return
	}
	_ = h.Webhooks.Enqueue(ctx, accountID, eventType, payload)
}

type bridgeStatusResponse struct {
	TransferID   string    `json:"transfer_id"`
	State        string    `json:"state"`
	SourceDomain int       `json:"source_domain"`
	DestDomain   int       `json:"dest_domain"`
	BurnAmount   string    `json:"burn_amount"`
	MintedAmount string    `json:"minted_amount,omitempty"`
	SourceTxHash string    `json:"source_tx_hash,omitempty"`
	MintTxHash   string    `json:"mint_tx_hash,omitempty"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// Status is GET /v1/settlement_intents/:id/bridge/status -- the payer-side
// progress UI polls this. Unauthenticated like Initiate.
func (h *Bridge) Status(w http.ResponseWriter, r *http.Request) {
	intentID := pathParam(r, "id")
	ctx := r.Context()

	var resp bridgeStatusResponse
	var mintedAmount, sourceTxHash, mintTxHash *string
	err := h.Pool.QueryRow(ctx,
		`SELECT id, state, source_domain, dest_domain, burn_amount::text, minted_amount::text, source_tx_hash, mint_tx_hash, updated_at
		 FROM bridge_transfers WHERE intent_id = $1 ORDER BY created_at DESC LIMIT 1`,
		intentID,
	).Scan(&resp.TransferID, &resp.State, &resp.SourceDomain, &resp.DestDomain, &resp.BurnAmount, &mintedAmount, &sourceTxHash, &mintTxHash, &resp.UpdatedAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			writeErr(w, apierrors.E(apierrors.CodeNotFound, "no bridge transfer for this intent"))
			return
		}
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	if mintedAmount != nil {
		resp.MintedAmount = *mintedAmount
	}
	if sourceTxHash != nil {
		resp.SourceTxHash = *sourceTxHash
	}
	if mintTxHash != nil {
		resp.MintTxHash = *mintTxHash
	}

	writeJSON(w, http.StatusOK, resp)
}

type bridgeBalanceResponse struct {
	// TotalAvailable is the payer's already-deposited Gateway balance summed
	// across every domain Gateway tracks for this address -- see
	// docs/ubk-capability.md's deposit-then-spend model. A real REST call
	// to Gateway (POST /v1/balances), not derived/estimated.
	TotalAvailable string            `json:"total_available"`
	ByChain        map[string]string `json:"by_chain"`
}

// Balance is GET /v1/settlement_intents/:id/bridge/balance?payer_address=...
// -- the payer surface's balance-aware pay step (Phase 5.1) calls this
// before showing any amount entry, so the payer only ever sees "paying with
// USDC" as a confirmed fact, never a list of assets they don't hold.
// Unauthenticated like Initiate/Status -- same payer-has-no-API-key
// reasoning.
func (h *Bridge) Balance(w http.ResponseWriter, r *http.Request) {
	payerAddress := r.URL.Query().Get("payer_address")
	if payerAddress == "" {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "payer_address"))
		return
	}

	balance, err := h.Provider.UnifiedBalance(r.Context(), bridgepkg.Address(payerAddress))
	if err != nil {
		log.Printf("bridge: UnifiedBalance failed for %s: %v", payerAddress, err)
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	byChain := map[string]string{}
	if v, ok := balance.ByDomain[bridgepkg.SolanaDomain]; ok {
		byChain["solana"] = v.String()
	}
	if v, ok := balance.ByDomain[bridgepkg.ArcDomain]; ok {
		byChain["arc"] = v.String()
	}
	if v, ok := balance.ByDomain[bridgepkg.SuiTestnetDomain]; ok {
		byChain["sui"] = v.String()
	}

	total := "0"
	if balance.TotalAvailable != nil {
		total = balance.TotalAvailable.String()
	}
	writeJSON(w, http.StatusOK, bridgeBalanceResponse{TotalAvailable: total, ByChain: byChain})
}

// arcAddressFromKey is a small helper cmd/api uses to derive the relayer's
// own address from its configured private key.
func arcAddressFromKey(key *ecdsa.PrivateKey) common.Address {
	return crypto.PubkeyToAddress(key.PublicKey)
}

// ── Client-side UBK spend path (option B) ────────────────────────────────────
//
// When the browser drives Circle's Unified Balance Kit directly, it does the
// deposit + burn-intent signing itself and Circle mints the USDC onto Arc at
// our relayer address. The server no longer encodes or submits anything to
// Gateway for these payers — it only needs (1) to tell the client where to mint
// and how much USDC to spend, and (2) to be told the resulting Gateway transfer
// id so it can poll the mint and run the existing settlement handoff. These two
// endpoints provide exactly that; the tested pollAndCompleteFunding /
// settleBridgedIntent pipeline below is reused unchanged.

type bridgePlanResponse struct {
	RecipientAddress string `json:"recipient_address"` // Conduit's Arc relayer — where the client mints USDC
	RequiredUSDC     string `json:"required_usdc"`     // minor units of USDC the client must spend
	SettleCurrency   string `json:"settle_currency"`
	SettleAmount     string `json:"settle_amount"` // minor units, what the merchant receives
}

// Plan is GET /v1/settlement_intents/:id/bridge/plan. It answers "if I pay this
// with USDC from another chain, where does it go and how much USDC do I need?"
// For a USDC-settled intent the answer is 1:1; for a cross-currency intent it
// prices the settle amount through StableFX and adds a margin so the post-mint
// re-quote can't come up short (Gateway also enforces a min fee on the spend).
func (h *Bridge) Plan(w http.ResponseWriter, r *http.Request) {
	id := pathParam(r, "id")
	ctx := r.Context()

	var settleISO, settleAddress, status string
	var settleAmount string
	if err := h.Pool.QueryRow(ctx,
		`SELECT settle_currency, settle_address, status, amount::text FROM settlement_intents WHERE id = $1`, id,
	).Scan(&settleISO, &settleAddress, &status, &settleAmount); err != nil {
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

	settleInfo, ok := currency.ByISO(settleISO)
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeCurrencyNotSupported, "settle_currency"))
		return
	}

	settleAmt, _ := new(big.Int).SetString(settleAmount, 10)
	var requiredUSDC *big.Int
	if settleInfo.Symbol == "USDC" {
		requiredUSDC = settleAmt
	} else {
		// Price the recipient's target amount in USDC. This is only a pre-quote
		// for sizing the spend — the authoritative conversion still runs
		// post-mint in settleBridgedIntent. Add a 2% margin so a small rate
		// move between the two quotes can't under-fund the settlement.
		q, err := h.StableFX.Quote(ctx, "USDC", settleInfo.Symbol, settleAmt, settleAddress)
		if err != nil || q.FromAmount == nil {
			writeErr(w, apierrors.E(apierrors.CodeFxProviderUnavailable, ""))
			return
		}
		margin := new(big.Int).Div(new(big.Int).Mul(q.FromAmount, big.NewInt(2)), big.NewInt(100))
		requiredUSDC = new(big.Int).Add(q.FromAmount, margin)
	}

	writeJSON(w, http.StatusOK, bridgePlanResponse{
		RecipientAddress: h.RelayerAddr.Hex(),
		RequiredUSDC:     requiredUSDC.String(),
		SettleCurrency:   settleISO,
		SettleAmount:     settleAmount,
	})
}

type reportSpendRequest struct {
	GatewayTransferID string `json:"gateway_transfer_id"`
	SourceChain       string `json:"source_chain"` // "base" | "polygon" | "solana"
	USDCAmount        string `json:"usdc_amount"`  // minor units actually spent
}

func sourceDomainFor(chain string) (uint32, bool) {
	switch chain {
	case "base":
		return bridgepkg.BaseDomain, true
	case "polygon":
		return bridgepkg.PolygonDomain, true
	case "solana":
		return bridgepkg.SolanaDomain, true
	default:
		return 0, false
	}
}

// ReportClientSpend is POST /v1/settlement_intents/:id/bridge/report_spend. The
// client-side UBK spend already committed on Gateway; the browser hands back the
// Gateway transfer id. We mark the intent cross-chain, record a bridge_transfers
// row already at 'attested' (Gateway owns the burn/attestation — nothing for us
// to submit), and kick the existing poll→mint→settle pipeline in the background.
func (h *Bridge) ReportClientSpend(w http.ResponseWriter, r *http.Request) {
	id := pathParam(r, "id")
	ctx := r.Context()

	var req reportSpendRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "body"))
		return
	}
	if req.GatewayTransferID == "" {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "gateway_transfer_id"))
		return
	}
	sourceDomain, ok := sourceDomainFor(req.SourceChain)
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "source_chain"))
		return
	}
	amount, ok := new(big.Int).SetString(req.USDCAmount, 10)
	if !ok || amount.Sign() <= 0 {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "usdc_amount"))
		return
	}

	var status string
	if err := h.Pool.QueryRow(ctx, `SELECT status FROM settlement_intents WHERE id = $1`, id).Scan(&status); err != nil {
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

	// Stamp the intent as cross-chain so the payer surface + status reads agree
	// it's bridging (it was created 'arc' by default; the payer chose otherwise).
	if _, err := h.Pool.Exec(ctx,
		`UPDATE settlement_intents SET source_chain = $1, updated_at = now() WHERE id = $2 AND status <> 'settled'`,
		req.SourceChain, id,
	); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	// Idempotency: one Gateway transfer id ⇒ one bridge_transfers row. A retried
	// report returns the existing row rather than double-settling.
	var transferID string
	err := h.Pool.QueryRow(ctx,
		`SELECT id FROM bridge_transfers WHERE intent_id = $1 AND attestation = $2`, id, req.GatewayTransferID,
	).Scan(&transferID)
	if err == pgx.ErrNoRows {
		transferID = models.NewID("brg")
		if _, err := h.Pool.Exec(ctx,
			`INSERT INTO bridge_transfers (id, intent_id, source_domain, dest_domain, burn_amount, attestation, state)
			 VALUES ($1,$2,$3,$4,$5,$6,'attested')`,
			transferID, id, int(sourceDomain), int(bridgepkg.ArcDomain), amount.String(), req.GatewayTransferID,
		); err != nil {
			writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
			return
		}
	} else if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	// Poll Gateway for the mint, then hand off to the existing StableFX
	// settlement — on a fresh context so it survives this HTTP response.
	go h.pollAndCompleteFunding(context.Background(), id, transferID, req.GatewayTransferID)

	writeJSON(w, http.StatusAccepted, map[string]any{"transfer_id": transferID, "state": string(bridgepkg.StateAttested)})
}
