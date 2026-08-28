"use client";

// The recipient: an address, or a username.
//
// A username is the entire point of having usernames, so this field accepts
// either. What it must never do is let the two blur together: money goes to an
// ADDRESS, and when a name was typed the resolved address is shown before the
// payment can proceed, so nobody sends to a name they have not seen resolve.
//
// The resolved address is reported to the parent through onChange, exactly as a
// typed address would be. Everything downstream — the route decision, the
// intent, the confirm screen — keeps working on an address and needs to know
// nothing about names.
import { useEffect, useRef, useState } from "react";
import { isAddress } from "viem";
import { resolveUsername, type UsernameResolution } from "@/lib/conduit-api";
import { shortenAddress } from "@/lib/format";
import { UserMark } from "@/components/Shared/UserMark";

interface AddressInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

type Lookup =
  | { state: "idle" }
  | { state: "resolving" }
  | { state: "found"; result: UsernameResolution }
  | { state: "missing" };

/** Same debounce as the claim form, for the same reason. */
const DEBOUNCE_MS = 350;

/** Could this be a username? Deliberately loose — the server decides. */
function looksLikeUsername(raw: string): boolean {
  const s = raw.trim();
  return s.length >= 3 && !s.startsWith("0x") && /^[A-Za-z0-9_]+$/.test(s);
}

export function AddressInput({ value, onChange, placeholder }: AddressInputProps) {
  const [touched, setTouched] = useState(false);
  // What the person typed, which is NOT always what is reported upward: typing
  // a name reports the address it resolves to.
  const [text, setText] = useState(value);
  const [lookup, setLookup] = useState<Lookup>({ state: "idle" });
  const latest = useRef(0);

  // Keep the field in step when the parent changes the value itself (clearing
  // the form, scanning a QR). Skipped while a name is resolved, or echoing the
  // resolved address back would replace the name the person typed.
  useEffect(() => {
    if (lookup.state === "found") return;
    setText((current) => (current === value ? current : value));
  }, [value, lookup.state]);

  useEffect(() => {
    const raw = text.trim();

    if (isAddress(raw)) {
      setLookup({ state: "idle" });
      onChange(raw);
      return;
    }
    if (!looksLikeUsername(raw)) {
      setLookup({ state: "idle" });
      // Report the raw text so the parent's own validation still sees a
      // half-typed address as invalid rather than as an empty field.
      onChange(raw);
      return;
    }

    setLookup({ state: "resolving" });
    const seq = ++latest.current;
    const t = setTimeout(async () => {
      const result = await resolveUsername(raw);
      if (seq !== latest.current) return;
      if (result) {
        setLookup({ state: "found", result });
        onChange(result.settle_address);
      } else {
        setLookup({ state: "missing" });
        // Deliberately NOT the previous address. A name that does not resolve
        // must leave nothing payable behind it, or someone edits a good name
        // into a bad one and pays whoever the old one pointed at.
        onChange("");
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
    // onChange is a fresh closure on every parent render; depending on it would
    // re-run this on each keystroke elsewhere in the form and re-resolve.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const typedAddress = isAddress(text.trim());
  const resolved = lookup.state === "found";
  const isValid = !text || typedAddress || resolved;
  const showError =
    touched && !!text && !isValid && lookup.state !== "resolving";

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-mono text-ink-dim uppercase tracking-wider">
        Recipient
      </label>
      <div className="relative">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => setTouched(true)}
          placeholder={placeholder ?? "username or 0x..."}
          className={`w-full px-4 py-3 font-mono text-sm
                       bg-surface border transition-colors outline-none
                       text-ink placeholder:text-ink-dim
                       ${
                         showError
                           ? "border-danger/50 focus:border-danger"
                           : isValid && text
                             ? "border-signal/50 focus:border-signal"
                             : "border-border focus:border-ink-dim/30"
                       }`}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="none"
        />
        {isValid && text && lookup.state !== "resolving" && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-signal text-sm">
            ✓
          </span>
        )}
      </div>

      {/* Who the money is actually going to.
          Shown whenever a name resolved, because the whole risk of paying by
          name is that a name is not an address -- so the address it became is
          put on screen before anyone can send to it. */}
      {resolved && (
        <div className="flex items-center gap-2 border border-signal/30 bg-signal/5 px-3 py-2">
          <UserMark username={lookup.result.username} size="sm" />
          <span className="text-sm font-mono text-ink truncate">
            {lookup.result.display_name}
          </span>
          <span className="ml-auto text-scale-1 font-mono text-ink-dim shrink-0">
            {shortenAddress(lookup.result.settle_address)}
          </span>
        </div>
      )}

      {lookup.state === "resolving" && (
        <p className="text-xs text-ink-dim font-mono">Looking up {text.trim()}…</p>
      )}
      {showError && (
        <p className="text-xs text-danger font-mono">
          {lookup.state === "missing"
            ? `No one is using the name ${text.trim()}`
            : "Enter a username or a valid Ethereum address"}
        </p>
      )}
    </div>
  );
}
