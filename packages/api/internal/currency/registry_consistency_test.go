package currency

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Decimals are the one currency field that loses money when it is wrong.
//
// Every amount in this system is an integer in a token's own minor units. A
// token recorded as 6dp when it is really 18dp is not a display bug -- it is a
// factor of 10^12 on a real transfer, and three of the tokens here genuinely
// are 18dp while the rest are 6dp, so the mistake is a plausible one rather
// than a theoretical one. It would not announce itself either: the payment
// would settle, for the wrong amount.
//
// The address is the same class of problem. Wrong address, wrong asset, and
// nothing downstream can tell.
//
// Those two facts are currently written down in several hand-maintained tables
// across three languages, with nothing checking them against each other or
// against the chain. This file is that check. It has two halves:
//
//   - TestRegistryMatchesFrontendTables: no network, always runs. Catches the
//     realistic failure, which is someone adding a currency to one table and
//     not the others.
//   - TestRegistryDecimalsMatchChain: reads decimals() and symbol() from Arc.
//     The token contract is the only real authority; everything else is a copy.
//
// The on-chain CurrencyRegistry already validates decimals at registration
// (registerCurrency reverts on a mismatch with the token's own decimals()), so
// the contracts are safe by construction. These tables are not, and they are
// what the API and the app actually compute with.

// repoRoot returns the repository root, derived from this file's location so
// the test does not depend on the working directory.
func repoRoot(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	// packages/api/internal/currency -> up four
	return filepath.Clean(filepath.Join(filepath.Dir(thisFile), "..", "..", "..", ".."))
}

func readRepoFile(t *testing.T, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(repoRoot(t), rel))
	if err != nil {
		t.Fatalf("read %s: %v", rel, err)
	}
	return string(b)
}

// The TS tables are parsed rather than imported, because there is no way for Go
// to import them. That makes these patterns load-bearing: if the shape of those
// files changes, the parse finds nothing and the test fails loudly rather than
// passing vacuously -- which is why each parse asserts it found a plausible
// number of entries.
var (
	// CHFAU: { iso: "CHFAU", token: "0x...", decimals: 6 },
	sdkEntryRe = regexp.MustCompile(`(?m)^\s*(\w+):\s*\{\s*iso:\s*"([^"]+)",\s*token:\s*"(0x[0-9a-fA-F]{40})",\s*decimals:\s*(\d+)\s*\}`)
	// USD: "USDC",
	isoToTokenRe = regexp.MustCompile(`(?m)^\s*([A-Z0-9]+):\s*"([A-Z0-9]+)",`)
)

