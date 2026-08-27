// Package httpx holds the one outbound HTTP transport this service shares.
//
// Five clients each did `&http.Client{Timeout: ...}` and set no Transport, so
// all five fell back to http.DefaultTransport — whose MaxIdleConnsPerHost is
// **2**. StableFX, Circle Wallets and Circle Gateway are all *.circle.com, so
// those three shared a budget of two idle connections between them. Past two
// calls in flight to that host, every further request opened a new TCP
// connection and negotiated TLS from scratch, against a provider whose quote
// TTL is about three and a half seconds. The handshake was competing with the
// quote it was trying to fetch.
//
// One shared transport with a real idle pool removes that entirely. Per-client
// TIMEOUTS stay where they are: they are correctly differentiated (a webhook
// delivery should give up sooner than a chain read) and belong to the caller,
// not to the connection pool.
package httpx

import (
	"net/http"
	"time"
)

// Transport is shared by every outbound client in the service.
//
// Deliberately a single instance: Go's connection pooling lives on the
// Transport, so a per-client copy would give each its own pool and reproduce
// the problem this exists to fix, just with better numbers.
var Transport = &http.Transport{
	// Generous relative to what this service does. An idle connection costs a
	// file descriptor and nothing else, while a missing one costs a full TLS
	// handshake on a request someone is waiting for.
	MaxIdleConns:        200,
	MaxIdleConnsPerHost: 50,
	// Longer than Circle's quote TTL and longer than the gap between polls, so
	// a connection survives to be reused rather than being rebuilt each time.
	IdleConnTimeout: 90 * time.Second,
	// HTTP/2 multiplexes many requests over one connection, which matters most
	// for exactly the burst this fixes. Attempt rather than require: a host that
	// does not negotiate it falls back cleanly.
	ForceAttemptHTTP2:     true,
	TLSHandshakeTimeout:   10 * time.Second,
	ExpectContinueTimeout: 1 * time.Second,
}

// Client returns an http.Client using the shared transport with the given
// timeout. Prefer this over constructing an http.Client directly, so a new
// caller cannot silently inherit the two-connection default again.
func Client(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, Transport: Transport}
}
