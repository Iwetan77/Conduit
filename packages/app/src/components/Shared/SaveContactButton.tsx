"use client";

// "Save them", offered at the one moment it is obviously worth doing.
//
// A contact list only fills up if adding to it is free at a moment someone
// already cares. Just after paying is that moment: they have confirmed who the
// recipient is by sending them money, so there is nothing left to verify and
// nothing to type.
//
// Renders nothing when there is nobody to save it FOR (no connected wallet),
// or when this recipient is already saved — an offer to do something already
// done reads as the first one not having worked.
import { useState } from "react";
import { useAccount } from "wagmi";
import { useContacts } from "@/lib/contacts";
import { UserMark } from "@/components/Shared/UserMark";

export function SaveContactButton({
  address,
  label,
  username,
}: {
  address: string;
  /** What to call them in the list. */
  label: string;
  /** Present when they were paid by name, which is the durable handle. */
  username?: string;
}) {
  const { address: owner } = useAccount();
  const { save, has } = useContacts(owner);
  const [saved, setSaved] = useState(false);

  if (!owner || !address) return null;

  // `saved` is held locally as well as read from the hook so the button can
  // confirm the action rather than simply vanishing — a control that disappears
  // on click leaves someone unsure whether it worked.
  const already = saved || has({ username, address });

  if (already) {
    return (
      <p className="flex items-center justify-center gap-1.5 text-xs font-mono text-signal">
        <UserMark username={username} size="sm" />
        Saved to contacts
      </p>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        save({ username, address, label });
        setSaved(true);
      }}
      className="w-full text-xs font-mono text-ink-dim hover:text-signal transition-colors"
    >
      + Save {label} to contacts
    </button>
  );
}
