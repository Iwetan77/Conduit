package handlers

import (
	"context"
	"encoding/hex"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"

	"github.com/kzn-labs/conduit/api/internal/arcrpc"
	"github.com/kzn-labs/conduit/api/internal/currency"
	apierrors "github.com/kzn-labs/conduit/api/internal/errors"
)

// Multicall3 is deployed at the same canonical address on every chain Circle
// runs, Arc testnet included (verified on-chain: 7618 bytes of code).
const multicall3Addr = "0xcA11bde05977b3631167028862bE2a173976CA11"

// Reading balances straight from the browser does not scale: Arc's public RPC
// rate-limits per client, so every extra visitor makes everyone's balances
// flakier. This endpoint moves the read server-side and caches it briefly, so
// N users hitting the same page cost ONE RPC call instead of N. Same pattern
// Zerion/Zapper/Rainbow use rather than fanning out reads from each browser.
const balanceCacheTTL = 10 * time.Second

type Balances struct {
	ArcRPC string

	mu    sync.Mutex
	cache map[string]*balanceCacheEntry
}

type balanceCacheEntry struct {
	at   time.Time
	data []balanceRow
	err  error
	// Guards against a thundering herd: concurrent requests for the same
	// address wait on one in-flight read rather than each starting their own.
	ready chan struct{}
}

type balanceRow struct {
	ISO      string `json:"iso"`
	Symbol   string `json:"symbol"`
	Token    string `json:"token"`
	Decimals int    `json:"decimals"`
	Amount   string `json:"amount"` // integer minor units, never a float
}

// aggregate3((address target, bool allowFailure, bytes callData)[])
const multicall3ABI = `[{"inputs":[{"components":[{"name":"target","type":"address"},{"name":"allowFailure","type":"bool"},{"name":"callData","type":"bytes"}],"name":"calls","type":"tuple[]"}],"name":"aggregate3","outputs":[{"components":[{"name":"success","type":"bool"},{"name":"returnData","type":"bytes"}],"name":"returnData","type":"tuple[]"}],"stateMutability":"payable","type":"function"}]`

type multicall3Call struct {
	Target       common.Address `json:"target"`
	AllowFailure bool           `json:"allowFailure"`
	CallData     []byte         `json:"callData"`
}

// List implements GET /v1/balances?address=0x... — public (a payer has no API
// key). Returns every registered currency with its balance in minor units.
func (h *Balances) List(w http.ResponseWriter, r *http.Request) {
	addr := strings.TrimSpace(r.URL.Query().Get("address"))
	if !common.IsHexAddress(addr) {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "address"))
		return
	}
	// Normalise so 0xAB… and 0xab… share one cache entry.
	key := strings.ToLower(addr)

	rows, err := h.balancesFor(r.Context(), key)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeFxProviderUnavailable, "arc_rpc"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": rows, "address": addr})
}

func (h *Balances) balancesFor(ctx context.Context, addr string) ([]balanceRow, error) {
	h.mu.Lock()
	if h.cache == nil {
		h.cache = make(map[string]*balanceCacheEntry)
	}
	if e, ok := h.cache[addr]; ok {
		if e.ready == nil && time.Since(e.at) < balanceCacheTTL {
			h.mu.Unlock()
			return e.data, e.err
		}
		if e.ready != nil {
			// A read for this address is already in flight — wait for it.
			h.mu.Unlock()
			select {
			case <-e.ready:
				return e.data, e.err
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
	}
	entry := &balanceCacheEntry{ready: make(chan struct{})}
	h.cache[addr] = entry
	h.mu.Unlock()

	rows, err := h.readOnChain(ctx, addr)

	h.mu.Lock()
	entry.data, entry.err, entry.at = rows, err, time.Now()
	close(entry.ready)
	entry.ready = nil
	h.mu.Unlock()
	return rows, err
}

func (h *Balances) readOnChain(ctx context.Context, addr string) ([]balanceRow, error) {
	client, err := arcrpc.Get(ctx, h.ArcRPC)
	if err != nil {
		return nil, fmt.Errorf("dial arc rpc: %w", err)
	}

	mcABI, err := abi.JSON(strings.NewReader(multicall3ABI))
	if err != nil {
		return nil, err
	}

	all := currency.All()
	owner := common.HexToAddress(addr)
	// balanceOf(address) selector + 32-byte padded owner.
	selector, _ := hex.DecodeString("70a08231")
	calls := make([]multicall3Call, 0, len(all))
	for _, c := range all {
		data := append(append([]byte{}, selector...), common.LeftPadBytes(owner.Bytes(), 32)...)
		calls = append(calls, multicall3Call{
			Target:       common.HexToAddress(c.Token),
			AllowFailure: true,
			CallData:     data,
		})
	}

	input, err := mcABI.Pack("aggregate3", calls)
	if err != nil {
		return nil, err
	}
	to := common.HexToAddress(multicall3Addr)
	out, err := client.CallContract(ctx, ethereum.CallMsg{To: &to, Data: input}, nil)
	if err != nil {
		return nil, fmt.Errorf("multicall: %w", err)
	}

	unpacked, err := mcABI.Unpack("aggregate3", out)
	if err != nil || len(unpacked) == 0 {
		return nil, fmt.Errorf("decode multicall: %w", err)
	}
	raw, ok := unpacked[0].([]struct {
		Success    bool    `json:"success"`
		ReturnData []uint8 `json:"returnData"`
	})
	if !ok {
		return nil, fmt.Errorf("unexpected multicall shape")
	}

	rows := make([]balanceRow, 0, len(all))
	for i, c := range all {
		amount := "0"
		if i < len(raw) && raw[i].Success && len(raw[i].ReturnData) >= 32 {
			amount = new(big.Int).SetBytes(raw[i].ReturnData[:32]).String()
		}
		rows = append(rows, balanceRow{
			ISO: c.ISO, Symbol: c.Symbol, Token: c.Token, Decimals: c.Decimals, Amount: amount,
		})
	}
	return rows, nil
}
