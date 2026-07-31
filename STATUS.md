# STATUS.md

Final report for the **CONDUIT — Product Split, Auth, Lifecycle & UI Sharpening** spec
(phases 0–8 + this report). Every gate below was actually run; outputs are pasted from
real runs, not reconstructed. Where a gate's non-bash step needed a human (screenshots,
live OTP), that is disclosed, not simulated. The previous spec's STATUS.md (B2B rebuild
v2) is preserved in git history at commit `a44eee7`.

Phase commits, all pushed to `main`:
`edaa7c8` (0) · `a20a5c7` (1) · `cae7fe6` + `2f7f0f4` (2) · `74cc115` (3) · `7025441` (4)
· `742e29b` (5) · `55d4019` + `722bfb5` (6) · `0e71933` (7) · `d93351b` (8).

---

## GATE 0 — Bridge-scrap audit

```
$ test -f audit/BRIDGE-SCRAP.md && \
  grep -q "keep-and-generalize\|KEEP-AND-GENERALIZE\|keep and generalize" audit/BRIDGE-SCRAP.md && \
  grep -qi "bridge_transfers" audit/BRIDGE-SCRAP.md
```

**Result: exit 0** (re-verified 2026-07-31: `GATE0_EXIT=0`). `audit/BRIDGE-SCRAP.md`
inventories the raw-CCTP bridge and rules **keep-and-generalize** for the
`bridge_transfers` state machine + reconciler (chain-agnostic by design), scrap for the
Solana-typed burn path.

## GATE 1 — Chain-agnostic FundingProvider (Circle Gateway / UBK)

```
$ cd packages/api && go build ./... && \
  ! grep -rn "solanago\|solana-go" internal/ | grep -v "_test.go\|// " && \
  go test ./internal/... -run TestFundingProviderStateMachine
```

**Result: build + tests exit 0; the middle grep clause fails by design — this is the
one gate whose literal text was knowingly deviated from, resolved with the project
owner at the time (Phase 1), not silently.** The grep cannot distinguish "Solana types
in the *interface*" (forbidden) from "Solana types in a chain-specific *implementation*
behind the generic interface" (explicitly allowed by the same gate's prose: "If a Solana
signing branch remains, it's an implementation detail behind the generic interface").
As built:

- `internal/bridge/provider.go` — the `FundingProvider` interface: **zero** Solana
  types. Payer addresses are opaque strings, balances are `map[uint32]*big.Int` by
  Gateway domain.
- `internal/bridge/gateway.go` — the Solana `GatewayProvider` implementation; this is
  the only place `solana-go` appears (needed to build the real deposit transaction and
  derive PDAs — Solana's native tx format doesn't disappear because the API above it
  is generic).

Re-run 2026-07-31: `go build ./...` exit 0;
`go test ./internal/... -run 'TestFundingProviderStateMachine|…'` → `ok … internal/bridge`,
`ok … internal/server 61.909s` (real embedded Postgres, no mocks).

**Beyond the gate:** the full funding flow was proven **live** in Phase 1 — real Solana
devnet deposit → real Gateway balance → real signed burn intent → real
`POST /v1/transfer` → Circle's own relayer (`0xeA14…`) minting 500000 minor units
(0.5 USDC) on Arc, confirmed via `cast receipt` (status 1), not the API's word.
Full byte-exact encoding + tx hashes: `docs/ubk-capability.md`.

## GATE 2 — Privy merchant auth

```
$ cd packages/app && pnpm build && \
  grep -rq "@privy-io/react-auth" src && \
  grep -rq "useLoginWithEmail\|PrivyProvider" src && \
  ! grep -rn "getApiKey\|setApiKey" src/app/dashboard/layout.tsx
```

**Result: exit 0** (grep clauses re-verified 2026-07-31: `GATE2_GREPS_EXIT=0`; the
build is the same `pnpm build` that passed GATE 8 below, exit 0, 15/15 routes).
**Manual steps done live by the project owner:** unauthenticated `/dashboard` → Privy
login modal; real email OTP completed → dashboard; Google login also enabled and used
(bypasses OTP); modal confirmed dark with the `#B2F55A` green accent, not default
purple; `/pay` confirmed to need no login.

## GATE 3 — Payment-link lifecycle

