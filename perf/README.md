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
