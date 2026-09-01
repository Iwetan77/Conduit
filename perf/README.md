# Latency — measured, not assumed

`perf/latency-before.json` is the Phase B0 baseline: the median of three full
runs against the **deployed** API, real Circle sandbox, real Arc transactions.
Reproduce with:

    node scripts/latency-trace.mjs --prefix=before-r1
    node scripts/latency-trace.mjs --prefix=before-r2
    node scripts/latency-trace.mjs --prefix=before-r3
    node scripts/latency-median.mjs before perf/latency-before-r*.json

Compare a later run against it:

    node scripts/latency-compare.mjs perf/latency-before.json perf/latency-after.json

Exits non-zero if any span regressed by more than 10%.

## The baseline

| Path | Total | Dominated by |
|---|---:|---|
| Same-currency | **12.7s** | two receipt waits, 9.7s of it |
| Cross-stable | **11.1s** | `prepare` 4.5s + `confirm` 5.4s |
| Payroll leg | **13.5s** | two receipt waits, 9.8s of it |

## What the trace says that the work order did not

**1. Receipt waiting is the whole story, and it is almost exactly 4.9s every
time.** Not 4.5s, not 5.4s — 4.9s, run after run, on every path:

    same.approve_receipt      4827ms   [238, 4827, 4938]
    same.execute_receipt      4871ms   [4793, 4871, 4954]
    payroll.approve_receipt   4889ms   [4866, 4889, 4891]
    payroll.disperse_receipt  4885ms   [4860, 4885, 4888]

Arc produces blocks in about a second, so roughly four of those five seconds
are `ethers` sitting still. Its `pollingInterval` defaults to 4000ms and nothing
in this repo overrides it, which is precisely Phase B2's diagnosis — the trace
promotes it from hypothesis to the single largest cost in the product.

The variance proves it. One `approve_receipt` came back in **238ms**: that run
happened to broadcast just before a poll tick. Same code, same network, same
chain, 20x difference — the only variable is where in the 4-second cycle the
transaction landed.

**Together that is 9.7s of the 12.7s same-currency path, and 9.8s of the 13.5s
payroll leg: about 75% of both, spent waiting for a timer rather than a chain.**

**2. The API round-trip floor is 231ms, not 620ms.** The work order treats
`/healthz` at 0.62s as "the round-trip floor — TLS plus network — for every
single API call", and builds the region argument on it. Measured from here it is
231ms, and Arc's RPC is 242ms. Both are real costs and neither is the problem:
every API span in the trace is 200-700ms, so the entire API surface of a payment
is under 2s. Moving the region would buy a few hundred milliseconds against a
5-second timer.

**This does not refute the region argument, it re-scopes it.** 620ms may well be
what a Nigerian mobile client sees, and this machine is not that client. But it
does mean region cannot explain a 22s payment, because 22s was never mostly API
time.

**3. Cross-stable is 11.1s here, not 22-29s.** The two spans that matter:

    cross.post_prepare   4547ms   [4206, 4547, 6340]
    cross.post_confirm   5399ms   [4885, 5399, 5491]

`confirm` holding the browser for 5.4s is exactly what Phase B4 describes, and
it is the biggest single perceived-latency win available — but the gap between
11.1s measured and 22-29s reported is not yet explained. Candidates: the
reported figures include human signing time (the trace signs with a key in
11ms, where a person reading a wallet prompt takes seconds); they were measured
through the browser's RPC proxy rather than directly; or they predate work
already merged. **Do not treat 22s as the number to beat until it has been
reproduced through the browser.**

**4. Permit2 approval is already a one-time cost.** `cross.permit2_approve_skipped`
on runs 2 and 3 — the allowance persisted, so repeat cross-stable payments never
pay it. The same-currency path does NOT have this property: it re-approves
exactly the payment amount every time, which is what Phase B3 is about.

## What this changes about the plan

The work order's own rule is that where the trace disagrees with the document,
the trace wins. It does, twice:

- **B2 should come first, not second.** It is the cheapest change in Track B
  (`provider.pollingInterval = 500`) and it addresses ~75% of two of the three
  paths. B1's infrastructure work — region, plan tier — addresses spans that
  total under 2s.
- **B1's premise needs re-measuring before acting on it.** The 620ms figure it
  reasons from is not what this client sees. Record `/healthz` from a Nigerian
  mobile connection before moving the API region, exactly as B1 itself says to,
  because the trace cannot answer that question from here.

---

# Why a phone takes 22-29s when this trace takes 12

The baseline above was measured from a laptop, signing with a raw key, reading
Arc directly. A phone does none of those things. Each difference was measured
rather than guessed, and together they account for the gap.

