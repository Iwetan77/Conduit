package server

// One payment must not throttle itself.
//
// POST /v1/rpc shared the public limiter at 5/second with a burst of 20, and a
// single payment makes dozens of JSON-RPC calls -- nonce, gas estimate, fee
// history, broadcast, then receipt polling. Measured against production before
// this changed: thirty rapid calls, the volume of ONE payment, returned nine
// 429s. The browser surfaces a rejected read as "failed to fetch", which the
// app reports to the payer as "Couldn't reach the network".
//
// Phase B2 then made it worse by fixing something else: dropping ethers' poll
// interval from 4000ms to 500ms multiplied receipt-polling requests by eight,
// straight into that bucket. This test is the thing that would have caught it.

import (
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
)

func TestOnePaymentDoesNotExhaustTheRPCBucket(t *testing.T) {
	rl := newRateLimiter(rpcRatePerSecond, rpcBurst)

	// A generous estimate of one payment's reads at the post-B2 poll rate: two
	// transactions, each with a nonce, gas estimate, fee history, broadcast and
	// around twenty receipt polls.
	const oneBusyPayment = 60

	rejected := 0
	for i := 0; i < oneBusyPayment; i++ {
		if !rl.allowN("rpc:1.2.3.4", rpcMethodCost("eth_getTransactionReceipt")) {
			rejected++
		}
	}
	if rejected > 0 {
		t.Fatalf("%d of %d calls from a single payment were rejected", rejected, oneBusyPayment)
	}
}

// Several payers behind one carrier NAT share an IP. A second payer must not
// halve the first one's allowance, which is what "22s for me, 29s for my
// friends" was.
func TestSeveralPayersBehindOneNATStillGetThrough(t *testing.T) {
	rl := newRateLimiter(rpcRatePerSecond, rpcBurst)

	const payers = 5
	const callsEach = 60

	rejected := 0
	for p := 0; p < payers; p++ {
		for i := 0; i < callsEach; i++ {
			if !rl.allowN("rpc:1.2.3.4", rpcMethodCost("eth_getTransactionReceipt")) {
				rejected++
			}
		}
	}
	// The burst is 400, so five payers at 60 calls each fit. That is the
	// property which matters: sharing an IP is normal, not abuse.
	if rejected > 0 {
		t.Fatalf("%d of %d calls rejected across %d payers on one IP", rejected, payers*callsEach, payers)
	}
}

// The limit still exists. A client that will not stop is eventually refused.
func TestTheRPCBucketIsNotUnlimited(t *testing.T) {
	rl := newRateLimiter(rpcRatePerSecond, rpcBurst)
	rejected := 0
	for i := 0; i < rpcBurst*3; i++ {
		if !rl.allowN("rpc:9.9.9.9", 1) {
			rejected++
		}
	}
	if rejected == 0 {
		t.Fatal("the RPC limiter never refused anything — it is not a limit")
	}
}

// eth_getLogs is the one method whose cost its caller controls. Receipt polling
// must stay nearly free while a log scan is charged what it costs.
func TestExpensiveMethodsCostMore(t *testing.T) {
	if rpcMethodCost("eth_getLogs") <= rpcMethodCost("eth_getTransactionReceipt") {
		t.Error("a log scan is not charged more than a receipt lookup")
	}
	if rpcMethodCost("eth_getTransactionReceipt") != 1 {
		t.Error("receipt polling is not the cheapest thing in the table")
	}
	// An unknown method must not be free -- that would be the way around this.
	if rpcMethodCost("some_new_method") < 1 {
		t.Error("an unrecognised method costs nothing")
	}
}

// The bug the unit tests above could not see.
//
// The first attempt at this added rateLimitRPC to the /rpc route while leaving
// it inside the group that already applied the public limiter. chi runs BOTH,
// so the 5/second bucket still rejected calls the new 120/second one had just
// allowed — the limiter was correct, the wiring made it irrelevant, and
// production kept failing exactly as before.
//
// Unit-testing the limiter proved the limiter. This exercises the ROUTER, which
// is where the mistake actually was.
func TestRPCIsNotBehindThePublicLimiter(t *testing.T) {
	srv, _, _ := newLinkTestServer(t, 15640)

	// CONCURRENT, and that detail is the test.
	//
	// A sequential version of this passes even with the bug present: sixty
	// round trips take about 28 seconds, and a 5/second bucket refills 140
	// tokens in that time, so it never runs dry. It proved nothing and reported
	// success -- which is worse than not having it.
	//
	// A payment does not make its reads politely one at a time. It fires nonce,
	// gas estimate, fee history and receipt polls as fast as the wallet needs
	// them, and that is what exhausts a burst of 20. Firing them together is
	// the only shape that reproduces what a payer actually does.
	const calls = 60

	body := `{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}`

	var wg sync.WaitGroup
	var mu sync.Mutex
	limited := 0

	for i := 0; i < calls; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req, err := http.NewRequest(http.MethodPost, srv.URL+"/v1/rpc", strings.NewReader(body))
			if err != nil {
				return
			}
			req.Header.Set("content-type", "application/json")
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				return
			}
			defer res.Body.Close()
			io.Copy(io.Discard, res.Body)
			if res.StatusCode == http.StatusTooManyRequests {
				mu.Lock()
				limited++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	if limited > 0 {
		t.Fatalf(
			"%d of %d concurrent /v1/rpc calls were rate limited -- the route is still sharing the "+
				"public bucket, which is what makes one payment fail with \"Couldn't reach the network\"",
			limited, calls,
		)
	}
}

// A comma-separated CONDUIT_ROUTER_ADDRESS must not reach the indexer.
//
// The list exists so the approve guard tolerates a browser that has not rebuilt
// yet. Everything else means ONE contract: the indexer watches its events and
// RecordDirectSettlement requires settlements to have come from it. Handed
// "addr1,addr2" either would match nothing, and match-nothing is a silent
// failure — settlements simply stop being recorded, with no error anywhere.
func TestOnlyThePrimaryRouterReachesTheIndexer(t *testing.T) {
	const current = "0x2Bd51BB0CA986703A4449796EdCeCAB81126899C"
	const previous = "0x80f996e86C003AF309635B67A53dC6e63e623318"

	t.Setenv("CONDUIT_ROUTER_ADDRESS", current+","+previous)
	if got := PrimaryRouterAddress(); got != current {
		t.Errorf("primary router = %q, want %q", got, current)
	}

	// Spaces are how a human writes a list.
	t.Setenv("CONDUIT_ROUTER_ADDRESS", " "+current+" , "+previous+" ")
	if got := PrimaryRouterAddress(); got != current {
		t.Errorf("primary router = %q, want %q", got, current)
	}

	// The single-address case, which is every deployment not mid-migration.
	t.Setenv("CONDUIT_ROUTER_ADDRESS", current)
	if got := PrimaryRouterAddress(); got != current {
		t.Errorf("primary router = %q, want %q", got, current)
	}

	// Unset stays empty, which callers already treat as "indexer off".
	t.Setenv("CONDUIT_ROUTER_ADDRESS", "")
	if got := PrimaryRouterAddress(); got != "" {
		t.Errorf("primary router = %q, want empty", got)
	}
}
