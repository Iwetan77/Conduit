"use client";

// Choosing the name you get paid under. Asked once, on first sign-in.
//
// It is a one-time, irreversible claim, so the screen is built around not
// letting someone stumble into a name they did not mean:
//
//   - Availability is checked while they type, debounced, so "taken" arrives
//     before they commit rather than as a rejection afterwards.
//   - The @ conduit suffix is rendered as fixed furniture inside the field, not
//     as editable text. It is part of how the name reads and not part of the
//     name, and typing it would otherwise be the most common way to fail
//     validation.
//   - Submit stays disabled until the name is known-good.
//   - Skip is always available. Nobody is trapped behind a naming decision on
//     their way to sending money.
import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import {
  checkUsernameAvailable,
  claimUsername,
  claimUsernameWithWallet,
} from "@/lib/conduit-api";
import { getSessionToken } from "@/lib/conduit-api";
import { usePayerIdentity } from "@/lib/use-payer-identity";
import { useInvalidateUsername } from "@/lib/use-username";
import { UserMark } from "@/components/Shared/UserMark";

type Check =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ok" }
  | { state: "bad"; reason: string };

/** Long enough that a normal typist is not firing a request per keystroke. */
const DEBOUNCE_MS = 350;

export function UsernamePrompt({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState("");
  const [check, setCheck] = useState<Check>({ state: "idle" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const { identity } = usePayerIdentity();
  // wagmi's connector, which getWalletProvider needs to reach the right wallet
  // rather than falling back to window.ethereum.
  const { connector } = useAccount();
  const invalidate = useInvalidateUsername();

  // Guards a late response from overwriting a newer one. Without it, a slow
  // check for "iva" can land after a fast one for "ivan" and label a good name
  // as taken.
  const latest = useRef(0);

  useEffect(() => {
    const name = value.trim();
    if (!name) {
      setCheck({ state: "idle" });
      return;
    }
    setCheck({ state: "checking" });
    const seq = ++latest.current;
    const t = setTimeout(async () => {
      try {
        const res = await checkUsernameAvailable(name);
        if (seq !== latest.current) return;
        setCheck(
          res.available
            ? { state: "ok" }
            : { state: "bad", reason: res.reason ?? "that username is not available" },
        );
      } catch {
        if (seq !== latest.current) return;
        // A failed CHECK is not a failed name. Say nothing rather than
        // accusing a perfectly good name of being taken; the claim itself is
        // still authoritative and will report the truth.
        setCheck({ state: "idle" });
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [value]);

  const submit = useCallback(async () => {
    const name = value.trim();
    if (!name || check.state !== "ok" || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      if (getSessionToken()) {
        // Merchant or Google sign-in: the session is the credential.
        await claimUsername(name);
      } else if (identity?.kind === "evm") {
        // Wallet only, so proof of control is the credential. The name is
        // inside the signed message, so this signature cannot be replayed to
        // take a different one.
        const { getWalletProvider } = await import("@/lib/wallet-provider");
        const { signUsernameClaim } = await import("@/lib/username-signature");
        const provider = await getWalletProvider(connector);
        const { timestamp, signature } = await signUsernameClaim(
          identity.address,
          name,
          provider,
        );
        await claimUsernameWithWallet({
          wallet: identity.address,
          username: name,
          timestamp,
          signature,
        });
      } else {
        setError("Connect a Google account or an EVM wallet to claim a username.");
        return;
      }
      invalidate(identity?.address);
      onDone();
    } catch (err) {
      const { formatTxError } = await import("@/lib/tx-errors");
      setError(formatTxError(err));
    } finally {
      setSubmitting(false);
    }
  }, [value, check.state, submitting, identity, connector, invalidate, onDone]);

  const canSubmit = check.state === "ok" && !submitting;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/90 p-4">
      <div className="w-full max-w-md border border-border bg-surface p-6 space-y-5">
        <div className="space-y-2">
          <h2 className="font-display text-2xl font-bold text-ink">Pick your username</h2>
          <p className="text-ink-dim text-sm leading-relaxed">
            This is how people send you money — a name instead of 42 characters of
            hex. You can only choose once, so pick one you want to keep.
          </p>
        </div>

        <div className="space-y-2">
          <div
            className={`flex items-center border bg-bg px-3 py-2.5 transition-colors ${
              check.state === "bad"
                ? "border-danger"
                : check.state === "ok"
                  ? "border-signal"
                  : "border-border focus-within:border-ink-dim"
            }`}
          >
            <UserMark username={check.state === "ok" ? value : null} size="sm" />
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
              placeholder="yourname"
              maxLength={20}
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
              aria-label="Username"
              className="flex-1 min-w-0 ml-2.5 bg-transparent font-mono text-ink outline-none placeholder:text-ink-dim/50"
            />
            {/* Furniture, not text. Rendered inside the field so the name reads
                the way it will everywhere else, but outside the input so it can
                never be typed, selected, or submitted as part of the name. */}
            <span aria-hidden className="shrink-0 font-mono text-ink-dim/60 select-none">
              @ conduit
            </span>
          </div>

          <p className="text-scale-1 font-mono min-h-[1.25rem]">
            {check.state === "checking" && <span className="text-ink-dim">Checking…</span>}
            {check.state === "ok" && (
              <span className="text-signal">{value} @ conduit is yours to take</span>
            )}
            {check.state === "bad" && <span className="text-danger">{check.reason}</span>}
          </p>
        </div>

        {error && <p className="text-danger text-sm font-mono">{error}</p>}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="flex-1 px-4 py-2.5 text-scale-2 font-mono bg-signal text-signal-ink
                       hover:bg-signal/90 transition-colors disabled:opacity-40
                       disabled:cursor-not-allowed"
          >
            {submitting ? "Claiming…" : "Claim username"}
          </button>
          {/* Never a trap. Someone who came here to send money can go and send
              money; they will be asked again next time. */}
          <button
            type="button"
            onClick={onDone}
            className="px-4 py-2.5 text-scale-2 font-mono text-ink-dim hover:text-ink transition-colors"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