## 1. Every chain read is 3.5x slower through the proxy

The browser does not talk to Arc. It talks to `POST /v1/rpc`, which relays to
Arc — so a read goes browser → Oregon → Arc → Oregon → browser, and pays the
distance twice.

    direct to Arc:        242ms   (perf/latency-before.json, floor.arc_rpc_median)
    through /v1/rpc:      850ms   (median of 5, from this machine)

A payment makes a dozen or more reads — nonce, gas estimate, fee history,
balance, allowance, then receipt polling. **At roughly 600ms of added cost each,
that alone is several seconds a phone pays and this trace does not.**

## 2. A single payment rate-limits itself

`POST /v1/rpc` sits behind the shared public limiter: `publicRatePerSecond = 5`,
`publicBurst = 20`, keyed on IP (`internal/server/ratelimit.go`).

Thirty rapid calls — the volume of one payment — measured against production:

    200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 200
    429 429 429 429 429 200 200 429 200 200 429 429 429

**Nine of thirty rejected.** Every one of those is a retry, a backoff, or a
failed read that the browser has to make again. One payer, on their own,
exhausts the bucket.

**This is the "22s for me, 29s for my friends" finding, and it is now
reproduced rather than hypothesised.** Nigerian mobile carriers use CGNAT
heavily, so several people on the same network share one IP and therefore one
bucket of 5/second. A second payer does not double the load, they halve
everybody's allowance. The work order guessed this; the numbers above are the
proof.

## 3. Signing is 11ms here and seconds on a phone

The trace signs with a raw key. A Circle wallet signs by opening Circle's UI,
taking a PIN, and completing a challenge over the network — several round trips
with a person in the middle. The trace's `cross.sign_quote` at 11ms is not what
a merchant experiences, and the quote it is racing lives about 3.5 seconds.

## What this means

**The 22-29s is explainable and most of it is ours to fix.** In rough order of
what it is worth:

| Cause | Cost | Fixed by |
|---|---|---|
| `ethers` 4s polling on receipts | ~9.7s | B2 — one line |
| RPC rate limiter rejecting a payment's own reads | seconds, unbounded | B1.3 — its own limiter |
| Proxy doubling every read | ~600ms x reads | B1.2 region, B4.3 parallelism |
| `confirm` holding the socket | 5.4s perceived | B4.2 — return 202 |
| Two transactions where one would do | ~5s | B3 |

Nothing here is a law of physics. The irreducible part is Arc's block time —
about a second per transaction, three transactions for a cross-stable
settlement through Circle's relayer. Everything else in the list is a decision
this repository made and can unmake.

---

# Phase B2 — measured

`provider.pollingInterval = 500` (`packages/app/src/lib/arc-provider.ts`,
`packages/sdk/src/client.ts`), memoised read provider, and a
`browserProviderFor` / `browserProviderFrom` factory so the twelve call sites
that constructed a `BrowserProvider` inherit it instead of each remembering.

    node scripts/latency-compare.mjs perf/latency-before.json perf/latency-after-b2.json

| Path | Before | After | |
|---|---:|---:|---|
| Same-currency | 12722ms | **6109ms** | −52% |
| Payroll leg | 13527ms | **6612ms** | −51% |

The receipts, which were the whole point:

    same.approve_receipt      4827ms → 1440ms   -70%
    same.execute_receipt      4871ms → 1428ms   -71%
    payroll.approve_receipt   4889ms → 1727ms   -65%
    payroll.disperse_receipt  4885ms → 1395ms   -71%

Well past the phase's bar of 1.5s median improvement — the smallest is 3.2s.

Cross-stable is unchanged and appears as "removed" in the comparison because
the after-run traced only the two paths this phase affects. Its cost is API and
Circle time, not receipt polling; B4 is where it moves.

## Two notes on the tooling, both of which changed a number

**`latency-compare` was crying wolf.** It first reported
`payroll.disperse_broadcast` as an 18% regression — from samples
`[823, 849, 1023]` to `[974, 999, 1005]`, which are entirely inside each other.
A median that moved is not evidence that anything changed. A regression now has
to be both over the threshold AND cleanly separated: every after-sample slower
than every before-sample. Anything else prints "(within noise)". A gate nobody
believes is a gate nobody reads.

**The trace does not tune itself by default.** `--polling=<ms>` is opt-in, so
the baseline keeps measuring what a payer experiences and an "after" run can
measure the app as it now behaves. A trace that silently applied the fix it was
measuring would report an improvement nobody could feel.

## The gate's grep, and why two lines still match

    ! grep -rn "new ethers.JsonRpcProvider\|new ethers.BrowserProvider" ... | grep -v "pollingInterval\|arc-provider.ts\|wallet-provider.ts"

