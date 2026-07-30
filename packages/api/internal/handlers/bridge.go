package handlers

import (
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	solanago "github.com/gagliardetto/solana-go"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	bridgepkg "github.com/kzn-labs/conduit/api/internal/bridge"
	"github.com/kzn-labs/conduit/api/internal/currency"
	apierrors "github.com/kzn-labs/conduit/api/internal/errors"
	"github.com/kzn-labs/conduit/api/internal/fx"
	"github.com/kzn-labs/conduit/api/internal/models"
	"github.com/kzn-labs/conduit/api/internal/webhooks"
)

// Bridge implements the two payer-facing CCTP endpoints. Deliberately
// unauthenticated (no auth.Middleware) -- this is the payer surface, and a
// cross-chain payer has no Conduit API key or Arc wallet, only a Solana one.
// See internal/bridge/README.md for the state machine and orphan-recovery
// model this drives.
type Bridge struct {
	Pool        *pgxpool.Pool
	Provider    bridgepkg.BridgeProvider
	StableFX    *fx.StableFXProvider
	Webhooks    *webhooks.Dispatcher
	RelayerKey  *ecdsa.PrivateKey
	RelayerAddr common.Address
	// StaleAfter is how long a bridge_transfers row can sit without forward
	// progress before ReconcileOrphanedBridges treats it as orphaned. Real
	// observed attestation latency is 14-22s (Phases 0/2); production should
	// use a value like 45s. Configurable (not a hardcoded package constant)
	// so scripts/e2e-crosschain.sh can prove orphan recovery in seconds
	// instead of waiting on a production-sized window.
	StaleAfter time.Duration
}

type bridgeInitiateRequest struct {
	// Step 1: payer requests the unsigned burn.
	PayerAddress string `json:"payer_address,omitempty"`
	USDCAmount   string `json:"usdc_amount,omitempty"`
	// Step 2: payer reports back the signed+submitted burn.
	TransferID   string `json:"transfer_id,omitempty"`
	SourceTxHash string `json:"source_tx_hash,omitempty"`
}

type bridgeInitiateResponse struct {
	TransferID       string `json:"transfer_id"`
	State            string `json:"state"`
	UnsignedTxBase64 string `json:"unsigned_tx_base64,omitempty"`
}

// Initiate is POST /v1/settlement_intents/:id/bridge/initiate. It does
// double duty across the two-signature-free steps of a bridge -- called once
// with {payer_address, usdc_amount} to get the unsigned burn, and once more
// with {transfer_id, source_tx_hash} after the payer has signed and
// submitted it on Solana. This keeps the route count matching the spec (two
// new endpoints) without inventing a third.
func (h *Bridge) Initiate(w http.ResponseWriter, r *http.Request) {
	intentID := pathParam(r, "id")
	ctx := r.Context()

	var req bridgeInitiateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "body"))
		return
	}

	if req.TransferID != "" {
		h.reportBurn(w, r.Context(), intentID, req)
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
	payerPubkey, err := solanago.PublicKeyFromBase58(req.PayerAddress)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "payer_address"))
		return
	}

	burnReq, err := h.Provider.InitiateBurn(ctx, payerPubkey, amount, h.RelayerAddr)
	if err != nil {
		log.Printf("bridge: InitiateBurn failed: %v", err)
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	transferID := models.NewID("brg")
	_, err = h.Pool.Exec(ctx,
		`INSERT INTO bridge_transfers (id, intent_id, source_domain, dest_domain, burn_amount, state)
		 VALUES ($1,$2,$3,$4,$5,'initiated')`,
		transferID, intentID, h.Provider.SourceDomain(), bridgepkg.ArcDomain, amount.String(),
	)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	h.emitWebhook(ctx, intentID, "bridge.initiated", map[string]any{
		"intent_id": intentID, "transfer_id": transferID, "usdc_amount": amount.String(),
	})

	writeJSON(w, http.StatusCreated, bridgeInitiateResponse{
		TransferID: transferID, State: string(bridgepkg.StateInitiated), UnsignedTxBase64: burnReq.UnsignedTxBase64,
	})
}

