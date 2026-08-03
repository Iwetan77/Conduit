package handlers

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"time"
)

// RPCProxy forwards browser JSON-RPC calls to Arc's RPC server-side.
//
// Arc's public RPC sits behind Cloudflare, which rate-limits and bot-blocks
// requests coming straight from a browser -- the failure surfaces as an opaque
// "Load failed" on eth_call/eth_blockNumber and, worst of all, on the embedded
// wallet's eth_sendRawTransaction broadcast, so a payment can't even be sent.
// A server-to-server call has none of that: no CORS preflight, no browser bot
// fingerprint. The app points NEXT_PUBLIC_ARC_RPC_URL at this endpoint and
// every browser-side read and broadcast flows through here instead.
//
// This is a payments relay, not an open proxy. Two controls keep it from being
// abused as free general-purpose Arc access:
//   - the upstream is fixed server-side (no SSRF -- the caller cannot choose a
//     destination), and
//   - only an explicit allowlist of JSON-RPC methods is forwarded (see
//     allowedRPCMethods): exactly what the app's reads and the wallet's
//     broadcast need, and nothing administrative.
//
// No auth: reads are public chain data and eth_sendRawTransaction carries a
// signed transaction that is already public the instant it's broadcast -- a
// payer from /send or a bare pay link has no API key to present anyway.
type RPCProxy struct {
	Upstream string
	Client   *http.Client
}

func NewRPCProxy(upstream string) *RPCProxy {
	if upstream == "" {
		upstream = "https://rpc.testnet.arc.network"
	}
	return &RPCProxy{
		Upstream: upstream,
		Client:   &http.Client{Timeout: 20 * time.Second},
	}
}

// The only methods forwarded. Read calls the app makes (balances, receipts,
// gas/fee estimation, logs) plus the single write it needs
// (eth_sendRawTransaction, already-signed). Deliberately excludes every
// administrative/introspection namespace (admin_, debug_, txpool_, personal_,
// miner_) so this can't be turned into a general node-management endpoint.
var allowedRPCMethods = map[string]bool{
	"eth_chainId":               true,
	"eth_blockNumber":           true,
	"net_version":               true,
	"web3_clientVersion":        true,
	"eth_call":                  true,
	"eth_estimateGas":           true,
	"eth_gasPrice":              true,
	"eth_maxPriorityFeePerGas":  true,
	"eth_feeHistory":            true,
	"eth_getBalance":            true,
	"eth_getCode":               true,
	"eth_getStorageAt":          true,
	"eth_getTransactionCount":   true,
	"eth_getTransactionByHash":  true,
	"eth_getTransactionReceipt": true,
	"eth_getBlockByNumber":      true,
	"eth_getBlockByHash":        true,
	"eth_getLogs":               true,
	"eth_sendRawTransaction":    true,
}

func (p *RPCProxy) Handle(w http.ResponseWriter, r *http.Request) {
	// A JSON-RPC call, even one carrying a signed transaction, is small.
	// Anything past 256 KiB is not a legitimate call from this app.
	body, err := io.ReadAll(io.LimitReader(r.Body, 256*1024))
	if err != nil {
		writeRPCError(w, http.StatusBadRequest, "could not read request body")
		return
	}

	if !rpcMethodsAllowed(body) {
		writeRPCError(w, http.StatusForbidden, "method not allowed via proxy")
		return
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, p.Upstream, bytes.NewReader(body))
	if err != nil {
		writeRPCError(w, http.StatusBadGateway, "could not build upstream request")
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := p.Client.Do(req)
	if err != nil {
		writeRPCError(w, http.StatusBadGateway, "arc rpc unreachable")
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	// Cap the response too: a well-behaved node reply is small; this guards
	// against a pathological upstream body.
	_, _ = io.Copy(w, io.LimitReader(resp.Body, 8*1024*1024))
}

// rpcMethodsAllowed accepts a request only if EVERY method in it is on the
// allowlist. Handles both a single call and a JSON-RPC batch array; a body
// that is neither, or names a disallowed method, is rejected.
func rpcMethodsAllowed(body []byte) bool {
	type call struct {
		Method string `json:"method"`
	}

	var single call
	if err := json.Unmarshal(body, &single); err == nil && single.Method != "" {
		return allowedRPCMethods[single.Method]
	}

	var batch []call
	if err := json.Unmarshal(body, &batch); err == nil && len(batch) > 0 {
		for _, c := range batch {
			if !allowedRPCMethods[c.Method] {
				return false
			}
		}
		return true
	}

	return false
}

func writeRPCError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	// Shape it as a JSON-RPC error so viem/ethers surface it cleanly rather
	// than choking on an unexpected body.
	_ = json.NewEncoder(w).Encode(map[string]any{
		"jsonrpc": "2.0",
		"id":      nil,
		"error":   map[string]any{"code": -32601, "message": message},
	})
}