```
$ cd packages/api && go build ./... && \
  go test ./internal/... -run 'TestLinkLifecycle|TestSingleUse|TestExpiry|TestVoid|TestAmountBounds'
```

**Result: exit 0** (re-run 2026-07-31 together with GATE 1's tests: `GO_EXIT=0`,
`ok github.com/kzn-labs/conduit/api/internal/server 61.909s`). Tests run against a real
embedded Postgres and prove, server-side: single-use double-payment rejected
(atomic-claim race included), expired-link payment rejected, void-link payment rejected,
out-of-bounds open amount rejected.

## GATE 4 — Recipient identity

```
$ cd packages/app && pnpm build && \
  grep -rq "display_name\|displayName" src/app/pay && \
  cd ../api && go build ./...
```

**Result: exit 0** (re-verified 2026-07-31: `GATE4_GREP_EXIT=0`; app build via GATE 8,
Go build via GATE 1 re-run). **Confirmed in writing:** the `/pay` page leads with the
merchant's business name (+ logo when set) from the public endpoints' JOIN on
`accounts`; the raw settle address is secondary detail, never the headline.

## GATE 5 — Balance-aware payer + honest bridge UI

```
$ cd packages/app && pnpm build && \
  ! grep -rn "atomic\|instant" src/app/pay src/components/PayFlow && \
  ! grep -rn "YOU PAY WITH" src/components/PayFlow
```

**Result: exit 0** (re-verified 2026-07-31: `GATE5_GREPS_EXIT=0`; build via GATE 8).
The static nine-currency "you pay with" grid is gone from the payer flow — and, caught
by the owner after Phase 6, also from the homepage Direct Send flow (`722bfb5`,
`SendFlow/PayerCurrencyPicker.tsx`: one wagmi `useReadContracts` multicall of real
`balanceOf` across all Arc tokens; shows only what the wallet holds). Screenshot step:
I have no browser tool — the balance-aware step and mid-funding bridge flow render from
polled API state by construction; visual confirmation was done live by the owner where
noted, and remains open where not.

## GATE 6 — UI sharpening

```
$ cd packages/app && pnpm build && \
  grep -rq "@web3icons/react" src && \
  ! grep -rn "rounded-xl\|rounded-full\|rounded-lg\|shadow-\|blur-" src | grep -v "rounded-none" && \
  ! grep -rn "text-white\|bg-black" src/app src/components
```

**Result: exit 0** (re-verified 2026-07-31: `GATE6_GREPS_EXIT=0`; build via GATE 8).
Token icons via `@web3icons/react` v4.1.19 (`TokenIcon` from `/dynamic`, mono variant),
with a monogram fallback for exotic tickers (BRLA/QCAD/KRW1/ZARU/AUDF/MXNB/GBPA). No
rounded corners, shadows, blurs, or raw white/black utilities anywhere in app source.

### Grid bleed — before/after (the honest version)