// reportBurn is Initiate's second call: the payer has signed+submitted the
// burn and reports its signature. This kicks off attestation polling and the
// mint in the background so the HTTP response doesn't block for ~8-30s --
// the client polls GET .../bridge/status instead. If the process dies before
// this background work finishes, the row is left in attestation_pending or
// attested, exactly where the orphan reconciler picks it up -- see
// internal/bridge/reconciler.go.
func (h *Bridge) reportBurn(w http.ResponseWriter, ctx context.Context, intentID string, req bridgeInitiateRequest) {
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

	if _, err := h.Pool.Exec(ctx,
		`UPDATE bridge_transfers SET state = 'burn_submitted', source_tx_hash = $1, updated_at = now() WHERE id = $2`,
		req.SourceTxHash, req.TransferID,
	); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	// Fire the rest of the pipeline in the background using a fresh context --
	// r.Context() dies with the HTTP response, but this work must survive it.
	go h.runBridgeToSettlement(context.Background(), intentID, req.TransferID, req.SourceTxHash)

	writeJSON(w, http.StatusOK, bridgeInitiateResponse{TransferID: req.TransferID, State: string(bridgepkg.StateBurnSubmitted)})
}

// runBridgeToSettlement drives a bridge_transfers row from burn_submitted
// through minted, then hands off to settlement. Safe to call again for the
// same row from the reconciler -- every step checks the row's current state
// before advancing it, so a row that's already past a given step is skipped
// forward to wherever it actually is.
func (h *Bridge) runBridgeToSettlement(ctx context.Context, intentID, transferID, sourceTxHash string) {
	// burn_submitted -> burn_confirmed -> attestation_pending
	h.setState(ctx, transferID, bridgepkg.StateBurnConfirmed)
	h.setState(ctx, transferID, bridgepkg.StateAttestationPending)

	attestation, err := h.Provider.PollAttestation(ctx, sourceTxHash)
	if err != nil {
		log.Printf("bridge: PollAttestation failed for transfer %s: %v", transferID, err)
		h.setState(ctx, transferID, bridgepkg.StateFailed)
		h.emitWebhook(ctx, intentID, "bridge.failed", map[string]any{"intent_id": intentID, "transfer_id": transferID, "reason": err.Error()})
		return
	}

	if _, err := h.Pool.Exec(ctx,
		`UPDATE bridge_transfers SET state = 'attested', attestation = $1, message_hex = $2, attestation_status = $3, updated_at = now() WHERE id = $4 AND state = 'attestation_pending'`,
		fmt.Sprintf("0x%x", attestation.AttestationBytes), fmt.Sprintf("0x%x", attestation.Message), attestation.Status, transferID,
	); err != nil {
		log.Printf("bridge: persist attestation failed for transfer %s: %v", transferID, err)
		return
	}
	h.emitWebhook(ctx, intentID, "bridge.attested", map[string]any{"intent_id": intentID, "transfer_id": transferID})

	h.completeMintAndSettle(ctx, intentID, transferID, attestation)
}

