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

// The proxy must accept the exact range packages/sdk actually asks for.
//
// This is the bug it exists to prevent, and it is worth a test of its own
// because nothing else could catch it. The other cases here are written in
// terms of maxLogBlockRange, so they pass at ANY value of that constant --
// including the 5,000 it sat at while the SDK's getHistory requested 9,000.
// Every log scan the app made was refused with "range is too wide", and since
// that is an error rather than an empty result the SDK retried each of eight
// ranges three times with backoff. /history and /links took about thirty
// seconds to render nothing, and the on-chain half of both was silently empty.
//
// So the number is written out here literally, on purpose. If the SDK's chunk
// grows past what the proxy allows, this fails instead of two pages quietly
// going blank.
//
// Mirrors packages/sdk/src/receipt.ts: CHUNK = 9_000, and ranges are built as
// [start, start+CHUNK-1] -- a span of 8,999.
func TestProxyAllowsTheChunkTheSdkSends(t *testing.T) {
	const sdkSpan = 8_999

	body := fmt.Sprintf(
		`{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"0x0","toBlock":"0x%x"}]}`,
		sdkSpan,
	)
	if reason := rpcRequestAllowed([]byte(body)); reason != "" {
		t.Fatalf("the proxy refuses the SDK's own chunk size (%d blocks): %s\n"+
			"maxLogBlockRange is %d -- every getHistory call the app makes is a 403, "+
			"so /history and /links scan the chain, get nothing, and retry until they give up.",
			sdkSpan, reason, maxLogBlockRange)
	}

	// And the bound still bounds: one block past Arc's own ceiling is refused.
	tooWide := fmt.Sprintf(
		`{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"0x0","toBlock":"0x%x"}]}`,
		maxLogBlockRange+1,
	)
	if rpcRequestAllowed([]byte(tooWide)) == "" {
		t.Fatal("an unbounded scan was forwarded -- the cap has stopped capping")
	}
}
