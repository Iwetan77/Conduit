package handlers

import (
	"fmt"
	"strings"
	"testing"
)

// The proxy forwards to Arc's public endpoint on our behalf, on a route that
// needs no credential. One HTTP request is one token against the rate limiter
// however much work it asks for, so the cost of a request has to be bounded by
// something other than the limiter.
func TestRPCRequestLimits(t *testing.T) {
	batchOf := func(n int, call string) string {
		parts := make([]string, n)
		for i := range parts {
			parts[i] = call
		}
		return "[" + strings.Join(parts, ",") + "]"
	}
	const blockNumber = `{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}`

	cases := []struct {
		name    string
		body    string
		allowed bool
	}{
		{"a single allowed call", blockNumber, true},
		{"a small batch", batchOf(5, blockNumber), true},
		{"a batch at the cap", batchOf(maxRPCBatchCalls, blockNumber), true},
		{"a batch over the cap", batchOf(maxRPCBatchCalls+1, blockNumber), false},
		{
			// The amplifier: one request, one rate-limit token, thousands of
			// chain scans.
			name:    "a large batch of expensive calls",
			body:    batchOf(500, `{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"0x1","toBlock":"0x2"}]}`),
			allowed: false,
		},
		{"a method that is not allowlisted", `{"jsonrpc":"2.0","id":1,"method":"personal_unlockAccount","params":[]}`, false},

		// eth_getLogs ranges
		{
			name:    "a narrow log range",
			body:    `{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"0x1000","toBlock":"0x1064"}]}`,
			allowed: true,
		},
		{
			name:    "a log range at the cap",
			body:    fmt.Sprintf(`{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"0x0","toBlock":"0x%x"}]}`, maxLogBlockRange),
			allowed: true,
		},
		{
			name:    "a log range past the cap",
			body:    fmt.Sprintf(`{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"0x0","toBlock":"0x%x"}]}`, maxLogBlockRange+1),
			allowed: false,
		},
		{
			name:    "scanning from the genesis block",
			body:    `{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"earliest","toBlock":"latest"}]}`,
			allowed: false,
		},
		{
			// Tags name a single block, so these stay cheap and must keep working.
			name:    "latest only",
			body:    `{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"latest","toBlock":"latest"}]}`,
			allowed: true,
		},
		{
			name:    "a filter with no range at all",
			body:    `{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"address":"0x3600000000000000000000000000000000000000"}]}`,
			allowed: true,
		},
		{"not JSON-RPC at all", `{"hello":"world"}`, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reason := rpcRequestAllowed([]byte(tc.body))
			if tc.allowed && reason != "" {
				t.Errorf("rejected a legitimate request: %s", reason)
			}
			if !tc.allowed && reason == "" {
				t.Error("forwarded a request that should have been refused")
			}
		})
	}
}
