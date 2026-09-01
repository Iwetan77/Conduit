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

import "testing"

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
