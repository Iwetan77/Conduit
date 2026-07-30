# CCTP V2 cross-chain inbound — Solana → Arc

Status: complete. Phases 0-4 all gated for real against live Solana devnet, Arc testnet,
and StableFX sandbox. No mocking anywhere — every burn, attestation, mint, and settlement
referenced below is a real transaction with a real hash.

## Domains and contracts

From `docs/cctp-capability.md` (Phase 0's live-verified facts, cross-checked against this
repo's own pre-existing `CCTPAdapter.sol`):

- **Arc testnet** — CCTP V2 domain **26**. `TokenMessengerV2 =
  0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`, `MessageTransmitterV2 =
  0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`, USDC =
  `0x3600000000000000000000000000000000000000`. Arc cannot originate a Fast Transfer burn
  (source-side Fast Transfer is `N/A` for Arc in Circle's own capability table), but this
  doesn't matter for inbound: Fast Transfer eligibility is a source-chain finality
  property, and Arc only ever receives mints here, never burns.
- **Solana** — CCTP V2 domain **5**, devnet and mainnet share the domain ID.
  `TokenMessengerMinterV2 (devnet) = CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe`,
  `MessageTransmitterV2 (devnet) = CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC`, USDC
  devnet mint = `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. Solana supports Fast
  Transfer as a source, which is the leg actually used here.
- **Iris** (Circle's attestation service): sandbox endpoint
  `https://iris-api-sandbox.circle.com/v2/messages/{sourceDomain}?transactionHash={sig}`.

All of the above live only as named constants in `packages/api/internal/bridge/config.go`
— nothing is hardcoded inline anywhere else in the bridge code.

## Observed attestation latencies

Real numbers from real transfers run across this build, worst case called out explicitly
per the spec's request rather than averaged away:

| Phase | Burn amount | Attestation latency | Notes |
|---|---|---|---|
| 0 (proof) | 1.0 USDC | ~14.1s | First-ever live transfer, direct-mint path |
| 2 (module test) | 0.5 USDC | ~14-22s across two runs | Second run included a fix (blockhash commitment) that added Solana-side latency before the burn even landed |
| 3 (GATE 3, full pipeline) | 0.5 USDC | Fast enough that the *entire* remaining pipeline (attestation → mint → StableFX quote → Permit2 prepare → funding submit → settled) completed inside the same window the orphan-recovery test's `kill -9` was meant to interrupt mid-attestation — the reconciler still found real work to do (the row was caught at `burn_confirmed`, before attestation had even started), but attestation itself was on the fast end |
| 4 (payer UI, screenshot run) | 0.5 USDC, several runs | **Worst observed: full pipeline (attestation + mint + settlement) completed before a human-paced sequence of `curl` calls plus a browser navigation could reliably catch it mid-flight** — repeated screenshot attempts landed on either the pre-bridge state or the fully-settled state; only a tight, single-script loop taking a screenshot every 1.2s actually caught an intermediate frame |

**The practical worst case observed in this entire build was not a slow transfer — it was
the opposite.** Every real transfer run finished well inside the documented 8–30s Fast
Transfer window, several finishing fast enough that manually orchestrating a "mid-bridge"
screenshot required a tight polling loop rather than a leisurely one. This is worth
stating honestly: nothing in this session ever observed Iris or the mint taking longer
than expected. The failure mode that actually needed engineering effort was the opposite
direction — a process crashing *before* the bridge finished, not the bridge itself being
slow. See the orphaned-burn section below for what that looks like.

## Orphaned-burn handling

The burn on Solana is irreversible from the moment it's submitted. Once Iris signs the
attestation, anyone holding the (message, attestation) pair can call `receiveMessage` on
Arc and the mint succeeds — there is no cancel path. `internal/bridge/README.md` documents
the full reasoning; the short version: `orphaned` is a first-class, non-terminal state
(its only legal transition is back to `mint_submitted`), and a reconciler
(`ReconcileOrphanedBridges`, run every 10s in production, or invocable once via the
`e2e-reconcile-once` command) sweeps for rows that stopped making forward progress and
finishes them without a payer present.

**This was proven for real, not just designed on paper.** GATE 3's e2e script
(`scripts/e2e-crosschain.sh`) actually `kill -9`s the running API server moments after a
real burn is reported — before attestation polling has even started — then restarts it
against the *same* database (a real, surviving orphaned embedded-postgres instance; killing
the Go process does not kill its postgres child) and runs the reconcile command. The row
was found stuck at `burn_confirmed`; the reconciler drove it all the way to
`handoff_to_settlement` with no live session involved. Real tx hashes from that exact run
are in the Phase 3 commit (`09965b7`).

Coverage gap found and fixed while building this: the reconciler's first version only
covered `attestation_pending`/`attested`/`orphaned`. A crash between `burn_confirmed` and
`attestation_pending` — exactly what the kill-mid-test produces — had no recovery path at
all. Extended to cover `burn_submitted`/`burn_confirmed` (resume the pipeline from
wherever it actually is) and `minted` (retry only the settlement leg if that's what
failed — never re-mint, since CCTP's own nonce-consumption makes a second mint attempt
actively wrong, not just redundant, and this was proven too: a deliberate second `Mint()`
call in Phase 2's live test failed with "Nonce already used").

**One gap that is NOT covered, stated honestly rather than hidden**: a transfer that hits
`failed` (the 60s hard `PollAttestation` timeout in `solana_arc.go`, never observed to
actually fire in this session — see the latency table above) has no automatic retry path.
The reconciler's query does not include `failed` rows. The payer's UI
(`CrossChainBridge.tsx`) keeps polling and shows "The bridge could not complete. Your
funds are safe on Solana and support has been notified — this page will keep checking,"
but nothing will actually change without a human. Given a 60s timeout against an observed
worst-case of well under 30s, this is a wide margin, but it is a real, unaddressed gap for
a future session, not a solved problem.

## Quote-after-mint ordering (spec §1.1) — and why it isn't optional

FX quotes are only valid for ~3.5 seconds. A CCTP bridge takes 8-30s. If you quote before
bridging, the quote is dead before you can use it — this isn't a hypothetical, it's the
literal reason the ordering is: burn → attest → mint → **then** quote → prepare → confirm,
never earlier. `settleBridgedIntent` (`internal/handlers/bridge.go`) only calls
`StableFX.Quote` after a transfer reaches `minted`, inside the same function that
transitions the bridge to `handoff_to_settlement`.

This tight window bit for real even *within* the post-mint window: GATE 3's first pass
failed with a genuine `"3004: Quote expired"` error from Circle's sandbox — two sequential
network round trips (Quote, then Prepare) were enough to blow the 3.5s TTL under real
network latency in this environment, even though nothing meaningful happens between them
besides signing. Fixed with a bounded retry (fetch a fresh quote, try again, up to 3
attempts) rather than failing outright on one unlucky round trip — the same thing a human
payer whose click landed a beat too late would get from a UI that re-quotes automatically.

## What breaks if Iris is slow or down, and what a payer sees

Never observed in this session (see the latency table — everything was fast), but the
code path is real and worth describing honestly:

1. `PollAttestation` (`internal/bridge/solana_arc.go`) polls every 5s with a **60s hard
   timeout**. If Iris is slow or down past that window, it returns an error rather than
   hanging forever.
2. The bridge transitions to `failed`. A `bridge.failed` webhook fires with the reason.
3. **The payer's own USDC is not lost** — it's already burned on Solana, and the moment
   Iris does eventually sign (even after the 60s local timeout gives up waiting), that
   attestation is still valid and claimable. The gap described above (no automatic retry
   from `failed`) means nothing currently re-polls once the code has given up, but the
   burn itself is inert, not destroyed.
4. On the payer's screen: the three-step progress indicator stays on step 1 ("Bridging
   USDC from Solana"), and once the poll observes `state === "failed"`, an honest message
   appears — "The bridge could not complete. Your funds are safe on Solana and support
   has been notified — this page will keep checking" — while polling continues
   indefinitely. No fake progress, no claim of completion, no atomic/instant language.
   The payer is told the truth: something's stuck, their money is safe, and a human needs
   to look at it. That last part is accurate — as of this session, only a human manually
   re-running the reconciler against a `failed` row would unstick it, since the automated
   sweep doesn't cover that state yet.

## Known, documented limitations (not silently left out)

- `settleBridgedIntent` only supports StableFX-routed settlement into a non-USDC
  currency. A bridged intent whose settle_currency is USDC itself hits an explicit early
  return — not exercised by any gate (which deliberately settle into EUR/EURC), not
  required by the spec's scope, but a real gap if this becomes a broader product surface.
- If `settleBridgedIntent` fails after a StableFX trade is already created (Prepare
  succeeded) and gets retried from scratch by a later reconciler pass, it would create a
  second StableFX trade rather than resuming the first. Never hit in practice — every
  failure observed this session was either fully before or fully after trade creation —
  but not fully solved.
- The reconciler does not cover the `failed` state (see above).
- The new payer page's same-chain path (`source_chain == "arc"`, i.e. a payer who already
  holds Arc funds) shows real intent details but is explicit that direct in-browser
  payment isn't wired yet, rather than faking a pay button. The underlying reason: the
  existing `quote`/`prepare`/`confirm` endpoints require a merchant API key, and no
  key-distribution mechanism exists for a bare payment link to obtain one — a pre-existing
  gap in the product, unrelated to CCTP, out of this feature's scope to solve.
- Found and fixed along the way, worth remembering for future work on this API: it had no
  CORS handling at all until Phase 4, meaning no browser-based client on a different
  origin/port could call it — silently blocked, not caught by any static check. Fixed
  with a wildcard-origin `github.com/go-chi/cors` policy, appropriate for a testnet
  product with bearer-token auth (never sent implicitly, nothing for a wildcard origin to
  leak) — tighten to an explicit allowlist before any mainnet deployment.