Two matches remain and neither is a provider without a polling interval:

- `packages/app/src/app/docs/page.tsx:60` — inside a `<pre><code>` block. It is
  a code SAMPLE shown to users, not code that runs.
- `packages/sdk/src/client.ts:72` — a multi-line construction whose
  `pollingInterval` assignment is on the line after the closing paren, so the
  matched line cannot contain it.

The grep is line-based and cannot tell "set two lines down" from "not set", nor
executable code from a documentation string. Rather than contort either to
satisfy it, the property it was reaching for is checked directly:

    python3 - <<'PY'
    import pathlib
    bad = []
    for f in list(pathlib.Path('packages/app/src').rglob('*.ts*')) + \
             list(pathlib.Path('packages/sdk/src').rglob('*.ts')):
        lines = f.read_text().split('\n')
        for i, l in enumerate(lines):
            if 'new ethers.JsonRpcProvider' in l or 'new ethers.BrowserProvider' in l:
                if 'pollingInterval' not in '\n'.join(lines[max(0,i-3):i+12]):
                    bad.append(f"{f}:{i+1}")
    print(bad or "every provider sets a polling interval")
    PY

That reports none.

## Does B2 speed up EVERY kind of payment? No — and here is the measurement

A fair question, and the answer matters because it decides what to do next.
B2 fixed one thing: **waiting for a transaction receipt.** So it helps exactly
those paths whose time is spent in `tx.wait()`, and no others.

Cross-stable, traced again with the fix applied (`--polling=500`):

    cross.post_prepare   5049ms, 5538ms
    cross.post_confirm   5533ms, 4894ms
    total                11.9s, 11.5s   — against an 11.1s baseline

**Unchanged.** Because cross-stable's time is not the browser waiting on Arc,
it is the API waiting on Circle:

| Path | Where its seconds go | Helped by B2? |
|---|---|---|
| Same-currency | 2 receipt waits | **Yes — 12.7s → 6.1s** |
| Payroll leg | 2 receipt waits | **Yes — 13.5s → 6.6s** |
| Cross-stable (USDC→QCAD, →EURC, …) | `prepare` + `confirm`, server polling Circle | **No** |
| Cross-chain (Gateway/CCTP) | attestation window + `time.Sleep(5s)` ×2 | Partly — its on-chain deposit has receipts |
| Payment link / request-payment | whichever of the above the currencies pick | Inherits that path's answer |

A payment link is not a fourth kind of payment. It creates a settlement intent
and the payer settles it — same currency on both sides takes the same-currency
path and is now twice as fast; different currencies take the cross-stable path
and are not. **The link itself adds nothing measurable; what it costs is
whichever path it resolves to.**

### What actually fixes cross-stable

The sleeps the work order predicted are all present, at the lines it named:

    internal/fx/stablefx.go:218       time.Sleep(500 * time.Millisecond)   // sleep BEFORE checking
    internal/fx/stablefx.go:353       time.Sleep(1 * time.Second)          // sleep BEFORE checking
    internal/handlers/bridge.go:291   time.Sleep(5 * time.Second)
    internal/handlers/bridge.go:297   time.Sleep(5 * time.Second)
    internal/arcrpc/client.go:69      ChainID() liveness probe on EVERY Get

Both FX sleeps are at the TOP of their poll loops, so the code waits even when
the answer is already available — a guaranteed 500ms in `prepare` and a
guaranteed full second in `confirm`, before the first check. That is Phase B4.1
and it is the same class of mistake B2 just fixed, one layer down: sleeping on
a fixed timer instead of asking.

The larger win is B4.2. `confirm` holds the browser's socket while the API
polls Circle to completion — the 5.4s measured above — against a server
`WriteTimeout` of 30s and a poll deadline of 60s. Returning `202` the moment
Circle accepts, and letting a background worker finish, takes the payer's wait
from "until Circle settles" to "until Circle answers": roughly one round trip.

So the honest projection for cross-stable, and it is a projection until traced:
~11.5s today, of which about 1.5s is guaranteed dead sleep (B4.1) and about 5s
is the browser being held open for work it does not need to watch (B4.2).

## Clicking a link: where 24.5s goes

The traces above start at "create intent" and end at the receipt. A payer
clicking a link pays for a good deal that happens before any of that, and it
was never measured. It is now.

Measured against production (`useconduit.xyz` → `conduit-z56x.onrender.com`):

    1. GET /pay/<id> page HTML       1.91s   (16.5KB, server-rendered on demand)
    2. GET public intent             0.53s
    3. GET currencies                0.70s
    4. one proxied chain read        0.57s
       home page TTFB                1.45s

