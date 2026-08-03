package models

import (
	"crypto/rand"
	"encoding/base32"
	"strings"
)

// NewID generates a Stripe-style prefixed resource id, e.g. "si_9k2j3h4g5f6d".
func NewID(prefix string) string {
	return newIDN(prefix, 20)
}

// NewShortID is for ids that end up in a human-facing URL a person reads,
// types, or reads aloud -- payment links, above all. 20 random chars make a
// "weird-ass string"; 10 base32 chars is 50 bits of entropy, which at any
// realistic link volume has a vanishing collision chance while keeping the
// URL short enough to look deliberate. Longer, machine-only ids (accounts,
// api keys, intents created by the API) stay at full length via NewID.
func NewShortID(prefix string) string {
	return newIDN(prefix, 10)
}

func newIDN(prefix string, n int) string {
	// 15 random bytes -> 24 base32 chars; we slice the first n. n must not
	// exceed 24.
	buf := make([]byte, 15)
	if _, err := rand.Read(buf); err != nil {
		panic("models: crypto/rand failed: " + err.Error())
	}
	enc := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(buf)
	return prefix + "_" + strings.ToLower(enc[:n])
}