// TestRegistryMatchesFrontendTables asserts the Go registry, the SDK's
// CURRENCIES table and the app's ISO->token map all say the same thing.
//
// This is the failure that actually happens: a currency is added in one place
// and missed in another. It needs no network, so it runs everywhere, always.
func TestRegistryMatchesFrontendTables(t *testing.T) {
	// ── SDK: packages/sdk/src/currency.ts ────────────────────────────────────
	sdkSrc := readRepoFile(t, "packages/sdk/src/currency.ts")
	type sdkEntry struct {
		token    string
		decimals int
	}
	sdk := map[string]sdkEntry{}
	for _, m := range sdkEntryRe.FindAllStringSubmatch(sdkSrc, -1) {
		key, iso, token, decStr := m[1], m[2], m[3], m[4]
		if key != iso {
			t.Errorf("sdk currency.ts: entry keyed %q but iso is %q; they must match "+
				"or resolveCurrency looks up something the descriptor does not describe", key, iso)
		}
		dec, err := strconv.Atoi(decStr)
		if err != nil {
			t.Fatalf("sdk currency.ts: bad decimals %q for %s", decStr, key)
		}
		sdk[key] = sdkEntry{token: token, decimals: dec}
	}
	if len(sdk) < len(registry) {
		t.Fatalf("parsed only %d entries from sdk currency.ts but the Go registry has %d; "+
			"either the table shrank or sdkEntryRe no longer matches the file's shape", len(sdk), len(registry))
	}

	// Every Go entry must appear in the SDK, with the same address and decimals.
	for _, info := range registry {
		got, ok := sdk[info.Symbol]
		if !ok {
			t.Errorf("%s (%s) is in the Go registry but missing from packages/sdk/src/currency.ts",
				info.Symbol, info.ISO)
			continue
		}
		if !strings.EqualFold(got.token, info.Token) {
			t.Errorf("%s token address disagrees:\n  go:  %s\n  sdk: %s", info.Symbol, info.Token, got.token)
		}
		if got.decimals != info.Decimals {
			t.Errorf("%s DECIMALS disagree: go=%d sdk=%d — this is a 10^%d error on every amount",
				info.Symbol, info.Decimals, got.decimals, abs(info.Decimals-got.decimals))
		}
	}
	// And nothing extra in the SDK that the API has never heard of, which would
	// let a client construct a payment the API cannot resolve.
	for symbol := range sdk {
		if _, ok := BySymbol(symbol); !ok {
			t.Errorf("%s is in packages/sdk/src/currency.ts but not in the Go registry", symbol)
		}
	}

	// ── App: packages/app/src/lib/currencies.ts ──────────────────────────────
	appSrc := readRepoFile(t, "packages/app/src/lib/currencies.ts")

	isoToToken := map[string]string{}
	if start := strings.Index(appSrc, "ISO_TO_TOKEN"); start >= 0 {
		block := appSrc[start:]
		if end := strings.Index(block, "};"); end > 0 {
			block = block[:end]
		}
		for _, m := range isoToTokenRe.FindAllStringSubmatch(block, -1) {
			isoToToken[m[1]] = m[2]
		}
	}
	if len(isoToToken) == 0 {
		t.Fatal("parsed no entries from ISO_TO_TOKEN in packages/app/src/lib/currencies.ts; " +
			"the map's shape probably changed and isoToTokenRe needs updating")
	}

	// Whatever the app maps an ISO to, the API must agree that is the token for
	// that ISO -- this is what decides which asset a merchant is actually paid in.
	for iso, token := range isoToToken {
		info, ok := ByISO(iso)
		if !ok {
			t.Errorf("app maps %s -> %s but the Go registry has no %s", iso, token, iso)
			continue
		}
		if info.Symbol != token {
			t.Errorf("%s resolves to a DIFFERENT TOKEN in each place: go=%s app=%s — "+
				"a merchant settling in %s would be paid the wrong asset",
				iso, info.Symbol, token, iso)
		}
	}

	// Every currency the dashboard offers must be resolvable, or picking it
	// fails at settlement time rather than at selection time.
	for _, code := range parseSettleCurrencies(t, appSrc) {
		if _, ok := ByISO(code); !ok {
			t.Errorf("SETTLE_CURRENCIES offers %q but the API cannot resolve it; "+
				"a merchant could choose a currency no payment can settle in", code)
		}
	}
}

var settleCurrenciesRe = regexp.MustCompile(`SETTLE_CURRENCIES\s*=\s*\[([^\]]*)\]`)

