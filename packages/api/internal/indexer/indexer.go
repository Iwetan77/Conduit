// Package indexer watches ConduitRouter's PaymentSettled event on Arc testnet
// and turns it into settlements + balance_transactions rows.
//
// Scope note: this only matters for the same-currency (execute()) path, which
// actually calls ConduitRouter and emits PaymentSettled. StableFX-routed settlements never call our router at all
// (see internal/fx/stablefx.go's Submit doc comment — Circle's relayer calls
// FxEscrow directly) and are already marked settled synchronously by the
// POST /:id/confirm handler once Submit's polling confirms completion. This
// indexer is not involved in that path and won't see those transactions.
package indexer

import (
	"context"
	"fmt"
	"log"
	"math/big"
	"os"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kzn-labs/conduit/api/internal/links"
	"github.com/kzn-labs/conduit/api/internal/currency"
	"github.com/kzn-labs/conduit/api/internal/models"
	"github.com/kzn-labs/conduit/api/internal/onchain"
	"github.com/kzn-labs/conduit/api/internal/webhooks"
)

// PaymentSettled(bytes32 indexed receiptId, address indexed payer, address indexed recipient,
//
//	address payerToken, address recipientToken, uint256 payerAmount,
//	uint256 recipientAmount, bytes32 declarationId, uint256 settledAt)
const paymentSettledABI = `[{"anonymous":false,"inputs":[
  {"indexed":true,"name":"receiptId","type":"bytes32"},
  {"indexed":true,"name":"payer","type":"address"},
  {"indexed":true,"name":"recipient","type":"address"},
  {"indexed":false,"name":"payerToken","type":"address"},
  {"indexed":false,"name":"recipientToken","type":"address"},
  {"indexed":false,"name":"payerAmount","type":"uint256"},
  {"indexed":false,"name":"recipientAmount","type":"uint256"},
  {"indexed":false,"name":"declarationId","type":"bytes32"},
  {"indexed":false,"name":"settledAt","type":"uint256"}
],"name":"PaymentSettled","type":"event"}]`

type Indexer struct {
	pool          *pgxpool.Pool
	client        *ethclient.Client
	routerAddress common.Address
	eventABI      abi.ABI
	eventSig      common.Hash

	// ReconcileWindow is how many trailing blocks the 15s poller re-scans, as
	// insurance against a dropped WS subscription silently missing events.
	ReconcileWindow uint64

	// Webhooks, when set, emits settlement.succeeded for settlements this
	// indexer discovers on-chain. Optional so the indexer still runs headless
	// in tests, but in production it must be wired: without it a same-currency
	// router payment updates the database and tells the merchant nothing, while
	// the identical payment through the confirm/record handlers notifies them.
	// Two paths to the same event should not disagree about whether it happened.
	Webhooks *webhooks.Dispatcher
}

func New(pool *pgxpool.Pool, client *ethclient.Client, routerAddress common.Address) (*Indexer, error) {
	parsed, err := abi.JSON(strings.NewReader(paymentSettledABI))
	if err != nil {
		return nil, fmt.Errorf("indexer: parse ABI: %w", err)
	}
	event, ok := parsed.Events["PaymentSettled"]
	if !ok {
		return nil, fmt.Errorf("indexer: PaymentSettled not found in ABI")
	}
	return &Indexer{
		pool:            pool,
		client:          client,
		routerAddress:   routerAddress,
		eventABI:        parsed,
		eventSig:        event.ID,
		ReconcileWindow: 200,
	}, nil
}

type paymentSettledEvent struct {
	PayerToken      common.Address
	RecipientToken  common.Address
	PayerAmount     *big.Int
	RecipientAmount *big.Int
	DeclarationId   [32]byte
	SettledAt       *big.Int
}

// Run blocks, alternating between a live WS subscription and a 15s polling
// reconciler over the trailing ReconcileWindow blocks (insurance against a
// dropped subscription silently losing events — spec's explicit requirement).
func (ix *Indexer) Run(ctx context.Context) error {
	if err := ix.backfill(ctx); err != nil {
		log.Printf("indexer: backfill error: %v", err)
	}

	sub, logs, err := ix.subscribe(ctx)
	if err != nil {
		log.Printf("indexer: WS subscribe failed (%v), falling back to polling only", err)
	}

	// A BACKSTOP, not the live path.
	//
	// Settlements arrive over the WebSocket subscription above; this reconcile
	// exists to catch what the subscription missed while it was down. At 15
	// seconds it queried Postgres 5,760 times a day to find nothing, which on a
	// serverless database is enough on its own to stop the compute ever scaling
	// to zero -- and the compute bills for time awake, not for queries.
	//
	// Fifteen minutes is still far tighter than the failure it covers, and it
	// clears the database's ~5 minute scale-to-zero window -- an interval SHORTER
	// than that window keeps the compute awake permanently, which is the entire
	// cost being addressed. When the subscription is healthy this finds nothing
	// either way; when it is not, some lag on History is not what anyone
	// notices first.
	ticker := time.NewTicker(indexerReconcileInterval())
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case vLog := <-logs:
			if err := ix.processLog(ctx, vLog); err != nil {
				log.Printf("indexer: process log %s: %v", vLog.TxHash, err)
			}
		case err := <-subErrCh(sub):
			log.Printf("indexer: WS subscription error: %v — will keep relying on polling", err)
		case <-ticker.C:
			if err := ix.reconcile(ctx); err != nil {
				log.Printf("indexer: reconcile error: %v", err)
			}
		}
	}
}

