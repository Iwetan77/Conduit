"use client";

import { useEffect, useState } from "react";

/**
 * False on the server and on the first client render, true immediately after.
 *
 * Wallet state is not knowable on the server: whether an extension is installed,
 * which account it auto-reconnected, whether a Circle session is being resumed.
 * Rendering any of that during the first pass makes the server's HTML and the
 * browser's first render disagree, which React rejects outright. So the first
 * pass has to render something that does not depend on a wallet, and this is the
 * flag that says which pass you are in.
 *
 * It replaced nine hand-rolled copies of the same three lines. That is not
 * merely repetition: they had already drifted. Some blanked their whole
 * component with `return null`, one blanked the entire pay panel on a checkout
 * page, and exactly one — Nav — did the correct thing and reserved a box of the
 * right size. One copy of a rule is one place to fix it.
 *
 * **What to render while this is false.** Not `null`. A component that renders
 * nothing and then renders something has moved the page, and moving the page is
 * the flash this whole flag exists to avoid — it just relocates it from "wrong
 * content" to "no content". Reserve the same box the settled branch occupies:
 *
 * ```tsx
 * if (!hydrated) return <div className="h-9 w-32" aria-hidden />;
 * ```
 *
 * The exception is a component whose settled branch may legitimately render
 * nothing at all, where a placeholder would reserve space for something that
 * never arrives.
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}
