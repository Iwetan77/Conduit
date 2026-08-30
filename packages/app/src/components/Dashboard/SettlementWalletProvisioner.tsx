"use client";

// Giving a business an address of its own, without making it ask for one.
//
// A merchant account's settle_address has always defaulted to the wallet used
// to sign in, so business income arrives in a personal wallet by default. The
// answer is not a better onboarding question — Arc is new and almost nobody has
// a second Arc address to name — it is to create one for them.
//
// Deliberately NOT a gate. It runs beside the dashboard rather than in front of
// it, because a merchant who came here to check a payment should not be held at
// a screen while Circle provisions a wallet, and because provisioning can fail
// for reasons that have nothing to do with them. A banner that says what is
// happening and offers a retry costs a strip of screen; a blocking modal that
// fails costs them the session.
//
// It does two things and both are one-time: create a second Arc wallet through
// Circle's challenge UI, then tell the API which wallet id to bind. The API
// does not believe the id on its own — it reads the address back from Circle
// with the merchant's own token — so nothing here is trusted with where money
// goes.
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createSettlementWallet } from "@/lib/circle/browser";
import { provisionSettlementWallet, type Account } from "@/lib/conduit-api";
import { qk } from "@/lib/queries";

type State = { phase: "idle" | "working" | "failed"; error?: string };

export function SettlementWalletProvisioner({
  account,
  circleToken,
}: {
  account: Account | undefined;
  circleToken: string | null;
}) {
  const qc = useQueryClient();
  const [state, setState] = useState<State>({ phase: "idle" });
  // One attempt per account per page load. Without this, a failure followed by
  // React re-rendering on the state change would start the flow again, which
  // means a second Circle challenge popping up on its own in front of somebody
  // who did not ask for one.
  const attempted = useRef<string | null>(null);

  // Nothing to do for an account that already has its own wallet, or one whose
  // owner deliberately settles somewhere external — that is a decision, not a
  // gap to fill.
  const needs =
    !!account &&
    !account.settlement_wallet_ready &&
    account.settle_address_source !== "external";

  useEffect(() => {
    if (!needs || !account || !circleToken) return;
    if (attempted.current === account.id) return;
    attempted.current = account.id;

    let cancelled = false;
    (async () => {
      setState({ phase: "working" });
      try {
        // refId is the account id, so the wallet can be found again after the
        // challenge without guessing which of the user's Arc wallets is new.
        const wallet = await createSettlementWallet(account.id, `${account.name} settlement`);
        await provisionSettlementWallet(wallet.id, circleToken);
        if (cancelled) return;
        setState({ phase: "idle" });
        // The banner reads settlement_wallet_ready from this cache, and so does
        // everything that refuses to take payments until it is true.
        await qc.invalidateQueries({ queryKey: qk.myAccount });
      } catch (err) {
        if (cancelled) return;
        setState({
          phase: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [needs, account, circleToken, qc]);

  if (!needs) return null;

  const retry = () => {
    attempted.current = null;
    setState({ phase: "idle" });
  };

  return (
    <div className="border border-border bg-surface px-4 py-3 mb-4 flex items-start gap-3">
      <div className="flex-1 min-w-0">
        {state.phase === "failed" ? (
          <>
            <p className="text-ink text-sm">
              We could not finish setting up this business&apos;s settlement wallet.
            </p>
            {/* The real reason, not a shrug. Everything that goes wrong here is
                either a declined challenge or Circle being unreachable, and
                both are things the merchant can act on once told. */}
            <p className="text-ink-dim text-xs font-mono mt-1 break-words">{state.error}</p>
            <p className="text-ink-dim text-xs mt-1">
              Payments to this business are paused until it is set up. Nothing has
              been lost — you can try again.
            </p>
          </>
        ) : (
          <>
            <p className="text-ink text-sm">Setting up this business&apos;s own settlement wallet…</p>
            <p className="text-ink-dim text-xs mt-1">
              Payments will land here instead of the wallet you sign in with. You
              may be asked to confirm with your PIN.
            </p>
          </>
        )}
      </div>
      {state.phase === "failed" && (
        <button
          type="button"
          onClick={retry}
          className="shrink-0 border border-signal/40 text-signal text-xs font-mono px-3 py-1.5
                     hover:bg-signal/10 transition-colors"
        >
          Try again
        </button>
      )}
    </div>
  );
}