// completeMintAndSettle is the shared tail end of the pipeline, called both
// from a live session (runBridgeToSettlement) and the orphan reconciler --
// this is the exact function that makes orphan recovery real rather than
// aspirational. Idempotent: re-reads the row's state before each write.
func (h *Bridge) completeMintAndSettle(ctx context.Context, intentID, transferID string, attestation bridgepkg.Attestation) {
	var state string
	if err := h.Pool.QueryRow(ctx, `SELECT state FROM bridge_transfers WHERE id = $1`, transferID).Scan(&state); err != nil {
		log.Printf("bridge: read state for transfer %s: %v", transferID, err)
		return
	}
	if state == string(bridgepkg.StateMinted) || state == string(bridgepkg.StateHandoffToSettlement) {
		return // already done, e.g. a race between a live session and the reconciler
	}

	h.setState(ctx, transferID, bridgepkg.StateMintSubmitted)

	mintTxHash, minted, err := h.Provider.Mint(ctx, attestation)
	if err != nil {
		if strings.Contains(err.Error(), "Nonce already used") {
			// Someone else (a concurrent live session or a prior reconciler
			// pass) already minted this. Not a failure -- catch up state.
			log.Printf("bridge: transfer %s already minted elsewhere, catching up state", transferID)
			h.setState(ctx, transferID, bridgepkg.StateMinted)
		} else {
			log.Printf("bridge: Mint failed for transfer %s: %v", transferID, err)
			h.setState(ctx, transferID, bridgepkg.StateFailed)
			h.emitWebhook(ctx, intentID, "bridge.failed", map[string]any{"intent_id": intentID, "transfer_id": transferID, "reason": err.Error()})
			return
		}
	} else {
		if _, err := h.Pool.Exec(ctx,
			`UPDATE bridge_transfers SET state = 'minted', mint_tx_hash = $1, minted_amount = $2, updated_at = now() WHERE id = $3 AND state = 'mint_submitted'`,
			mintTxHash, minted.String(), transferID,
		); err != nil {
			log.Printf("bridge: persist mint for transfer %s: %v", transferID, err)
			return
		}
	}

	h.emitWebhook(ctx, intentID, "bridge.minted", map[string]any{"intent_id": intentID, "transfer_id": transferID, "mint_tx_hash": mintTxHash})

	// Quote-after-mint ordering (spec §1.1): only now, with the USDC actually
	// sitting on Arc, do we ask StableFX for a rate -- never before, since the
	// bridge's ~8-30s would blow past the ~3.5s quote TTL.
	if err := h.settleBridgedIntent(ctx, intentID); err != nil {
		log.Printf("bridge: settlement handoff failed for intent %s: %v", intentID, err)
		return
	}
	h.setState(ctx, transferID, bridgepkg.StateHandoffToSettlement)
}

// settleBridgedIntent runs the intent's existing Quote -> Prepare -> Confirm
// path, but with Conduit's own Arc relayer key producing both payer
// signatures instead of a human wallet. See eip712_sign.go's doc comment for
// why this is safe: the burn was the payer's one and only, final signature.
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

	// The observed StableFX quote TTL is ~3.5s (docs/fx-capability.md) --
	// tight enough that even two sequential network round trips (Quote, then
	// Prepare) can outrun it under real network latency, not just under an
	// artificially slow client. Hit this for real running GATE 3: the first
	// attempt's Prepare call came back "3004: Quote expired" even though
	// nothing between Quote and Prepare does meaningful work besides signing.
	// A human payer whose action landed just past expiry would just get
	// re-quoted by the UI; do the same thing here rather than failing outright
	// on a single unlucky round trip.
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
			// Direct same-token settlement has no relayer signing step in this
			// codebase's existing Provider interface (AMM/direct's Prepare is a
			// no-op reshape, Submit still expects a signature this codebase never
			// constructs on-chain itself for the direct path) -- out of scope for
			// this phase's proof; bridged intents in GATE 3 settle into a
			// non-USDC currency specifically so this path isn't exercised.
			return fmt.Errorf("bridged settlement into %s (provider=%s) not implemented -- only stablefx-routed bridged settlement is supported", settleInfo.Symbol, q.Provider)
		}

		var quoteSig string
		quoteSig, err = signTypedDataAsRelayer(h.RelayerKey, q.RawTypedData)
		if err != nil {
			return fmt.Errorf("sign quote message: %w", err)
		}
		// PrepareWithSignature's quoteMessage param is StableFX's own
		// /trades body field, which wants only the EIP-712 "message" object,
		// not the full {domain,types,primaryType,message} envelope used for
		// signing/hashing -- confirmed against scripts/e2e.sh's existing
		// working flow, which extracts .message the same way before sending.
		// Sending the full envelope here is what produced a real "3022:
		// Permit2 data is malformed" error running GATE 3.
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
// progress UI (Phase 4) polls this. Unauthenticated like Initiate.
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

// arcAddressFromKey is a small helper cmd/api uses to derive the relayer's
// own address from its configured private key.
func arcAddressFromKey(key *ecdsa.PrivateKey) common.Address {
	return crypto.PubkeyToAddress(key.PublicKey)
}
