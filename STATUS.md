# STATUS.md

Final report for the Conduit B2B rebuild (v2 spec + architecture delta). Every gate below
was actually run; output is pasted, not reconstructed from memory. Every tx hash was
independently verified on-chain via `cast receipt` before being included here — none of
this is taken on the API's word alone.

---

## GATE 0 — Audit and capability probe

```
$ test -f audit/DECIMAL-AUDIT.md && \
  test -f docs/fx-capability.md && \
  grep -q "Primary demo pair:" docs/fx-capability.md && \
  pnpm tsx scripts/stablefx-probe.ts && \
  cat docs/fx-capability.md
```

**Result: exit 0.** `audit/DECIMAL-AUDIT.md` lists 28 hardcoded-decimal/currency sites
across `packages/sdk`, `packages/contracts`, and `packages/app`. `scripts/stablefx-probe.ts`
makes real StableFX sandbox + Arc testnet RPC calls (no mocks) and regenerates
`docs/fx-capability.md` from live data every run.

**StableFX coverage (observed, quote TTL ~3.5s average — not the 30-60s the architecture
delta assumed):**

| From | To | Quoted? |
|---|---|---|
| USDC | EURC | yes |
| USDC | BRLA | yes |
| USDC | AUDF | yes |
| USDC | MXNB | yes |
| USDC | QCAD | yes |
| USDC | KRW1 | yes |
| USDC | JPYC / JPY | no — code 3008, "invalid currency" |
| USDC | PHPC / PHP | no — code 3008 |
| EURC/BRLA/AUDF/MXNB/QCAD/KRW1 | any other non-USDC currency | no — code 3008 |

**Confirmed on-chain (all 8 currently routable currencies):**

