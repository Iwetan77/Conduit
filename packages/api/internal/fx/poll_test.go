package fx

// The property Phase B4.1 is about: ask first, then wait.
//
// Both poll loops in this package slept at the TOP, so the fastest either could
// ever report an answer was one full interval after it became true. On a
// cross-stable path the Phase B0 trace measured at 11.5s, that was roughly 1.5s
// of guaranteed dead time — spent asleep before anybody asked anything.

import (
	"context"
	"testing"
	"time"
)

func TestPollChecksBeforeSleeping(t *testing.T) {
	start := time.Now()
	calls := 0

	done := poll(context.Background(), time.Now().Add(5*time.Second), func() bool {
		calls++
		return true // already true on the first look
	})

	elapsed := time.Since(start)
	if !done {
		t.Fatal("poll reported not-done for a check that was true immediately")
	}
	if calls != 1 {
		t.Errorf("check called %d times, want 1", calls)
	}
	// The old loop would have slept 500ms or a full second here before its
	// first look. This is the whole phase, as one assertion.
	if elapsed > 50*time.Millisecond {
		t.Errorf("took %v to return an answer that was ready immediately", elapsed)
	}
}

func TestPollRampsRatherThanFlatSleeping(t *testing.T) {
	// Four attempts cost 100 + 250 + 500 = 850ms of waiting, where the old flat
	// interval charged three full seconds for the same four looks.
	start := time.Now()
	calls := 0
	poll(context.Background(), time.Now().Add(10*time.Second), func() bool {
		calls++
		return calls >= 4
	})
	elapsed := time.Since(start)

	if calls != 4 {
		t.Fatalf("check called %d times, want 4", calls)
	}
	if elapsed > 1500*time.Millisecond {
		t.Errorf("four attempts took %v; the ramp should cost about 850ms", elapsed)
	}
	if elapsed < 700*time.Millisecond {
		t.Errorf("four attempts took only %v — the ramp is not waiting at all", elapsed)
	}
}

func TestPollStopsAtTheDeadline(t *testing.T) {
	start := time.Now()
	done := poll(context.Background(), time.Now().Add(300*time.Millisecond), func() bool { return false })
	if done {
		t.Fatal("reported done for a check that never succeeded")
	}
	if time.Since(start) > 2*time.Second {
		t.Errorf("overran its deadline by %v", time.Since(start))
	}
}

// A cancelled request should stop polling a third party immediately rather than
// finishing its nap first.
func TestPollStopsWhenTheRequestIsCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(120 * time.Millisecond)
		cancel()
	}()

	start := time.Now()
	poll(ctx, time.Now().Add(30*time.Second), func() bool { return false })
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("kept polling %v after cancellation", elapsed)
	}
}
