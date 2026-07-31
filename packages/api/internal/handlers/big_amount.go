package handlers

import (
	"bytes"
	"fmt"
	"math/big"
)

// bigAmount is a big.Int that unmarshals from either a JSON string
// ("5000000") or a bare JSON number (5000000). Amounts are integer minor
// units; well-behaved clients (the app, the SDK) send them as strings
// because JavaScript numbers silently lose integer precision above 2^53 —
// bare *big.Int fields rejected exactly those clients.
type bigAmount struct{ big.Int }

func (b *bigAmount) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	if string(data) == "null" {
		return nil
	}
	data = bytes.Trim(data, `"`)
	if len(data) == 0 {
		return fmt.Errorf("empty amount")
	}
	if _, ok := b.SetString(string(data), 10); !ok {
		return fmt.Errorf("invalid integer amount %q", data)
	}
	return nil
}

// bi returns the underlying *big.Int, passing nil through so existing
// nil-aware helpers (bigStrDB/bigStrDisplay) keep working.
func (b *bigAmount) bi() *big.Int {
	if b == nil {
		return nil
	}
	return &b.Int
}