// Overridable without a rebuild, for tightening while chasing a missed event.
func indexerReconcileInterval() time.Duration {
	if raw := strings.TrimSpace(os.Getenv("CONDUIT_INDEXER_RECONCILE_INTERVAL")); raw != "" {
		if d, err := time.ParseDuration(raw); err == nil && d > 0 {
			return d
		}
	}
	return 15 * time.Minute
}

func subErrCh(sub ethereum.Subscription) <-chan error {
	if sub == nil {
		return make(chan error) // never fires
	}
	return sub.Err()
}

func (ix *Indexer) subscribe(ctx context.Context) (ethereum.Subscription, chan types.Log, error) {
	logs := make(chan types.Log, 16)
	query := ethereum.FilterQuery{
		Addresses: []common.Address{ix.routerAddress},
		Topics:    [][]common.Hash{{ix.eventSig}},
	}
	sub, err := ix.client.SubscribeFilterLogs(ctx, query, logs)
	if err != nil {
		return nil, logs, err
	}
	return sub, logs, nil
}

// backfill catches up from indexer_checkpoint.last_processed_block on startup.
func (ix *Indexer) backfill(ctx context.Context) error {
	var lastBlock uint64
	if err := ix.pool.QueryRow(ctx, `SELECT last_processed_block FROM indexer_checkpoint WHERE id = 1`).Scan(&lastBlock); err != nil {
		return fmt.Errorf("read checkpoint: %w", err)
	}
	head, err := ix.client.BlockNumber(ctx)
	if err != nil {
		return fmt.Errorf("get block number: %w", err)
	}
	if lastBlock == 0 {
		lastBlock = head // first ever boot: don't replay all history, start from tip
	}
	return ix.scanRange(ctx, lastBlock, head)
}

// reconcile re-scans the trailing ReconcileWindow blocks — a dropped WS
// subscription can silently miss events; this catches them within 15s.
func (ix *Indexer) reconcile(ctx context.Context) error {
	head, err := ix.client.BlockNumber(ctx)
	if err != nil {
		return err
	}
	from := uint64(0)
	if head > ix.ReconcileWindow {
		from = head - ix.ReconcileWindow
	}
	return ix.scanRange(ctx, from, head)
}

func (ix *Indexer) scanRange(ctx context.Context, from, to uint64) error {
	query := ethereum.FilterQuery{
		FromBlock: new(big.Int).SetUint64(from),
		ToBlock:   new(big.Int).SetUint64(to),
		Addresses: []common.Address{ix.routerAddress},
		Topics:    [][]common.Hash{{ix.eventSig}},
	}
	logsFound, err := ix.client.FilterLogs(ctx, query)
	if err != nil {
		return fmt.Errorf("filter logs [%d,%d]: %w", from, to, err)
	}
	for _, l := range logsFound {
		if err := ix.processLog(ctx, l); err != nil {
			log.Printf("indexer: process log %s: %v", l.TxHash, err)
		}
	}
	_, err = ix.pool.Exec(ctx, `UPDATE indexer_checkpoint SET last_processed_block = $1 WHERE id = 1 AND last_processed_block < $1`, to)
	return err
}