- **Before:** gridlines visibly crossed text and panels everywhere (owner's screenshot).
- **Phase 6's fix was the wrong diagnosis.** The spec assumed panels were "too dark to
  occlude the grid." Lifting `--surface` `#0C0D0A → #141712` and `--border` improved
  card definition but **could not** stop the bleed.
- **Real cause (found post-Phase-6, owner-reported):** CSS paint order. `.conduit-grid`
  was `position: fixed; z-index: 0`, and a positioned element at z-index 0 paints
  **above** all normal-flow content — the grid was drawing on top of every glyph
  regardless of panel color.
- **Real fix (`722bfb5`):** one line — `.conduit-grid { z-index: -1 }`. The grid now
  paints over the body background but strictly behind all content: lines pass behind
  glyphs like ink on graph paper, never across them. Surface lift kept as a genuine
  (separate) improvement.

## GATE 7 — README + docs truth pass

```
$ cd "$(git rev-parse --show-toplevel)" && \
  ! grep -rin "agent payment protocol\|x402" README.md && \
  grep -qi "payer\|merchant" README.md && \
  cd packages/docs && pnpm build
```

**Result: exit 0** (run 2026-07-31: `GATE7_EXIT=0`; docs build `✓ Generating static
pages (14/14)`, including the new `/guides/payment-links` route). README rewritten
around the two-surface product with the honest Circle-vs-Conduit mechanics;
`docs/payment-links.md` added and registered in both the guides index and slug loader.
The two `docs/cctp-*.md` files are historical raw-CCTP records (superseded by
`docs/ubk-capability.md`) kept for tx-hash provenance; they are not in SLUGS and don't
render.

## GATE 8 — Cross-surface coherence

```
$ cd "$(git rev-parse --show-toplevel)" && \
  ! grep -rn "@privy-io" packages/app/src/app/pay && \
  cd packages/app && pnpm build
```

**Result: exit 0** (run 2026-07-31: `GATE8_EXIT=0`). Grep: zero matches — `@privy-io`
exists only in `src/app/dashboard/layout.tsx` and
`src/app/dashboard/dashboard-privy-provider.tsx`; root providers are wagmi +
react-query only. Build output (tail):

```
 ✓ Generating static pages (15/15)
└ ƒ /pay/[declarationId]                 73.6 kB         543 kB
+ First Load JS shared by all             135 kB
GATE8_EXIT=0
```

Full coherence writeup (auth boundary, shared design tokens, end-to-end flow with
per-step verification provenance): `audit/PHASE8-COHERENCE.md`.

---

## UBK / Gateway — what is actually used

- **Package verified:** `@circle-fin/unified-balance-kit` **1.3.1**, inspected from the
  real npm tarball (`npm pack`), not docs summaries. The Go API talks to the underlying
  **Gateway REST API directly** (`https://gateway-api-testnet.circle.com`):
  `GET /v1/info`, `POST /v1/balances`, `POST /v1/transfer`, `GET /v1/transfer/{id}`.
- **Source chains with real Gateway support (testnet), as probed from the package's
  chain registry:** EVM chains with `gateway` blocks (Ethereum Sepolia, Base Sepolia,
  Avalanche Fuji, and peers), **Solana devnet (domain 5)** — the implemented source —
  and **Sui** (domain 8) present in the registry. **Arc is domain 26** with real
  `gateway.contracts.v1.{wallet,minter}` — a forwarder-supported destination, so
  Circle's relayer submits the Arc mint itself.
- Burn intents on Solana are **off-chain ed25519-signed messages** with a byte-exact
  layout (16-byte `0xff…00` domain prefix + magic-tagged fields — see
  `docs/ubk-capability.md`), not on-chain transactions.

## Privy auth model as built

- Login: Privy modal, email OTP or Google, `@privy-io/react-auth` 3.36.0. Embedded
  EVM wallet auto-created on first login (`ethereum.createOnLogin`, with a
  `useCreateWallet()` fallback for the creation race).
- Server: ES256 access-token JWTs verified against a **static PEM public key** from the
  Privy dashboard (not JWKS), `golang-jwt/jwt/v5`.
- **Login wallet vs settle address are separate fields.** `accounts.login_wallet` is the
  Privy embedded wallet; `settle_address` *defaults* to it at account creation but is
  independently editable (`PATCH /v1/accounts/:id`) — a business can settle to a
  treasury address it never logs in with.
- `sk_`/`pk_` API keys remain the machine path; Privy is layered for humans, not a
  replacement.

## Lifecycle enforcement — what the server actually rejects

All at `POST /v1/payment_links/:id/pay`, with typed errors (not UI-only):

| Case | Enforcement | Error (HTTP) |
|---|---|---|
| Double-pay of single-use link | **Atomic** `UPDATE … WHERE status IN ('active','viewed')`; loser sees 0 rows | `payment_link_already_used` (409) |
| Pay after `expires_at` | Checked at pay time against the clock, status flipped to `expired` | `payment_link_expired` (409) |
| Pay a voided link | Status check | `payment_link_voided` (409) |
| Open amount out of bounds | `[min_amount, max_amount]` big-int comparison | `payment_link_amount_out_of_bounds` (422) |
| Open link with no amount | Required-field check | `payment_link_amount_required` (400) |
| Void an already-paid link | Status check in `Void` | `payment_link_already_used` (409) |

Covered by real Postgres-backed tests (GATE 3). Amounts are integer minor units
end-to-end (`*big.Int` / `NUMERIC(78,0)`); no floats anywhere in money paths.

## Deviations from the spec, and why

1. **GATE 1's literal grep fails while the phase passes** — see GATE 1 above. Surfaced
   to and resolved with the owner during Phase 1; the interface is genuinely
   chain-agnostic, the Solana code is implementation detail the gate's own prose allows.
2. **Screenshots (GATEs 2/5/6/8 manual steps):** I have no browser tool. Every visual
   claim above is either mechanically verified (greps, token file, build) or was
   confirmed live by the owner (Phase 2 login, Phase 6 grid report → `722bfb5` fix).
   Side-by-side Phase 8 screenshots remain a human step.
3. **Phase 6 shipped the spec's assumed grid fix, which was wrong** — kept as a visual
   improvement, but the real fix was the post-phase `z-index:-1` (`722bfb5`). The spec's
   "raise the surface and re-verify" instruction could never have fixed it.
4. **Phase 5 scope initially followed GATE 5's literal grep paths** (`src/app/pay`,
   `src/components/PayFlow`) and missed the homepage Direct Send static grid — owner
   caught it; fixed in `722bfb5`.
