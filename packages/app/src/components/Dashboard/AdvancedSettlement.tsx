"use client";

// Sending income straight to a treasury.
//
// A real thing real businesses want, and deliberately not the onboarding
// question. It is the answer for a company with a finance function, not for
// somebody signing up — which is why it lives behind a disclosure rather than
// in the middle of the settings page.
//
// Three things make it safe to offer at all, and they are all visible here:
// the address can only be one already proven (there is no text field in this
// flow, anywhere), the consequence is stated in the words it will actually have
// — Conduit cannot reverse an on-chain settlement and cannot withdraw from an
// address it does not hold a key for — and it is undoable in one click.
//
// The confirmation is asymmetric on purpose. Sending income somewhere we cannot
// reach is the decision worth slowing down; bringing it back is not, and making
// both equally awkward would leave people stuck in the state they wanted out of.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listPayoutDestinations,
  revertSettlementAddress,
  settleToExternal,
  ConduitApiError,
  type Account,
} from "@/lib/conduit-api";
import { shortenAddress } from "@/lib/format";
import { qk } from "@/lib/queries";

export function AdvancedSettlement({ account }: { account: Account }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState("");
  const [typedName, setTypedName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const { data } = useQuery({
    queryKey: ["payout-destinations"],
    queryFn: listPayoutDestinations,
    enabled: open,
  });
  // Only proven addresses are even offered. Showing unverified ones with a
  // disabled state would invite the question "why not this one" at the exact
  // moment somebody is deciding where their income goes.
  const verified = (data?.data ?? []).filter((d) => d.verified);
  const isExternal = account.settle_address_source === "external";

  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: qk.myAccount });
      setTypedName("");
      setChosen("");
    } catch (err) {
      setError(err instanceof ConduitApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-border p-6 space-y-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <span>
          <span className="font-medium text-sm block">Advanced</span>
          <span className="text-xs text-ink-dim">
            Settle directly to an external address instead of your own wallet
          </span>
        </span>
        <span className="text-ink-dim text-xs font-mono">{open ? "hide" : "show"}</span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-border pt-3">
          {isExternal ? (
            <>
              <p className="text-ink text-sm">
                Income settles to{" "}
                <span className="font-mono">{shortenAddress(account.settle_address)}</span>.
              </p>
              <p className="text-ink-dim text-xs">
                You cannot withdraw from this address in Conduit — it is yours, not
                ours, so move funds from it with whatever controls it.
              </p>
              <button
                type="button"
                onClick={() => void run(revertSettlementAddress)}
                disabled={busy}
                className="w-full border border-border py-2 text-sm text-ink-dim hover:text-ink
                           hover:border-ink-dim transition-colors disabled:opacity-40"
              >
                {busy ? "Switching…" : "Settle to my own wallet again"}
              </button>
            </>
          ) : verified.length === 0 ? (
            // Says what to do rather than presenting an empty dropdown. The
            // requirement is the point, not an obstacle to explain away.
            <p className="text-ink-dim text-xs">
              You need a verified payout destination first. Add one above and prove
              you control it, then it can be selected here.
            </p>
          ) : (
            <>
              <div>
                <label className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider block mb-1">
                  Settle to
                </label>
                <select
                  value={chosen}
                  onChange={(e) => setChosen(e.target.value)}
                  className="w-full bg-surface border border-border px-3 py-2 text-sm font-mono
                             focus:border-signal focus:outline-none"
                >
                  <option value="">Choose a verified destination…</option>
                  {verified.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label ? `${d.label} — ` : ""}
                      {shortenAddress(d.address)}
                    </option>
                  ))}
                </select>
              </div>

              {/* Said before the decision, in the words it will have. Not a
                  warning icon and a shrug: these are the two facts somebody
                  needs and neither is obvious from the outside. */}
              <div className="border border-danger/30 bg-danger/5 p-3 space-y-1">
                <p className="text-ink text-xs">
                  Every future payment will land at that address instead of your
                  Conduit wallet.
                </p>
                <p className="text-ink-dim text-xs">
                  Settlement is on-chain and final — Conduit cannot reverse one.
                  And because we hold no key for that address, those funds will
                  not be withdrawable from this dashboard.
                </p>
                <p className="text-ink-dim text-xs">
                  Payment links and invoices you have already created are
                  unaffected; they keep paying where they said they would.
                </p>
              </div>

              <div>
                <label className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider block mb-1">
                  Type <span className="text-ink">{account.name}</span> to confirm
                </label>
                <input
                  className="w-full bg-surface border border-border px-3 py-2 text-sm
                             focus:border-signal focus:outline-none"
                  value={typedName}
                  onChange={(e) => setTypedName(e.target.value)}
                  autoComplete="off"
                />
              </div>

              <button
                type="button"
                onClick={() =>
                  void run(() =>
                    settleToExternal({ destination_id: chosen, confirm_name: typedName.trim() }),
                  )
                }
                disabled={busy || !chosen || typedName.trim() !== account.name.trim()}
                className="w-full border border-danger/40 text-danger py-2 text-sm
                           hover:bg-danger/10 transition-colors
                           disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {busy ? "Switching…" : "Settle to this address from now on"}
              </button>
            </>
          )}

          {error && <p className="text-danger text-xs">{error}</p>}
        </div>
      )}
    </div>
  );
}