func (ix *Indexer) processLog(ctx context.Context, vLog types.Log) error {
	// Topics[0] = event signature hash, [1] = receiptId, [2] = payer, [3] = recipient
	if len(vLog.Topics) < 4 {
		return fmt.Errorf("unexpected topic count %d", len(vLog.Topics))
	}
	receiptID := vLog.Topics[1].Hex()
	// Topics[2] is the indexed `payer`, and it is NOT recorded from here.
	//
	// It is a field of the caller-supplied instruction struct, so it says who
	// the caller SAID paid. The payer written to the settlements row comes from
	// the corroborating transfer instead -- see onchain.Proof.Payer, which also
	// explains why it is not simply that transfer's sender.

	var ev paymentSettledEvent
	if err := ix.eventABI.UnpackIntoInterface(&ev, "PaymentSettled", vLog.Data); err != nil {
		return fmt.Errorf("unpack: %w", err)
	}
	declarationID := common.BytesToHash(ev.DeclarationId[:]).Hex()

	// An event is corroboration. A token transfer is proof.
	//
	// This is the whole of Phase A2. Everything above comes out of a struct the
	// CALLER supplied -- recipient, amounts and declarationId are all fields of
	// calldata -- and the router had an external entry point that emitted
	// PaymentSettled without moving the money it described. Believing the log
	// meant a merchant's checkout could say "payment received" over a
	// transaction that moved dust, and the merchant would ship goods.
	//
	// So: fetch the receipt, and require an ERC-20 Transfer of the intent's
	// settle token, to the merchant's settle address, for exactly the settled
	// amount, inside this same transaction. No corroborating transfer, no
	// settlement row -- the log is logged and dropped.
	//
	// Deliberately not configurable. A flag here is a flag somebody turns off
	// during an incident, which is the one moment it has to hold.
	var intentID, settleCurrency, settleAddress, intentAmount string
	if err := ix.pool.QueryRow(ctx,
		`SELECT id, settle_currency, settle_address, amount::text
		   FROM settlement_intents WHERE declaration_id = $1`,
		declarationID,
	).Scan(&intentID, &settleCurrency, &settleAddress, &intentAmount); err != nil {
		// No intent for this declaration: a direct send, which this indexer
		// has never recorded. Not an error, and nothing to verify.
		return nil
	}

	info, ok := currency.ByISO(settleCurrency)
	if !ok {
		log.Printf("indexer: intent %s has unknown settle currency %q -- dropped", intentID, settleCurrency)
		return nil
	}
	settled, ok := new(big.Int).SetString(intentAmount, 10)
	if !ok {
		log.Printf("indexer: intent %s has unreadable amount %q -- dropped", intentID, intentAmount)
		return nil
	}

	receipt, err := ix.client.TransactionReceipt(ctx, vLog.TxHash)
	if err != nil {
		// Cannot verify yet. Returning the error leaves this log unprocessed so
		// the 15s reconciler sees it again -- the right outcome for a transient
		// RPC failure, and harmless for a permanent one since nothing was
		// written.
		return fmt.Errorf("receipt %s: %w", vLog.TxHash.Hex(), err)
	}

	proof := onchain.FindSettlementTransfer(
		receipt,
		common.HexToAddress(info.Token),
		common.HexToAddress(settleAddress),
		settled,
	)
	if proof == nil {
		// Logged loudly: on a live deployment this line means somebody emitted
		// a settlement event that moved no money.
		log.Printf(
			"indexer: PaymentSettled in %s claims %s to %s for intent %s, but the tx contains no matching transfer -- DROPPED",
			vLog.TxHash.Hex(), intentAmount, settleAddress, intentID,
		)
		return nil
	}

	// Dedupe on (tx_hash, log_index) via the unique constraint -- an
	// ON CONFLICT DO NOTHING makes this call idempotent under both the live
	// subscription and the reconciler re-scanning the same block twice.
	//
	// Keyed on the TRANSFER's log index rather than the event's, so this and
	// RecordDirectSettlement land on the same row for the same payment and
	// whichever arrives second inserts nothing. Two rows for one settlement
	// would double the merchant's balance and fire the webhook twice.
	settlementID := models.NewID("stl")
	tag, err := ix.pool.Exec(ctx,
		`INSERT INTO settlements (id, intent_id, tx_hash, receipt_id, pay_currency, pay_amount, settle_amount, block_number, log_index, settled_at, payer_address)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), NULLIF($10,''))
		 ON CONFLICT (tx_hash, log_index) DO NOTHING`,
		settlementID, intentID, vLog.TxHash.Hex(), receiptID, settleCurrency,
		ev.PayerAmount.String(), proof.Amount.String(),
		vLog.BlockNumber, proof.LogIndex, proof.Payer,
	)
	if err != nil {
		return fmt.Errorf("insert settlement: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return nil // already processed, or no matching intent (direct send with no declaration)
	}

	_, err = ix.pool.Exec(ctx,
		`UPDATE settlement_intents SET status = 'settled', updated_at = now() WHERE declaration_id = $1`,
		declarationID,
	)
	if err != nil {
		return err
	}

	// A payment link backing this intent closes only here, on a real on-chain
	// settlement — never at checkout start (see payment_links.go Pay()) — and
	// only if it was single-use. See internal/links for why.
	if _, err = ix.pool.Exec(ctx, links.SettleByDeclarationSQL, declarationID); err != nil {
		return err
	}

	ix.emitSettled(ctx, declarationID, vLog.TxHash.Hex())
	return nil
}

// emitSettled notifies the merchant that this settlement landed.
//
// Reached only after the settlements INSERT actually affected a row, so the
// dedupe on (tx_hash, log_index) that makes reprocessing safe also makes this
// fire exactly once per settlement — the live subscription and the 15s
// reconciler routinely see the same log twice.
//
// Best-effort by design: a webhook that fails to enqueue must not roll back or
// retry the on-chain bookkeeping above, which is already durable.
func (ix *Indexer) emitSettled(ctx context.Context, declarationID, txHash string) {
	if ix.Webhooks == nil {
		return
	}
	var accountID, intentID string
	if err := ix.pool.QueryRow(ctx,
		`SELECT account_id, id FROM settlement_intents WHERE declaration_id = $1`,
		declarationID,
	).Scan(&accountID, &intentID); err != nil {
		log.Printf("indexer: resolve intent for %s: %v — settlement.succeeded not sent", declarationID, err)
		return
	}
	_ = ix.Webhooks.Enqueue(ctx, accountID, "settlement.succeeded",
		links.SettledPayloadByDeclaration(ctx, ix.pool, declarationID, intentID, txHash))
}