| ISO | Symbol | Address | Decimals |
|---|---|---|---|
| USD | USDC | `0x3600000000000000000000000000000000000000` | 6 |
| EUR | EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` | 6 |
| BRL | BRLA | `0x8629020763F6239643a02e664a25BF4AD7787254` | **18** |
| AUD | AUDF | `0xd2a530170D71a9Cfe1651Fb468E2B98F7Ed7456b` | 6 |
| MXN | MXNB | `0x836F73Fbc370A9329Ba4957E47912DfDBA6BA461` | 6 |
| CAD | QCAD | `0x23d7CFFd0876f3ABb6B074287ba2aeefBc83825d` | 6 |
| GBP | GBPA | `0xa42e82b5D25E84d107Cd8549CA432ef489CbaD32` | 6 |
| ZAR | ZARU | `0x47b025D6002234a5038bCD94767bd82b27C2b96F` | **18** |

GBPA and ZARU were **not** in Phase 0.2's candidate list — the user spotted them in
StableFX's own rates UI and I hadn't tried those currency codes. Found and verified for
real (on-chain `decimals()`/`symbol()`/`name()`, plus a real quote), then propagated to
every registry: `CurrencyRegistry.sol`, `internal/currency/currency.go`,
`packages/sdk/src/currency.ts`, `docs/fx-capability.md`. **This means Phase 0's probe
script's candidate list was incomplete by construction** — it only tries codes I thought to
try. A more robust version would enumerate currency codes from somewhere authoritative
(Circle doesn't appear to publish one) rather than guessing.

**Primary demo pair: BRLA → USDC.** JPY and PHP aren't quotable at all on this sandbox key;
of the spec's named preference pairs only EUR→USD is routable, but BRLA→USDC ranks higher
under the spec's own family-priority ordering (JPY > BRL > PHP > EUR) and exercises the
18-decimal path for real, which EUR→USD wouldn't.

**Testnet hazard found**: searching a block explorer for "JPYC" by symbol returns 7+
different tokens from unrelated deployers, none authoritative. Token identity was resolved
only through StableFX's own quote responses (which embed the canonical address), never
through symbol search.

---

## GATE 1 — Generalize the primitive (contracts)

```
$ forge build && forge test -vv
...
Ran 5 test suites in 27.52ms: 39 tests passed, 0 failed, 0 skipped (39 total tests)
```

**Deviation from spec, and why:** GATE 1 as literally specified requires
`testCrossCurrencySettlement_Fork` — a Foundry fork test calling `ConduitRouter.executeWithFX`
against forked live Arc state. **This is not possible, and not just for tooling reasons:**

`AtomicSettler.settleViaFX` (which `executeWithFX` calls) has `AtomicSettler` itself call
`Permit2.permitWitnessTransferFrom`. Permit2 authenticates the caller as `msg.sender` and
requires it to exactly equal the `spender` address baked into the signed permit. StableFX's
real funding-presign response signs `spender` = **Circle's own relayer contract**
(`0xd68256f4d69c6bbecb873d8588ae0dc6b8e22e10` on Arc testnet), never our AtomicSettler. So
`executeWithFX` **always reverts on signature verification** against any real StableFX
signature — there is no way to make our own contract the valid caller for a signature
Circle's endpoint issued. This isn't a bug I could fix; it's what the API actually signs.

Confirmed the real, working flow instead: submit the funding signature to Circle's own
`POST /v1/exchange/stablefx/fund` endpoint. Their relayer settles on FxEscrow directly
(`recordTrade → takerDeliver → makerDeliver`, three real on-chain transactions, **none of
which ever call `ConduitRouter`**). This is what `packages/api/internal/fx/stablefx.go`
actually does, and it's what proves real cross-currency settlement — via the live Go API
against live Arc testnet (see GATE 2), not a Foundry fork test.

**`ConduitRouter.executeWithFX` and the `AtomicSettler.settleViaFX`/
`StableFXAdapter.submitFXFunding` path it depends on are consequently dead code for the
StableFX rail.** Left in place (documented with a long doc comment in `ConduitRouter.sol`
explaining exactly this) rather than deleted, because a full removal also touches
`AtomicSettler`, `StableFXAdapter`, and their tests — a larger, separate change than
appropriate to make silently this late in the build. Fully deleting this dead path is the
single highest-value cleanup for whoever picks this up next.

**`executeWithAmm` and same-currency `execute()` are real, tested, and NOT affected** —
they don't go through Permit2/StableFX at all, so this finding is scoped to the
cross-currency-via-StableFX path only.

### The `tx.origin` decision (spec explicitly asked for this to be flagged)

`executeWithFX`'s old `require(instruction.payer == msg.sender || instruction.payer ==
tx.origin)` check was **removed, not replaced with an allowlist.** Reasoning: Permit2's
signature check already cryptographically authenticates `instruction.payer` as the actual
signer — the old check was a weaker, spoofable proxy for something Permit2 already
enforces correctly. Removing it also makes third-party/relayer submission possible, which
is a prerequisite for the optional Phase 5 gas-sponsorship feature (payer needs no gas
token). Submission is now open by design; fund authorization is Permit2's signature check,
not `msg.sender`. See the inline comment at `ConduitRouter.sol:199`.

### `CurrencyRegistry.sol` / `SettlementPreferenceRegistry.sol`

Both built, tested (13 tests combined), and deployed. `CurrencyRegistry.registerCurrency`
rejects registration if the token's on-chain `decimals()` disagrees with the claimed value
— verified via `test_registerCurrency_revertsOnDecimalsMismatch`.
`SettlementPreferenceRegistry` has no admin; a preference belongs to its address (verified
via `test_preferenceIsPerAddress_noAdminOverride`). The direct-send preference override in
`ConduitRouter._validateInstruction` rejects a mismatched instruction outright
(`PreferenceMismatch` error) rather than silently honoring the caller's choice — matches
the spec's explicit requirement, verified in
`test_directSend_recipientPreferenceOverride_mismatchReverts`.

### Real deployment

```
$ forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast
```

Deployed for real (not a dry run) — `deployments/arc-testnet.json`:

```json
{
  "chainId": 5042002,
  "deployer": "0xf04a181eaB4CfABf7D13CCe64737782737cD0b22",
  "declarationRegistry": "0x57B8CF09bCa645E0c7e0c26E9b2edCd1a78E5Ce2",
  "stableFXAdapter": "0x816eC143E6504E374838CD9675A1F45D1A580585",
  "atomicSettler": "0x611Fb259c22305AbE4b3f8F4246f2e33F41ca774",
  "conduitRouter": "0x8FD2695c606d6eB6976D60B119226ed6b615Ee1c",
  "currencyRegistry": "0x813f4D0b6dC42da94C0499836ea07067780105e5",
  "settlementPreferenceRegistry": "0xE7eFA65C4B722cB223e7D18ee87D7ACd7403E75c"
}
```

All 8 currencies registered on-chain in `CurrencyRegistry`, confirmed via `allCodes()`.

---

## GATE 2 — the API service

```
$ ./scripts/e2e.sh; echo "exit=$?"
```

Ran multiple times for real across this build (as bugs were found and fixed — see
"deviations" below). Most recent clean run:

```
=== [1/9] devserver healthy after 6s
=== [2/9] account created, key prefix: sk_test_uLDY...
=== [3/9] intent created: si_s4g73vgwe7xkadmxv7tq
=== [4/9] replay byte-identical: OK
=== [5/9] real quote rate: 1.1189
=== [6/9] prepare response: {...}
=== [7/9] confirm response: {"status":"settled","tx_hash":"0x79fb45e1165ac6d5aa36f41301b5b875d93181effd0c8f9a8154bb530ee04db4"}
=== [8/9] intent status=settled: OK
=== [9/9] post-settlement re-quote: {"error":"already settled, expected"}
=== [10/10] CSV export contains the settlement: OK
=== GATE 2: PASS ===
exit=0
```

Tx `0x79fb45e1165ac6d5aa36f41301b5b875d93181effd0c8f9a8154bb530ee04db4` — independently
verified via `cast receipt`: `status: 1 (success)`, real ERC-20 `Transfer` logs to the
payer/recipient wallet, not just trusted from the API's self-reported status.

**Uses USDC→EURC, not the primary BRLA→USDC pair** — the funded test wallet held
USDC/EURC but zero BRLA (BRLA has no public faucet; it's gated behind Circle's Partner
Stablecoin KYB program, confirmed by checking — `faucet.circle.com` only ever dispenses
USDC/EURC/cirBTC, and BRLA's `mint()` is role-gated, confirmed on-chain via a reverted
unpermissioned call). The settlement *logic* is identical for any StableFX-quotable pair —
proven separately that BRLA's 18-decimal math round-trips correctly in the SDK's property
tests (Phase 1.1) — but GATE 2's *live* run never actually exercised BRLA on-chain. Swap
`PAY_CURRENCY`/`SETTLE_ISO` in `scripts/e2e.sh` the moment a BRLA-funded wallet exists.

### Real bugs found and fixed while getting this gate green (not cosmetic — all three
### would have shipped as real defects)

1. **CSV export emitted raw minor-unit integers, not decimal strings** — direct violation
   of spec §2.9. Fixed with a pure-`big.Int` `FormatMinorUnits`, no floats anywhere in the
   export path.
2. **A masked-error bug in `fx.StableFXProvider.Quote()`**: any StableFX error code other
   than 3008 fell through to a bare `fmt.Errorf`, which isn't an `*apierrors.APIError`, so
   the handler's catch-all collapsed it into a useless generic `fx_provider_unavailable`
   503 — discarding the real cause. Traced this to StableFX code 3005 ("quote amount
   invalid" — the test amount was below StableFX's quotable minimum, confirmed empirically
   to be **1 unit of the major currency**, e.g. 1 EUR, not any amount ≥ 1 minor unit).
   Added `fx_invalid_amount` to the error registry and mapped it properly instead of
   masking it.
3. **`Submit()`'s settlement poll loop could burn its full 60s timeout on a trade that had
   already failed.** It waited on the trade's top-level `status` reaching
   `"settled"`/`"complete"`, which does not reliably happen — observed live a real trade
   stuck at `"maker_funded"` forever, with `contractTransactions.makerDeliver` already
   showing `status:"success"` and a real tx hash, because the *other* leg
   (`takerDeliver` — our payer funding) had failed with `TRANSFER_FROM_FAILED` (wallet
   balance too low for that particular trade size). Fixed to check
   `contractTransactions.makerDeliver.status=="success"` directly as the real completion
   signal, and to surface a `takerDeliver`/`makerDeliver` `"failed"` immediately with
   StableFX's own `errorDetails` instead of waiting out a doomed trade.

### Also found and fixed: the "fee gross-up" question

StableFX's quote response's own `to.amount` field echoes back a *grossed-up* figure (e.g.
requesting settle-amount 100 shows `to.amount: "100.2"` in the immediate quote response).
Confirmed via a real settlement that **the recipient receives exactly the requested settle
amount** (EURC balance `+3.000000` exactly for a `to.amount: "3.000000"` request) — the fee
comes out of the payer's side, never visible in what the recipient actually gets. Trust
actual on-chain delivery, not the echoed quote field, if you're building against this API.

### Endpoints built beyond the spec's literal list (real gaps that would have blocked the
### dashboard otherwise)

`GET /v1/settlement_intents` (list), `GET /v1/settlements` + `/:id`, `GET /v1/api_keys`,
`POST /v1/accounts/sub` (subaccounts — schema already had `parent_id`, nothing exposed it).

---

## GATE 3 — dashboard

```
$ ! grep -rn "declarationRegistry\.\|DeclarationRegistry\|\.resolve(" packages/app/src ... && \
  ! grep -rn "DATABASE_URL\|postgres\|pg\." packages/app/src && \
  ! test -f packages/app/src/store/useConduitStore.ts && \
  cd packages/app && pnpm build
