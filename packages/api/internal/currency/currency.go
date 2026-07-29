// Package currency bridges the two currency namespaces this build deliberately
// kept separate (see packages/sdk/src/currency.ts's header comment):
//   - CurrencyRegistry.sol / this API's public surface: 3-letter fiat ISO code
//     ("USD", "EUR", "BRL", "AUD", "MXN", "CAD") — what settlement_intents.
//     settle_currency and accept_currencies hold, matching the v2 spec's JSON
//     examples.
//   - on-chain token symbol ("USDC", "EURC", "BRLA", "AUDF", "MXNB", "QCAD") —
//     what ConduitRouter/CurrencyRegistry.sol actually move.
//
// GET /v1/currencies (handlers/currencies.go) is generated from this table
// cross-checked against CurrencyRegistry.sol's live on-chain state — never a
// static hand-maintained list at the API-response boundary. This file IS the
// static bootstrap table, sourced from docs/fx-capability.md (Phase 0) and
// packages/contracts/script/Deploy.s.sol's registrations — it's the same
// static-list tradeoff SDK's currency.ts makes, for the same reason (nothing
// else exists yet to read it from).
package currency

import (
	"math/big"
	"strings"
)

type Info struct {
	ISO      string // 3-letter fiat code, CurrencyRegistry.sol's bytes3 key
	Symbol   string // on-chain token symbol
	Token    string // token address on Arc testnet
	Decimals int
}

var registry = []Info{
	{ISO: "USD", Symbol: "USDC", Token: "0x3600000000000000000000000000000000000000", Decimals: 6},
	{ISO: "EUR", Symbol: "EURC", Token: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a", Decimals: 6},
	{ISO: "BRL", Symbol: "BRLA", Token: "0x8629020763F6239643a02e664a25BF4AD7787254", Decimals: 18},
	{ISO: "AUD", Symbol: "AUDF", Token: "0xd2a530170D71a9Cfe1651Fb468E2B98F7Ed7456b", Decimals: 6},
	{ISO: "MXN", Symbol: "MXNB", Token: "0x836F73Fbc370A9329Ba4957E47912DfDBA6BA461", Decimals: 6},
	{ISO: "CAD", Symbol: "QCAD", Token: "0x23d7CFFd0876f3ABb6B074287ba2aeefBc83825d", Decimals: 6},
	{ISO: "GBP", Symbol: "GBPA", Token: "0xa42e82b5D25E84d107Cd8549CA432ef489CbaD32", Decimals: 6},
	{ISO: "ZAR", Symbol: "ZARU", Token: "0x47b025D6002234a5038bCD94767bd82b27C2b96F", Decimals: 18},
	{ISO: "KRW", Symbol: "KRW1", Token: "0xC5bD9EBB09446F5F94E3b3D899072fC2eC5d3a1a", Decimals: 18},
}

func All() []Info { return registry }

func ByISO(iso string) (Info, bool) {
	iso = strings.ToUpper(iso)
	for _, c := range registry {
		if c.ISO == iso {
			return c, true
		}
	}
	return Info{}, false
}

func BySymbol(symbol string) (Info, bool) {
	symbol = strings.ToUpper(symbol)
	for _, c := range registry {
		if c.Symbol == symbol {
			return c, true
		}
	}
	return Info{}, false
}

// FormatMinorUnits converts a raw minor-unit integer string (what
// NUMERIC(78,0) columns hold — e.g. "3339000") into a human decimal string
// at the given precision ("3.339000"), with pure big.Int arithmetic — no
// float64 anywhere, so an 18-decimal amount never loses precision the way it
// would if this went through a float. Used only at display/export boundaries
// (CSV, dashboard); the API's own JSON responses keep raw minor units, same
// as Stripe's amount convention.
func FormatMinorUnits(raw string, decimals int) string {
	n, ok := new(big.Int).SetString(raw, 10)
	if !ok {
		return raw // not a valid integer string — pass through rather than silently mangle it
	}
	if decimals == 0 {
		return n.String()
	}
	neg := n.Sign() < 0
	abs := new(big.Int).Abs(n)
	divisor := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil)
	whole := new(big.Int)
	frac := new(big.Int)
	whole.DivMod(abs, divisor, frac)

	fracStr := frac.String()
	fracStr = strings.Repeat("0", decimals-len(fracStr)) + fracStr

	sign := ""
	if neg {
		sign = "-"
	}
	return sign + whole.String() + "." + fracStr
}