5. **`docs/cctp-*.md` kept, not deleted** (Phase 7): historical tx-hash provenance;
   unreferenced by the docs site.
6. **STATUS.md replaces the previous spec's report** — old version preserved in git
   history (`a44eee7`), matching the established one-report-per-spec convention.
7. **JPY/PHP not quotable** on the current StableFX key (error 3008) — documented as
   re-probe-able coverage, not routed around or faked.

## What breaks first under load

1. **StableFX quote TTL (~3.5s observed)** — under any queueing/latency, quotes expire
   between quote and fund; payers see re-quote loops. First user-visible failure.
2. **Payer-side polling** (`bridge/status`, trade status) is per-client HTTP polling
   against the API, which itself polls Circle — N concurrent payers multiply upstream
   calls; Circle rate limits would surface as stalled progress UIs before anything
   corrupts. No websockets/backoff coordination yet.
3. **Single Postgres pool / single API process** — the reconciler and handlers share
   one pool; embedded-postgres is dev-only, but there's no horizontal-scale story
   (no leader election for the reconciler; two instances would double-poll Circle,
   though DB state transitions stay safe because they're conditional UPDATEs).
4. **Front-end bundle** — `/pay` first load is 543 kB (Privy/wagmi/web3icons); slow
   networks feel it. Known, owner-deferred performance work.

## What a hostile payer could do that isn't prevented

- **Hold a single-use link hostage:** `pay` atomically claims the link (`status='paid'`)
  *before* funds move. A payer who calls `pay` and never funds burns the link; the
  merchant must void/reissue. Mitigation exists (merchant sees `viewed`/intent state)
  but there's no auto-release timer returning a claimed-but-unfunded link to `active`.
- **Status-flip spam:** the public endpoint flips `active → viewed` unauthenticated —
  anyone with the URL can mark it viewed. Cosmetic, but it pollutes the merchant's
  signal.
- **Poll hammering:** public `pay`/`public`/quote endpoints have no rate limiting and
  testnet-wildcard CORS; a hostile client can spend the API's Circle quota. Must be
  fixed before mainnet (also flagged in README).
- **Not possible:** paying twice on single-use (atomic claim), paying outside bounds,
  paying expired/void links, spoofing another merchant's identity on the pay page
  (identity comes from the server-side JOIN, not client input), or moving funds
  anywhere except the merchant's stored `settle_address`.

## In-flight UBK funding if the API dies mid-bridge

The burn intent is irreversible once Circle accepts it — the design assumes death at
any point:

- Every step of the funding flow is persisted in `bridge_transfers` **before** the
  side effect (state machine: deposit seen → intent signed → transfer submitted →
  mint confirmed).
- On restart, the **reconciler** scans non-terminal `bridge_transfers` rows and resumes
  exactly where a live session would: re-polls `GET /v1/transfer/{id}`, re-checks the
  Arc mint, and advances the settlement intent when the USDC lands. Orphaned deposits
  (deposit seen, process died before intent) surface as resumable rows, not lost funds.
- Because Arc is forwarder-supported, the mint does not depend on the API being alive —
  Circle's relayer completes it regardless; the API only has to *observe* and settle.
- Worst case (API down for the whole window): the payer's USDC sits in their Gateway
  unified balance / arrives on Arc, and settlement completes on the next reconciler
  pass. Funds are never stranded in a state the reconciler can't see.

---

*All phases pushed to `main` at `d93351b` + this report. Arc Testnet, chain 5042002.*