Plus roughly **500KB of JavaScript** to download, parse and hydrate before any
of the above can even be requested — the pay route's first-load JS is 224KB
compressed across a dozen chunks, and wagmi's connector setup runs after that.

So the shape of a link click is roughly:

| Stage | Cost | Fixed by |
|---|---:|---|
| Page HTML (dynamic, server-rendered per request) | ~1.9s | caching / static shell |
| Bundle download + hydration + wagmi setup | seconds on mobile | bundle work, not yet a phase |
| Intent + currencies fetch (sequential) | ~1.2s | parallelise; B4.3's reasoning |
| Chain reads, proxied at ~850ms each, rate-limited | seconds | B1.2, B1.3 |
| Wallet connect / Circle PIN | human + network | — |
| The payment itself | 6.1s same-currency after B2, 11.5s cross-stable | B2 done, B4 next |

**That is where 24.5s comes from, and only the last row is what the earlier
traces measured.** B2 halved the last row for same-currency; it did nothing for
the five rows above it, because none of them wait on a receipt.

Two things stand out as cheap and not yet in any phase:

- **`/pay/<id>` is server-rendered on demand** (`ƒ` in the Next build output)
  and takes 1.9s to return HTML. A payer stares at nothing for that whole time.
  The page needs the intent to render honestly, but it does not need to BLOCK on
  it — a static shell with the amount streamed in would put something on screen
  in ~200ms.
- **Steps 2 and 3 are sequential and independent.** The intent and the currency
  list have nothing to do with each other; fetching them together removes ~0.6s
  for free.

Neither is in the work order. Both are larger wins than the region change B1
proposes, and they are recorded here rather than acted on because Track B has an
order and B4 is next.

---

# Phase B4 — measured, including the part that got worse

    node scripts/latency-compare.mjs perf/latency-before.json perf/latency-after-b4.json

| Span | Before | After | |
|---|---:|---:|---|
| `cross.post_confirm` | 5399ms | **1262ms** | **−77%** |
| `cross.post_prepare` | 4547ms | 6792ms | **+49%** |
| `cross.post_quote` | 505ms | 416ms | −18% |
| **cross total** | **11108ms** | **9157ms** | −18% |

Median of seven runs against the deployed API.

## The win

`confirm` is the last thing a payer waits through — after both signatures, with
nothing left to do but watch. It used to hold the browser's socket while the API
polled Circle's relayer through three Arc transactions. It now returns as soon
as Circle accepts the funding, and the browser polls for the outcome.

**5.4s → 1.3s, and the samples go as low as 513ms.** That is the difference
between a payer watching a spinner and a payer seeing a result.

It also fixed a correctness bug: the poll deadline was 60s against a server
`WriteTimeout` of 30s, so a payment settling at 35 seconds was reported as a
network failure while the money had already moved, leaving `fx_trades` at
`submitted` with nothing to resolve it. There is a reconciler for that now.

## The regression, stated plainly

`post_prepare` went from a 4547ms median to 6792ms. **I cannot attribute it, and
I am not claiming B4 improved it.**

`latency-compare` reports it as "(within noise)" and that verdict is technically
correct — the ranges overlap, baseline `[4206, 4547, 6340]` against after
`[5165, 5991, 6298, 6792, 7232, 7942, 8147]`. But a median moving 2.2 seconds in
one direction is not something to wave through on a technicality, and the after
samples are clearly clustered higher.

Three candidates, in order of likelihood:

1. **Circle sandbox variance.** The baseline itself ranged 4206-6340ms, and
   `prepare` is dominated by waiting for Circle's relayer to produce a
   `contractTradeId` — an on-chain `recordTrade` that Conduit does not control.
2. **The instance was restarting.** The first sample (8147ms) came immediately
   after Render redeployed, and the series trends downward: 8147, 6792, 7942,
   6298, 5991, 7232, 5165.
3. **The new poll shape.** It checks at t=0 rather than sleeping first, so it
   makes more requests earlier. That should find an answer sooner, not later —
   but it has not been ruled out.

**What would settle it:** instrument inside `PrepareWithSignature` to record the
trade-creation POST, the `contractTradeId` poll count and duration, and the
presign POST separately. Phase B0 asked for exactly that split and this trace
does not have it — the span is measured from the browser, so it cannot see
inside. That is the next measurement, not the next optimisation.

## What the payer actually feels

Net cross-stable is 11.1s → 9.2s, but the shape matters more than the total.
The 4-second improvement landed on the LAST wait, when the payer has finished
signing and is doing nothing but waiting. The 2-second regression landed
between the two signatures, where the payer is already being asked to act.
Neither is a rounding error, and only one of them is understood.
