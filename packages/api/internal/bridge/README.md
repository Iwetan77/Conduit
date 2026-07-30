# bridge

CCTP V2 cross-chain funding pre-stage. A settlement intent with
`source_chain != "arc"` runs a bridge_transfers row through this package's
state machine (`state.go`) before the existing quote/settle engine ever sees
it. This is NOT atomic -- it's an honest burn → attestation → mint sequence,
observed at ~14s on a real Solana devnet → Arc testnet Fast Transfer in
Phase 0 (see `docs/cctp-capability.md`), with CCTP's documented 8-30s window
as the general expectation.

## Ordering: bridge fully, THEN quote FX, THEN settle

Conduit's existing FX quotes are only valid for ~3.5s. You cannot hold a
quote across an 8-30s bridge -- it will be dead by the time you try to use
it. So the order is strict and non-negotiable:

```
burn (Solana) → attest (Iris) → mint (Arc)  →  THEN fetch FX quote  →  THEN settle
```

The bridge doesn't know or care what currency the recipient wants. It moves
a fixed USDC amount onto Arc. Only once that USDC is actually sitting on Arc
(state == minted) does the settlement engine quote and convert it, exactly
as it already does for a same-chain payer. The bridge is a funding source,
not a participant in the FX/settlement state machine.

## The orphaned-burn problem

This is the actual hard part of this feature, and the reason `orphaned`
exists as a first-class state instead of being folded into `failed`.

**The burn on Solana is irreversible.** Once `depositForBurn` lands, the
USDC is gone from the payer's Solana balance whether or not anyone ever
mints it on Arc. Once Circle's Iris service signs the attestation, *anyone*
holding that (message, attestation) pair can call `receiveMessage` on Arc's
`MessageTransmitterV2` and the mint succeeds -- there is no "cancel" and no
way to return the funds to Solana.

So: if the payer's tab closes, the process restarts, or the session
otherwise dies between the burn landing and the mint being submitted, **the
USDC will still mint on Arc the moment someone submits the attestation.**
The only question is whether that's the payer's own live session doing it
in the next few seconds, or a reconciler doing it later. There is no
scenario where the money is lost -- only a scenario where it's stuck
un-minted until something completes the last step.

This is why:

1. **Every bridge_transfers row persists the attestation and message bytes**
   the moment Iris signs them (state → `attested`), not just a status flag.
   Minting only needs those two byte strings plus the destination contract --
   nothing payer-session-specific. A row in `attested` (or later) state has
   everything needed to complete without the payer present.
2. **`orphaned` is reachable from `attestation_pending` and `attested`**, not
   from earlier states -- there's nothing to orphan before the burn has
   landed (if the burn itself never got submitted, that's just `failed`, not
   a stuck-funds situation).
3. **`orphaned` is not terminal.** Its only legal transition is back to
   `mint_submitted` -- a reconciler process (not yet implemented as of Phase
   1; see Phase 2/3) periodically sweeps `bridge_transfers` for rows in
   `attestation_pending`/`attested`/`orphaned` with no recent `updated_at`
   activity, and for any with an `attestation` already on file, submits the
   mint itself.
4. **`Mint()` (Phase 2) is idempotent on `source_tx_hash`.** The DB enforces
   this too: `idx_bridge_transfers_source_tx` and `idx_bridge_transfers_mint_tx`
   are both unique partial indexes. A live session and the reconciler can
   both race to mint the same transfer; exactly one `UPDATE ... SET state =
   'minted', mint_tx_hash = $1` can win, and the actual on-chain
   `receiveMessage` call is itself idempotent (CCTP rejects a
   already-consumed nonce), so even a true double-submit from two processes
   resolves safely -- one transaction succeeds, the other reverts cleanly
   and the loser's mint attempt is simply discarded.

**What a user closing the tab mid-bridge actually experiences:** their USDC
left Solana and, within the same ~8-30s window it would have taken anyway,
lands on Arc and completes settlement -- they just don't watch the progress
bar do it. Reopening `/pay/[id]` (Phase 4) hits `GET .../bridge/status`,
which reads the current DB state regardless of who's driving it forward, so
the UI picks the in-flight transfer back up rather than showing a broken or
stuck state.

## Non-goals of this package

- No retry/backoff policy lives here -- `state.go` only answers "is this
  transition legal," not "should I retry." That's the caller's job (Phase 2's
  `BridgeProvider` implementation and Phase 3's handlers/reconciler).
- No FX or settlement logic. `handoff_to_settlement` is the last state this
  package's state machine reaches; everything after that is the existing
  `packages/api/internal/fx` / settlement code, untouched by this package.
