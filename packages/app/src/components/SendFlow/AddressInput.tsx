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
import { useAccount } from "wagmi";
import { isAddress } from "viem";
import { resolveUsername, type UsernameResolution } from "@/lib/conduit-api";
import { shortenAddress } from "@/lib/format";
import { UserMark } from "@/components/Shared/UserMark";
import { contactId, useContacts } from "@/lib/contacts";

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

  // What this field last told the parent. Anything else arriving in `value` came
  // from somewhere ELSE -- a QR scan, a form reset -- and should replace what is
  // in the box.
  const reported = useRef(value);

  const report = (v: string) => {
    reported.current = v;
    onChange(v);
  };

  // Adopt an externally-set value, and ONLY an externally-set one.
  //
  // This used to compare against `value` directly and also re-run whenever the
  // lookup state changed, which made the field unusable: typing the third
  // character of a name starts a debounced lookup, and during that debounce the
  // parent still holds the two-character value. The effect then fired on the
  // state change, saw text !== value, and reset the box to two characters. It
  // was impossible to type a name at all -- "iva" became "iv" on every attempt.
  //
  // Comparing against what we last REPORTED is the fix: while a lookup is in
  // flight the parent is legitimately behind us, and being behind is not the
  // same as having been changed by someone else.
  useEffect(() => {
    if (value !== reported.current) {
      reported.current = value;
      setText(value);
    }
  }, [value]);

  useEffect(() => {
    const raw = text.trim();

    if (isAddress(raw)) {
      setLookup({ state: "idle" });
      report(raw);
      return;
    }
    if (!looksLikeUsername(raw)) {
      setLookup({ state: "idle" });
      // Report the raw text so the parent's own validation still sees a
      // half-typed address as invalid rather than as an empty field.
      report(raw);
      return;
    }

    setLookup({ state: "resolving" });
    const seq = ++latest.current;
    const t = setTimeout(async () => {
      const result = await resolveUsername(raw);
      if (seq !== latest.current) return;
      if (result) {
        setLookup({ state: "found", result });
        report(result.settle_address);
      } else {
        setLookup({ state: "missing" });
        // Deliberately NOT the previous address. A name that does not resolve
        // must leave nothing payable behind it, or someone edits a good name
        // into a bad one and pays whoever the old one pointed at.
        report("");
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
    // onChange is a fresh closure on every parent render; depending on it would
    // re-run this on each keystroke elsewhere in the form and re-resolve.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  // Contacts belong to the wallet doing the saving, so the list follows the
  // signed-in wallet rather than the browser.
  const { address: owner } = useAccount();
  const { contacts, save: saveCurrent, remove: removeSaved, has } = useContacts(owner);

  const typedAddress = isAddress(text.trim());
  // Looser than looksLikeUsername on purpose: the suffix should appear from the
  // first letter, while the LOOKUP still waits for three. Someone typing "iv"
  // is plainly typing a name and should be able to see that the app knows it.
  const nameLike = !!text.trim() && !text.trim().startsWith("0x");
  const resolved = lookup.state === "found";
  // Offered only for a recipient that is actually settled -- a resolved name or
  // a complete address -- and never for one already saved. Saving a
  // half-typed address is how a contact list fills with things that cannot be
  // paid.
  const canSave =
    !!owner &&
    (resolved || typedAddress) &&
    !has(
      resolved
        ? { username: lookup.result.username, address: lookup.result.settle_address }
        : { address: text.trim() },
    );
  const isValid = !text || typedAddress || resolved;
  const showError =
    touched && !!text && !isValid && lookup.state !== "resolving";

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-mono text-ink-dim uppercase tracking-wider">
        Recipient
      </label>
      {/* The suffix lives in the BOX, never in the input.
          Typing a name should not require typing "@ conduit" too -- that is how
          the name reads, not part of the name, and anyone who typed it would
          fail validation on a character the field itself put in their head. So
          the box is the bordered element and the input sits inside it
          transparently, with the suffix beside it as furniture.

          Only while a NAME is being typed. An address is not @ anything, and
          hanging the suffix off 0x… would suggest it were. */}
      <div
        className={`flex items-center border bg-surface px-4 transition-colors ${
          showError
            ? "border-danger/50 focus-within:border-danger"
            : isValid && text
              ? "border-signal/50 focus-within:border-signal"
              : "border-border focus-within:border-ink-dim/30"
        }`}
      >
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => setTouched(true)}
          placeholder={placeholder ?? "username or 0x..."}
          className="flex-1 min-w-0 bg-transparent py-3 font-mono text-sm
                     text-ink outline-none placeholder:text-ink-dim"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="none"
        />
        {nameLike && (
          <span aria-hidden className="shrink-0 pl-2 font-mono text-sm text-ink-dim/60 select-none">
            @ conduit
          </span>
        )}
        {isValid && text && lookup.state !== "resolving" && (
          <span className="shrink-0 pl-2 text-signal text-sm">✓</span>
        )}
      </div>

      {/* Who the money is actually going to.
          Shown whenever a name resolved, because the whole risk of paying by
          name is that a name is not an address -- so the address it became is
          put on screen before anyone can send to it.

          The account TYPE is on it because one wallet can hold both a personal
          and a business account, and both can hold a name. @Ivan resolving to
          "Ivan and Sons" is correct and still reads as a surprise unless the
          screen says it is the business. One namespace, stated plainly. */}
      {resolved && (
        <div className="flex items-center gap-2 border border-signal/30 bg-signal/5 px-3 py-2">
          <UserMark username={lookup.result.username} size="sm" />
          <span className="text-sm font-mono text-ink truncate">
            {lookup.result.display_name}
          </span>
          <span
            className={`shrink-0 px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider border ${
              lookup.result.account_type === "business"
                ? "border-signal/40 text-signal"
                : "border-border text-ink-dim"
            }`}
          >
            {lookup.result.account_type === "business" ? "Business" : "Personal"}
          </span>
          <span className="ml-auto text-scale-1 font-mono text-ink-dim shrink-0">
            {shortenAddress(lookup.result.settle_address)}
          </span>
        </div>
      )}

      {/* Save, right where the decision is made.
          A contact list nobody can add to is furniture, and a separate screen
          for adding one is a screen nobody visits. The moment you have just
          confirmed who someone is, is the moment saving them costs nothing. */}
      {canSave && (
        <button
          type="button"
          onClick={() =>
            saveCurrent({
              username: resolved ? lookup.result.username : undefined,
              address: resolved ? lookup.result.settle_address : text.trim(),
              label: resolved ? lookup.result.display_name : shortenAddress(text.trim()),
            })
          }
          className="self-start text-scale-1 font-mono text-ink-dim hover:text-signal transition-colors"
        >
          + Save to contacts
        </button>
      )}

      {/* The list, only when the field is empty.
          It is a shortcut for starting, not a thing to read while typing -- and
          showing it under a half-typed name would compete with the resolution
          above it. */}
      {!text && contacts.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {contacts.map((c) => (
            <span key={contactId(c)} className="group inline-flex items-center">
              <button
                type="button"
                onClick={() => setText(c.username ?? c.address)}
                className="flex items-center gap-1.5 border border-border px-2 py-1
                           font-mono text-scale-1 text-ink-dim
                           hover:text-ink hover:border-ink-dim/40 transition-colors"
              >
                <UserMark username={c.username} size="sm" />
                {c.label}
              </button>
              <button
                type="button"
                aria-label={`Remove ${c.label} from contacts`}
                onClick={() => removeSaved(contactId(c))}
                className="ml-0.5 px-1 text-ink-dim/40 hover:text-danger transition-colors"
              >
                ×
              </button>
            </span>
          ))}
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
