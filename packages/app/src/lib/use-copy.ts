"use client";

import { useCallback, useRef, useState } from "react";

// Copy-to-clipboard with a short-lived "copied" acknowledgement. Every copy
// button in the app used to fire navigator.clipboard.writeText() and give the
// user nothing back -- the label sat unchanged, so there was no way to tell a
// successful copy from a dead button. This centralises that: `copied` holds
// the key of the most recently copied item (so table rows can each show their
// own state) and clears itself after `resetMs`.
export function useCopy(resetMs = 1600) {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const copy = useCallback(
    async (text: string, key = "default") => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(key);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(null), resetMs);
      } catch {
        // Clipboard can reject (insecure context, permission) -- there's
        // nothing to recover, and pretending it copied would be worse.
      }
    },
    [resetMs]
  );

  return { copied, copy };
}
