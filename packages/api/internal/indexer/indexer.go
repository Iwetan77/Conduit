// Package indexer watches ConduitRouter's PaymentSettled event on Arc testnet
// and turns it into settlements + balance_transactions rows.
//
// Scope note: this only matters for the same-currency (execute()) and AMM
// (executeWithAmm()) paths, which actually call ConduitRouter and emit
// PaymentSettled. StableFX-routed settlements never call our router at all
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
	"strings"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kzn-labs/conduit/api/internal/models"
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

	ticker := time.NewTicker(15 * time.Second)
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

	var ev paymentSettledEvent
	if err := ix.eventABI.UnpackIntoInterface(&ev, "PaymentSettled", vLog.Data); err != nil {
		return fmt.Errorf("unpack: %w", err)
	}
	declarationID := common.BytesToHash(ev.DeclarationId[:]).Hex()

	// Dedupe on (tx_hash, log_index) via the unique constraint — an
	// ON CONFLICT DO NOTHING makes this call idempotent under both the live
	// subscription and the reconciler re-scanning the same block twice.
	settlementID := models.NewID("stl")
	tag, err := ix.pool.Exec(ctx,
		`INSERT INTO settlements (id, intent_id, tx_hash, receipt_id, pay_currency, pay_amount, settle_amount, block_number, log_index, settled_at)
		 SELECT $1, si.id, $2, $3, si.settle_currency, $4, $5, $6, $7, now()
		 FROM settlement_intents si WHERE si.declaration_id = $8
		 ON CONFLICT (tx_hash, log_index) DO NOTHING`,
		settlementID, vLog.TxHash.Hex(), receiptID, ev.PayerAmount.String(), ev.RecipientAmount.String(),
		vLog.BlockNumber, vLog.Index, declarationID,
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
	return err
}
