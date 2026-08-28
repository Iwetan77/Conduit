"use client";

// Where this business's money should land — asked once, before the dashboard.
//
// A merchant account's settle_address has always defaulted to the wallet used
// to sign in, silently, and nothing ever asked. So business income has been
// arriving in a personal wallet by default, and nobody was told. This is the
// one-time question that turns that from an accident into a decision.
//
// Blocking, deliberately, and this is the trade: it interrupts someone who came
// to do something else. It earns that by being answerable in one click for the
// common case, by being asked exactly once, and because the alternative is a
// business quietly mixing its takings with its owner's own money for months.
//
// Both answers are legitimate. Plenty of businesses are one person with one
// wallet, and "keep it here" is a real choice rather than a failure to decide —
// which is why it is a button and not a thing you dismiss.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { isAddress } from "viem";
import { confirmPayoutAddress, updateAccount, type Account } from "@/lib/conduit-api";
import { shortenAddress } from "@/lib/format";
import { qk } from "@/lib/queries";

export function PayoutAddressGate({
  account,
  children,
}: {
  account: Account | undefined;
  children: React.ReactNode;
}) {
  const qc = useQueryClient();
  const [choice, setChoice] = useState<"same" | "other" | null>(null);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Never hold the dashboard back on a read that has not landed. An account
  // still loading is not an unconfirmed one, and blocking on undefined would
  // flash this screen at every merchant on every navigation.
  if (!account || account.payout_confirmed) return <>{children}</>;

  const done = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      // The gate reads payout_confirmed from this cache, so it has to be
      // refetched here or the screen stays up after a successful answer.
      await qc.invalidateQueries({ queryKey: qk.myAccount });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const canSubmitOther = isAddress(address.trim()) && !busy;

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md space-y-5">
        <div className="space-y-2">
          <h1 className="font-display text-xl font-bold text-ink">
            Where should {account.name} be paid?
          </h1>
          <p className="text-ink-dim text-sm leading-relaxed">
            Every payment to this business settles to one address. Right now that
            is the wallet you signed in with, which means business income and your
            own money arrive in the same place.
          </p>
        </div>

        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setChoice("same")}
            className={`w-full text-left border p-3 transition-colors ${
              choice === "same" ? "border-signal bg-signal/5" : "border-border hover:border-ink-dim"
            }`}
          >
            <p className="text-ink text-sm">Keep using my sign-in wallet</p>
            <p className="text-ink-dim text-scale-1 font-mono mt-1">
              {shortenAddress(account.settle_address)}
            </p>
          </button>

          <button
            type="button"
            onClick={() => setChoice("other")}
            className={`w-full text-left border p-3 transition-colors ${
              choice === "other" ? "border-signal bg-signal/5" : "border-border hover:border-ink-dim"
            }`}
          >
            <p className="text-ink text-sm">Send business income somewhere else</p>
            <p className="text-ink-dim text-scale-1 mt-1">
              A separate wallet you control — keeps the books apart.
            </p>
          </button>
        </div>

        {choice === "other" && (
          <div className="space-y-2">
            <input
              autoFocus
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="0x..."
              spellCheck={false}
              autoComplete="off"
              className="w-full bg-surface border border-border p-2.5 text-sm font-mono text-ink outline-none focus:border-ink-dim"
            />
            {/* Said before they commit, not after they wonder.
                Payouts land at this address and settlement is on-chain and
                final, so a wrong one is not something we can undo. And the
                dashboard's own Send page pays FROM the connected wallet, so
                money sent here is spendable only by connecting this wallet. */}
            <p className="text-ink-dim text-xs leading-relaxed">
              Make sure you control this address. Payments settle on-chain and
              cannot be reversed. To spend from it later you will need to connect
              that wallet — the dashboard sends from whichever wallet is
              connected, not from this address.
            </p>
          </div>
        )}

        {error && <p className="text-danger text-sm font-mono">{error}</p>}

        <button
          type="button"
          disabled={choice === null || busy || (choice === "other" && !canSubmitOther)}
          onClick={() =>
            void done(() =>
              choice === "other"
                ? updateAccount(account.id, { settle_address: address.trim() })
                : confirmPayoutAddress(),
            )
          }
          className="w-full bg-signal text-signal-ink font-medium py-2.5 text-sm
                     disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? "Saving…" : "Continue"}
        </button>

        <p className="text-ink-dim text-xs text-center">
          You can change this later in Settings.
        </p>
      </div>
    </div>
  );
}
