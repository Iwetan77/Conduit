"use client";

// Asks for a username once, when there is somewhere to put one.
//
// Mounted globally rather than per page, because "first sign-in" is not a
// route: someone can arrive signed in on /send, /create or the dashboard, and
// the ask should happen wherever that is.
//
// It renders nothing at all until every condition holds — no session or wallet,
// a Solana wallet, a name already claimed, or a lookup still in flight all
// produce null. That matters because this sits above the whole app: a component
// mounted everywhere must cost nothing on the pages it has no business on.
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useHydrated } from "@/lib/use-hydrated";
import { USERNAME_PROMPT_EVENT, useUsername } from "@/lib/use-username";

// The prompt is a modal almost nobody sees twice, so its code should not be in
// the first load of every page.
const UsernamePrompt = dynamic(
  () => import("@/components/Shared/UsernamePrompt").then((m) => m.UsernamePrompt),
  { ssr: false },
);

/**
 * Dismissal lives for the tab, not forever.
 *
 * "Not now" has to mean not now, or the modal reappears on the next navigation
 * and becomes something to fight rather than an offer. sessionStorage, not
 * localStorage: they should be asked again on a future visit, since a username
 * is worth having and skipping once is not a decision to never be asked.
 */
const DISMISS_KEY = "conduit.usernamePromptDismissed";

export function UsernameGate() {
  const hydrated = useHydrated();
  const { shouldPrompt, eligible, username } = useUsername();
  const [dismissed, setDismissed] = useState(true);
  // Asked for explicitly, from the wallet menu. Overrides the dismissal --
  // someone who just clicked "Set a username" is not to be told they already
  // said not now.
  const [requested, setRequested] = useState(false);

  // Starts dismissed and is released after mount, so the server render and the
  // first client render agree — reading sessionStorage during render would be
  // a hydration mismatch, and this component is above every page.
  useEffect(() => {
    try {
      setDismissed(window.sessionStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      setDismissed(false);
    }
  }, []);

  useEffect(() => {
    const open = () => setRequested(true);
    window.addEventListener(USERNAME_PROMPT_EVENT, open);
    return () => window.removeEventListener(USERNAME_PROMPT_EVENT, open);
  }, []);

  // Two ways in: the automatic first-sign-in ask, and an explicit request from
  // the wallet menu. The explicit one ignores the dismissal but still respects
  // the facts -- there is nothing to ask a Solana wallet, or someone who
  // already has a name.
  const asked = requested && eligible && !username;
  if (!hydrated) return null;
  if (!asked && (dismissed || !shouldPrompt)) return null;

  return (
    <UsernamePrompt
      onDone={() => {
        try {
          window.sessionStorage.setItem(DISMISS_KEY, "1");
        } catch {
          // Private browsing or quota. Non-fatal: the worst case is being
          // asked again on the next navigation, and the claim itself is
          // recorded server-side either way.
        }
        setDismissed(true);
        setRequested(false);
      }}
    />
  );
}
