// Package arcrpc keeps one Arc RPC connection per URL, for the life of the
// process.
//
// Four handlers dialled Arc, made a single call, and closed the connection
// again: the balance read, the settlement verification and two bridge checks.
// Every one of them paid a full TCP handshake plus TLS negotiation BEFORE any
// work started. The ten second balance cache hid that from repeat callers and
// did nothing whatever for the first one — and the first one is a payer sitting
// on a checkout screen waiting to find out what they hold.
//
// An ethclient is safe for concurrent use and is designed to be long-lived, so
// the dial belongs once per process rather than once per request.
package arcrpc

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/ethclient"
)

type entry struct {
	once   sync.Once
	client *ethclient.Client
	err    error

	// When this connection was last known good. Guarded by its own mutex
	// rather than the package one, so a probe on one URL cannot block a
	// lookup on another.
	probeMu   sync.Mutex
	lastProbe time.Time
}

// needsProbe reports whether this connection is stale enough to check, and
// claims the check so concurrent callers do not all probe at once. A payment
// makes many calls in a burst; without the claim they would each decide
// independently that a probe was due.
func (e *entry) needsProbe() bool {
	e.probeMu.Lock()
	defer e.probeMu.Unlock()
	if time.Since(e.lastProbe) < probeInterval {
		return false
	}
	// Claimed optimistically: if the probe then fails, the entry is discarded
	// anyway, so a stale timestamp on a dead entry cannot mislead anyone.
	e.lastProbe = time.Now()
	return true
}

func (e *entry) markProbed() {
	e.probeMu.Lock()
	e.lastProbe = time.Now()
	e.probeMu.Unlock()
}

var (
	mu    sync.Mutex
	pool  = map[string]*entry{}
	probe = 3 * time.Second
	// How stale a connection may be before it is worth checking.
	//
	// Long enough that the probe disappears from the cost of a payment -- a
	// payment makes many calls in a few seconds and now probes at most once
	// across all of them -- and short enough that a connection dropped by a
	// restart or a load balancer is noticed within a few requests rather than
	// lingering.
	probeInterval = 30 * time.Second
)

// Get returns the shared client for `url`, dialling once and reusing it after.
//
// Deliberately never closed. The process holding it IS the lifetime: closing on
// behalf of one request would pull the connection out from under every other
// request sharing it, which is the bug this package exists to remove.
func Get(ctx context.Context, url string) (*ethclient.Client, error) {
	mu.Lock()
	e, ok := pool[url]
	if !ok {
		e = &entry{}
		pool[url] = e
	}
	mu.Unlock()

	e.once.Do(func() {
		e.client, e.err = ethclient.DialContext(ctx, url)
		if e.err == nil {
			// A successful dial IS a liveness check. Probing it again on the
			// very next call would reintroduce the cost this removes.
			e.lastProbe = time.Now()
		}
	})
	if e.err != nil {
		// A dial that failed once must not poison the URL forever -- the RPC may
		// simply have been down at boot. Clear the entry so the next caller
		// re-dials, then report this attempt's failure.
		mu.Lock()
		delete(pool, url)
		mu.Unlock()
		return nil, e.err
	}

	// A pooled connection can die without anyone noticing: the RPC restarts, a
	// load balancer drops it, the network moves. So it is probed -- but NOT on
	// every call.
	//
	// It used to be. Every Get ran a ChainID round trip before handing back a
	// client, which put a full RPC round trip in front of every balance read,
	// every receipt fetch and every payroll verification. The Phase B0 trace
	// measured Arc at ~242ms direct and ~850ms through this API, so that probe
	// was paying up to a second, every time, to answer a question whose answer
	// is almost always yes.
	//
	// The connection is either healthy or the real call will say so. Probing
	// first pays the cost on every call to save it on the rare one, which is
	// backwards. Now it is probed at most once per probeInterval per URL; in
	// between, callers get the pooled client immediately and a genuinely dead
	// connection surfaces on the real call, where the caller's own error
	// handling already deals with it.
	if e.needsProbe() {
		pingCtx, cancel := context.WithTimeout(ctx, probe)
		defer cancel()
		if _, err := e.client.ChainID(pingCtx); err != nil {
			// Only redial when the underlying connection is the problem, not
			// when the CALLER's context has been cancelled -- a cancelled
			// request is not evidence of anything about the connection.
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			log.Printf("arcrpc: pooled connection to %s failed liveness (%v), redialling", url, err)
			mu.Lock()
			delete(pool, url)
			mu.Unlock()
			fresh, derr := ethclient.DialContext(ctx, url)
			if derr != nil {
				return nil, derr
			}
			mu.Lock()
			// Just dialled, so it is known good: start its clock now rather
			// than letting the next caller probe a connection one line old.
			ne := &entry{client: fresh, lastProbe: time.Now()}
			ne.once.Do(func() {})
			pool[url] = ne
			mu.Unlock()
			return fresh, nil
		}
		e.markProbed()
	}
	return e.client, nil
}
