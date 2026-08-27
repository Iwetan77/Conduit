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
}

var (
	mu    sync.Mutex
	pool  = map[string]*entry{}
	probe = 3 * time.Second
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
	// load balancer drops it, the network moves. Cheap liveness probe, so a dead
	// connection is replaced here rather than surfacing as an inexplicable
	// failure inside whatever call was about to be made.
	pingCtx, cancel := context.WithTimeout(ctx, probe)
	defer cancel()
	if _, err := e.client.ChainID(pingCtx); err != nil {
		// Only redial when the underlying connection is the problem, not when
		// the CALLER's context has been cancelled -- a cancelled request is not
		// evidence of anything about the connection.
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
		ne := &entry{client: fresh}
		ne.once.Do(func() {})
		pool[url] = ne
		mu.Unlock()
		return fresh, nil
	}
	return e.client, nil
}
