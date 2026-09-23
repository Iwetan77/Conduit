package handlers

import (
	"context"
	"math/big"
	"testing"
)

func TestConvertedNeedFallbackUsesTreasuryPrecision(t *testing.T) {
	h := &PayrollRuns{}
	cases := []struct {
		name, from, to, amount, want string
	}{
		{"18 to 6 decimals", "BRL", "USD", "4000000000000000000", "4080000"},
		{"6 to 18 decimals", "USD", "BRL", "4000000", "4080000000000000000"},
		{"equal precision", "CAD", "USD", "4000000", "4080000"},
		{"round up tiny amount", "BRL", "USD", "1", "2"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			amount, _ := new(big.Int).SetString(tc.amount, 10)
			got, estimated := h.convertedNeed(context.Background(), tc.from, tc.to, amount)
			if !estimated {
				t.Fatal("fallback must be marked estimated")
			}
			if got.String() != tc.want {
				t.Fatalf("convertedNeed(%s %s -> %s) = %s, want %s",
					tc.amount, tc.from, tc.to, got, tc.want)
			}
		})
	}
}
