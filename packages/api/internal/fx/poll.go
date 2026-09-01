package fx

// Check first, then wait — and wait a little longer each time.
//
// Both poll loops in this package slept at the TOP, so they waited even when
// the answer was already there. `PrepareWithSignature` spent a guaranteed 500ms
// before its first look for a contractTradeId, and `Submit` a guaranteed full
// second before its first status check. On a path the Phase B0 trace measured
// at 11.5s, that is 1.5s of dead time on every cross-stable payment, spent
// asleep before anybody asked anything.
//
// It is the same mistake Phase B2 fixed one layer up, where ethers polled at
// 4000ms for a chain that produces blocks in one. A fixed interval is a bet
// that the answer takes exactly that long, and it is wrong in both directions:
// too slow when the answer is ready, too chatty when it is not.
//
// The ramp is 100ms → 250ms → 500ms → 1s, which is the shape
// packages/app/src/lib/poll.ts already implements for the browser. Reusing that
// reasoning rather than writing a third polling strategy: a fast first few
// checks catch the common case where Circle is nearly done, and the backoff
// stops a long wait from becoming a request flood.

import (
	"context"
	"time"
)

// pollSteps is the interval after each attempt. The last value repeats.
var pollSteps = []time.Duration{
	100 * time.Millisecond,
	250 * time.Millisecond,
	500 * time.Millisecond,
	time.Second,
}

func pollDelay(attempt int) time.Duration {
	if attempt >= len(pollSteps) {
		return pollSteps[len(pollSteps)-1]
	}
	return pollSteps[attempt]
}

// poll calls check until it returns done, the deadline passes, or ctx is
// cancelled.
//
// check runs FIRST, before any sleep. That single ordering is most of the win:
// Circle frequently has the answer immediately, and the old loops could not
// find out until they had already waited.
//
// Returns whether check ever reported done, so a caller can tell "finished" from
// "ran out of time" without inspecting its own state again.
func poll(ctx context.Context, deadline time.Time, check func() bool) bool {
	for attempt := 0; ; attempt++ {
		if check() {
			return true
		}
		if !time.Now().Before(deadline) {
			return false
		}
		d := pollDelay(attempt)
		// Not time.Sleep: a cancelled request should stop polling a third party
		// immediately rather than finishing its nap first.
		select {
		case <-ctx.Done():
			return false
		case <-time.After(d):
		}
	}
}