func parseSettleCurrencies(t *testing.T, src string) []string {
	t.Helper()
	m := settleCurrenciesRe.FindStringSubmatch(src)
	if m == nil {
		t.Fatal("could not find SETTLE_CURRENCIES in packages/app/src/lib/currencies.ts")
	}
	var out []string
	for _, part := range strings.Split(m[1], ",") {
		if s := strings.Trim(strings.TrimSpace(part), `"'`); s != "" {
			out = append(out, s)
		}
	}
	if len(out) == 0 {
		t.Fatal("SETTLE_CURRENCIES parsed as empty")
	}
	return out
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// ── Live chain check ─────────────────────────────────────────────────────────

const (
	decimalsSelector = "0x313ce567"
	symbolSelector   = "0x95d89b41"
)

// TestRegistryDecimalsMatchChain reads each token's own decimals() and symbol()
// from Arc and compares them to what this table claims.
//
// The token contract is the only real authority here. Everything else -- this
// table, the SDK's, a listing page -- is a copy of it, and a copy is exactly
// what drifts.
//
// Skips rather than fails when the RPC cannot be reached at all, because a
// flaky public endpoint is not a currency bug and should not block a merge.
// A reachable RPC that disagrees is always a failure. Set CONDUIT_REQUIRE_CHAIN=1
// to turn the skip into a failure, for a release check that must not pass
// silently.
func TestRegistryDecimalsMatchChain(t *testing.T) {
	rpc := os.Getenv("ARC_RPC")
	if rpc == "" {
		rpc = "https://rpc.testnet.arc.network"
	}
	mustRun := os.Getenv("CONDUIT_REQUIRE_CHAIN") != ""

	client := &http.Client{Timeout: 15 * time.Second}

	for _, info := range registry {
		info := info
		t.Run(info.Symbol, func(t *testing.T) {
			decHex, err := ethCall(client, rpc, info.Token, decimalsSelector)
			if err != nil {
				if mustRun {
					t.Fatalf("%s: decimals() call failed: %v", info.Symbol, err)
				}
				t.Skipf("Arc RPC unreachable (%v) — not a currency failure, skipping. "+
					"Set CONDUIT_REQUIRE_CHAIN=1 to require this check.", err)
			}

			onChain, err := hexToInt(decHex)
			if err != nil {
				t.Fatalf("%s: could not decode decimals() response %q: %v", info.Symbol, decHex, err)
			}
			if onChain != info.Decimals {
				t.Errorf("%s (%s) at %s reports %d decimals on-chain, the registry says %d.\n"+
					"Every amount for this currency is wrong by a factor of 10^%d.",
					info.Symbol, info.ISO, info.Token, onChain, info.Decimals, abs(onChain-info.Decimals))
			}

			// symbol() is a weaker signal -- testnet issues carry a "dev" prefix
			// (devCHFAU for CHFAU), so this checks containment rather than
			// equality. It catches the address pointing at an entirely different
			// asset, which is the failure worth catching here.
			symHex, err := ethCall(client, rpc, info.Token, symbolSelector)
			if err != nil {
				return // decimals is the load-bearing check; symbol is corroboration
			}
			sym := decodeABIString(symHex)
			if sym != "" && !strings.Contains(strings.ToUpper(sym), strings.ToUpper(info.Symbol)) {
				t.Errorf("%s at %s reports symbol %q on-chain — this address may be a different token entirely",
					info.Symbol, info.Token, sym)
			}
		})
	}
}

func ethCall(client *http.Client, rpc, to, data string) (string, error) {
	payload, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "eth_call",
		"params": []any{map[string]string{"to": to, "data": data}, "latest"},
	})

	var lastErr error
	// Arc's public endpoint rate-limits and occasionally drops connections.
	// Retry before concluding anything, so a flaky call is not read as drift.
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt) * 500 * time.Millisecond)
		}
		resp, err := client.Post(rpc, "application/json", bytes.NewReader(payload))
		if err != nil {
			lastErr = err
			continue
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			lastErr = err
			continue
		}
		var out struct {
			Result string `json:"result"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(body, &out); err != nil {
			lastErr = fmt.Errorf("non-JSON response: %s", truncate(string(body), 120))
			continue
		}
		if out.Error != nil {
			lastErr = fmt.Errorf("rpc error: %s", out.Error.Message)
			continue
		}
		if out.Result == "" || out.Result == "0x" {
			lastErr = fmt.Errorf("empty result — no contract at %s?", to)
			continue
		}
		return out.Result, nil
	}
	return "", lastErr
}

func hexToInt(hex string) (int, error) {
	n, err := strconv.ParseInt(strings.TrimPrefix(hex, "0x"), 16, 64)
	if err != nil {
		return 0, err
	}
	return int(n), nil
}

// decodeABIString decodes an ABI-encoded dynamic string: [offset][length][data].
// Returns "" on anything unexpected, since this is corroboration rather than
// the load-bearing assertion.
func decodeABIString(hex string) string {
	data := strings.TrimPrefix(hex, "0x")
	if len(data) < 128 {
		return ""
	}
	length, err := strconv.ParseInt(data[64:128], 16, 64)
	if err != nil || length <= 0 || len(data) < 128+int(length)*2 {
		return ""
	}
	raw := data[128 : 128+length*2]
	out := make([]byte, 0, length)
	for i := 0; i+1 < len(raw); i += 2 {
		b, err := strconv.ParseUint(raw[i:i+2], 16, 8)
		if err != nil {
			return ""
		}
		out = append(out, byte(b))
	}
	return string(out)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
