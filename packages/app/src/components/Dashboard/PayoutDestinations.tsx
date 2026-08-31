"use client";

// Where a business sends its own money, and the proof that it can.
//
// Adding an address here does not make it payable. That is the whole design: a
// withdrawal is an on-chain transfer and final, and an address that is
// well-formed but not yours looks exactly like one that is until the money has
// gone. Twenty bytes of valid hex covers a wallet on another chain, an exchange
// deposit address that will never credit an Arc token, and every typo that
// lands in range. A signature is the only thing that separates them.
//
// The signature is pasted rather than produced in the app, and that is
// deliberate. The merchant is signed in with the wallet their income lands in;
// asking the app to sign for a DIFFERENT address would mean disconnecting that
// session and reconnecting as something else. Worse, the destination most worth
// verifying is a treasury multisig, which cannot be "connected" to sign at all
// -- it answers through its own contract. Showing the exact message and taking
// a signature back works for a browser wallet, a hardware wallet and a Safe
// alike.
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addPayoutDestination,
  listPayoutDestinations,
  payoutDestinationChallenge,
  removePayoutDestination,
  verifyPayoutDestination,
  ConduitApiError,
  type PayoutDestination,
} from "@/lib/conduit-api";
import { shortenAddress } from "@/lib/format";
import { useCopy } from "@/lib/use-copy";

const qkDestinations = ["payout-destinations"] as const;

function errorText(err: unknown): string {
  return err instanceof ConduitApiError ? err.message : "Something went wrong. Try again.";
}

export function PayoutDestinations() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: qkDestinations,
    queryFn: listPayoutDestinations,
  });
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = () => qc.invalidateQueries({ queryKey: qkDestinations });

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await addPayoutDestination({ address: address.trim(), label: label.trim() || undefined });
      setAddress("");
      setLabel("");
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const destinations = data?.data ?? [];

  return (
    <div className="border border-border p-6 space-y-4">
      <div>
        <h2 className="font-medium text-sm mb-1">Payout destinations</h2>
        <p className="text-xs text-ink-dim">
          Addresses you can withdraw to. Separate from where your income lands —
          money is never routed here, only sent when you ask.
        </p>
      </div>

      {isLoading && <p className="text-ink-dim text-xs">Loading…</p>}

      {!isLoading && destinations.length === 0 && (
        // Says what the section is for rather than "None". An empty list with no
        // explanation is a dead end for someone who has never used the feature.
        <p className="text-ink-dim text-xs">
          None yet. Add an address you control to withdraw your balance to it.
        </p>
      )}

      {destinations.map((d) => (
        <DestinationRow key={d.id} destination={d} onChanged={refresh} />
      ))}

      <form onSubmit={add} className="space-y-2 border-t border-border pt-4">
        <label className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider block">
          Add a destination
        </label>
        <input
          className="w-full bg-surface border border-border px-3 py-2 text-sm font-mono focus:border-signal focus:outline-none"
          placeholder="0x..."
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          required
        />
        <input
          className="w-full bg-surface border border-border px-3 py-2 text-sm focus:border-signal focus:outline-none"
          placeholder="Label (optional) — e.g. Treasury"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <button
          type="submit"
          disabled={busy || !address.trim()}
          className="w-full border border-border py-2 text-sm text-ink-dim hover:text-ink hover:border-ink-dim
                     transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? "Adding…" : "Add destination"}
        </button>
        {error && <p className="text-danger text-xs">{error}</p>}
      </form>
    </div>
  );
}

function DestinationRow({
  destination,
  onChanged,
}: {
  destination: PayoutDestination;
  onChanged: () => void;
}) {
  const [proving, setProving] = useState(false);
  const [message, setMessage] = useState("");
  const [signature, setSignature] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { copied, copy } = useCopy();

  // Ask for a fresh challenge each time the panel is opened. A nonce is
  // single-use and expires, so reusing one held from an earlier visit would
  // fail at the last step with nothing on screen explaining why.
  useEffect(() => {
    if (!proving) return;
    let cancelled = false;
    setError("");
    setMessage("");
    payoutDestinationChallenge(destination.id)
      .then((r) => !cancelled && setMessage(r.message))
      .catch((err) => !cancelled && setError(errorText(err)));
    return () => {
      cancelled = true;
    };
  }, [proving, destination.id]);

  const verify = async () => {
    setError("");
    setBusy(true);
    try {
      await verifyPayoutDestination(destination.id, signature.trim());
      setProving(false);
      setSignature("");
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setError("");
    setBusy(true);
    try {
      await removePayoutDestination(destination.id);
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-border bg-bg p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-ink text-sm font-mono truncate" title={destination.address}>
            {shortenAddress(destination.address)}
          </p>
          <p className="text-ink-dim text-xs mt-0.5">
            {destination.label || "No label"} ·{" "}
            {destination.verified ? (
              <span className="text-signal">verified</span>
            ) : (
              // Named as the consequence, not the state. "Unverified" says
              // nothing about what it means for the person reading it.
              <span className="text-ink-dim">not verified — cannot be withdrawn to</span>
            )}
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          {!destination.verified && (
            <button
              type="button"
              onClick={() => setProving((v) => !v)}
              className="border border-signal/40 text-signal text-xs font-mono px-2 py-1 hover:bg-signal/10 transition-colors"
            >
              {proving ? "Cancel" : "Verify"}
            </button>
          )}
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy}
            className="border border-border text-ink-dim text-xs font-mono px-2 py-1 hover:text-danger hover:border-danger/40 transition-colors"
          >
            Remove
          </button>
        </div>
      </div>

      {proving && (
        <div className="space-y-2 border-t border-border pt-2">
          <p className="text-ink-dim text-xs">
            Sign this exact message with the wallet at that address, then paste
            the signature back. Any wallet will do — a browser wallet, a hardware
            wallet, or a Safe.
          </p>
          {message ? (
            <div className="flex items-stretch gap-2">
              <pre className="flex-1 min-w-0 bg-surface border border-border px-2 py-1.5 text-[11px] font-mono text-ink whitespace-pre-wrap break-all">
                {message}
              </pre>
              <button
                type="button"
                onClick={() => copy(message, destination.id)}
                className={`shrink-0 border px-2 text-xs font-mono transition-colors ${
                  copied === destination.id
                    ? "border-signal text-signal"
                    : "border-border text-ink-dim hover:text-ink"
                }`}
              >
                {copied === destination.id ? "Copied" : "Copy"}
              </button>
            </div>
          ) : (
            !error && <p className="text-ink-dim text-xs">Preparing a challenge…</p>
          )}
          <input
            className="w-full bg-surface border border-border px-3 py-2 text-sm font-mono focus:border-signal focus:outline-none"
            placeholder="0x… signature"
            value={signature}
            onChange={(e) => setSignature(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="button"
            onClick={() => void verify()}
            disabled={busy || !signature.trim() || !message}
            className="w-full bg-signal text-signal-ink py-2 text-sm font-medium
                       disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? "Checking…" : "Confirm control"}
          </button>
        </div>
      )}

      {error && <p className="text-danger text-xs">{error}</p>}
    </div>
  );
}