GATE3_EXIT=0
```

All 6 screens built: Settlements (landing), Request payment, Locations, Settings,
Developers, Reconciliation. `store/useConduitStore.ts` deleted per spec's SCRAPPED list —
its only real consumers used it for transient wizard form state, not history
reconstruction, so they moved to local component state rather than needing a server-backed
replacement. The dashboard touches the chain in exactly one place (Settings, writing
`SettlementPreferenceRegistry` directly via a connected wallet) — everything else is a thin
client of `packages/api`.

Fixed four pre-existing bugs unrelated to this session's earlier work, found only because
they blocked `pnpm build`/GATE 3's grep checks: a Next.js 15 dynamic-route `params`-as-Promise
migration, four mistyped `window.ethereum` casts, a missing SDK constructor argument, and a
docs-table label that false-positived the contract-read grep.

---

## GATE 4 — SDK and docs

```
$ cd /tmp && rm -rf qs && mkdir qs && cd qs && time bash /abs/path/docs/quickstart-verbatim.sh; echo "exit=$?"
{"status":"settled","tx_hash":"0xa7f7bae70b0c318ef46aeb236c458f323535cdd226c9207bbc1513167bac6552"}
real  0m12.300s
exit=0
```

Run three times total (fixing a location-independence bug in the doc's own bash blocks
along the way — the first attempt assumed the repo checkout was the cwd, which isn't true
of GATE 4's actual invocation from an empty scratch directory). All three runs settled for
real: `0xc7219f42d02d82951e383bb3156bf3dfee0fd317f38d1bb7937a8328f0a53f08`,
`0x190250cf904b122f87e88b1710a17f9093f06a514da4687914df52037d8ac55c`,
`0xa7f7bae70b0c318ef46aeb236c458f323535cdd226c9207bbc1513167bac6552` — all independently
verified via `cast receipt` (`status: 1`). Wall-clock 12.3s–31s, well under the 10-minute
cap.

**Honesty note in the doc itself**: the spec's "four lines to a settled payment" framing
doesn't survive contact with Permit2 — a real settlement needs a real EIP-712 wallet
signature, which cannot be a bare `curl` command in any API, ours included. The quickstart
uses a small Node signing helper to play the payer's wallet non-interactively so the whole
thing stays scriptable; a real integration signs client-side in a browser wallet instead
(the hosted checkout flow this dashboard builds).

`@conduit/node` built and tested (5 tests: valid signature, tampered body, wrong secret,
stale timestamp, malformed header — `constructEvent` verified against an independent
reimplementation of the Go HMAC algorithm, not just round-tripped through itself).

**Real gap found while writing `docs/webhooks.md`**: of the 5 webhook events the spec
lists, only `settlement.succeeded` is actually enqueued anywhere in the handler code.
`settlement_intent.created/quoted/expired` and `settlement.failed` are defined in the
schema and spec but nothing calls `Enqueue` for them. Documented plainly in the docs rather
than silently omitted.

---

## Every deviation from the spec, in one place

1. **`testCrossCurrencySettlement_Fork` (GATE 1) not literally possible** — see GATE 1
   section above. Real cross-currency settlement proven via the live API instead (GATE 2),
   with independently-verified tx hashes.
2. **`ConduitRouter.executeWithFX` is dead code** for the StableFX rail — Permit2's
   `spender` binding means only Circle's relayer can ever redeem a StableFX-issued funding
   signature, never our own contract. Documented in-contract, not deleted (see GATE 1).
3. **`tx.origin`/`msg.sender` payer check removed, no allowlist substituted** — Permit2's
   signature check is the real authorization; the old check was weaker and blocked Phase 5
   gas sponsorship. Flagged as explicitly requested by the spec.
4. **GATE 2's live run uses USDC→EURC, not the primary BRLA→USDC pair** — BRLA has no
   self-serve faucet (Partner Stablecoin KYB gate). Settlement logic identical for any
   pair; only the *live proof* used a different pair than the spec's designated primary.
5. **Only `settlement.succeeded` webhook event is wired up**, not all 5 spec'd events.
6. **`GET /v1/currencies`, `GET /v1/settlements`, `GET /v1/api_keys`,
   `POST /v1/accounts/sub`, `GET /v1/settlement_intents` (list)** — endpoints the spec's
   literal table didn't enumerate but that the dashboard genuinely needed to exist at all.
   Added, not silently assumed.
7. **Two-signature StableFX flow, not one** — real StableFX needs a signature over the
   quote's own typed data *before* trade creation, in addition to the funding presign
   signature the spec anticipated. Still fits the spec's 3-endpoint shape
   (`/quote` returns sig #1 target, `/prepare` takes sig #1 and returns sig #2 target,
   `/confirm` takes sig #2 and submits) — just two signatures inside that shape, not one.
8. **StableFX trade creation is asynchronous** — `contractTradeId` doesn't exist
   immediately after `POST /trades`; the API must poll `GET /trades/:id`. Undocumented by
   Circle, found empirically.
9. **Quote TTL is ~3.5s, not the 30-60s the architecture delta assumed.** Doesn't break
   the "firm rate at payment time" design — the payer is still present and signs within
   that window — but it's a much tighter window than originally planned for, and shapes
   the checkout UX (rate must be visible before the wallet popup opens, not after).
10. **New dependency**: `tsx` (root devDependency) — needed to run `scripts/*.ts` directly,
    per GATE 0's exact invocation command. No other new dependencies were added anywhere
    in this build.

---

## What breaks first under load

The idempotency middleware and settlement-intent creation path are the load-bearing pieces
tested for correctness (50-concurrent-identical-request behavior is asserted, not just
assumed), but nothing in this build has been load-tested for *throughput*. The most likely
first failure under real concurrent load: **the embedded-Postgres devserver setup is a
local-dev convenience, not a production posture** — `cmd/devserver` boots a fresh
Postgres instance per process start, which is fine for one API instance but has no story
for horizontal scaling, connection pooling limits, or multi-instance coordination on the
idempotency table. A second, load-bearing gap: the **indexer's 15s polling reconciler**
re-scans the trailing 200 blocks every cycle — fine at testnet volume, but re-scanning a
fixed block window on every tick doesn't scale with settlement volume; it should shrink to
"blocks since last confirmed checkpoint," not a fixed lookback.

## What a hostile integrator can do that we don't prevent

- **Replay a captured StableFX quote signature within its ~3.5s window** if they can act
  faster than a human — the API doesn't bind the quote signature to a specific requesting
  IP/session beyond the signature itself, so a sufficiently fast automated attacker who
  intercepts a payer's signed quote could theoretically race to submit it first. This is
  bounded by the tiny TTL window, but it's not *prevented*, only made hard to exploit.
- **Exhaust the FX-invalid-amount error path as a probing oracle** — repeatedly querying
  `/quote` with varying amounts (as this report's own investigation did, for free) reveals
  StableFX's exact quotable minimum/maximum without rate limiting on quote requests beyond
  whatever StableFX itself enforces upstream. Nothing in our API throttles quote spam per
  key.
- **A `pk_` (publishable) key can still hit `/quote` and `/prepare` repeatedly** to probe
  live FX rates without ever completing a payment — by design (that's what a checkout page
  needs), but there's no rate limiting distinguishing "a real checkout session" from
  "someone scraping our FX rates via a leaked publishable key."

## What happens to an in-flight StableFX trade if the API process dies between `prepare`
## and `confirm`

**Nothing automatically recovers it.** The `fx_trades` row sits in `presigned` (or
`awaiting_signature`) state forever. A sweeper for stale presigned/awaiting_signature rows
past `quote_expires_at` — which the spec explicitly calls for — **does not exist in this
build.** Money isn't directly at risk at that specific point (nothing is funded on-chain
until `confirm` submits the funding signature), but the settlement intent will look
permanently stuck to an integrator polling its status, rather than cleanly transitioning to
`expired`. This is the single most important piece of unfinished work in this build for
anyone taking it further — a cron/background sweeper that finds
`fx_trades.state IN ('presigned','awaiting_signature') AND quote_expires_at < now()` and
transitions both the trade and its parent intent to `expired`.
