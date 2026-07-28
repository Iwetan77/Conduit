package models

import (
	"crypto/rand"
	"encoding/base32"
	"strings"
)

// NewID generates a Stripe-style prefixed resource id, e.g. "si_9k2j3h4g5f6d".
func NewID(prefix string) string {
	buf := make([]byte, 15) // 15 bytes -> 24 base32 chars, trimmed
	if _, err := rand.Read(buf); err != nil {
		panic("models: crypto/rand failed: " + err.Error())
	}
	enc := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(buf)
	return prefix + "_" + strings.ToLower(enc[:20])
}
