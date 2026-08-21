"use client";

// Where Google returns after a Circle sign-in.
//
// A real product route, not a dev page. Google redirects to ONE registered
// URI, so every Circle login in the app lands here regardless of where it
// started — a payer paying a link, a merchant opening the dashboard. Pointing
// that at a spike page meant a payer mid-payment was dropped onto an internal
// test harness.
//
// There is deliberately NOTHING rendered here on the happy path.
//
// Privy signed in through a popup, so the merchant's page never navigated and
// there was no return trip to see. Circle's SDK does
// `this.window.location.href = url` (checked in its source, there is no popup
// option), and Google will only return to a redirect URI registered in advance
// -- so this route must exist and must be a real page. It cannot be removed
// without driving the OAuth flow ourselves in a window we opened.
//
// What it CAN do is never say anything. Any text here reads as an extra step in
// sign-in, and it flashed up and vanished on a perfectly normal login. Merely
// loading the app completes the login: the connector's setup() consumes the
// callback hash and restoreSession() sends the user back where they started.
// The only message left is the one that admits defeat after 8 seconds.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { SkeletonBlock } from "@/components/Shared/Skeleton";

export default function CircleCallbackPage() {
  const router = useRouter();
  const [stalled, setStalled] = useState(false);
  // Silence first, then a shape. See below.
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    // The happy path returns well inside this, and showing nothing while it
    // does is the whole point of the page -- see the note at the top of the
    // file. But when it does NOT return, the old version left a blank screen
    // for the FULL eight seconds before saying a word, which reads as a dead
    // tab rather than as a login in progress.
    //
    // 1200ms is chosen to sit past a normal return, so a successful sign-in
    // never sees this: it is a signal that something is taking longer than it
    // should, not a step in the flow.
    const slowTimer = setTimeout(() => setSlow(true), 1200);

    // If the return-to redirect has not happened by now, the login either
    // failed or there was nowhere to go back to. Send them somewhere real
    // rather than leaving them on a page that only ever meant "in transit".
    const t = setTimeout(() => {
      setStalled(true);
      router.replace("/dashboard");
    }, 8000);
    return () => {
      clearTimeout(slowTimer);
      clearTimeout(t);
    };
  }, [router]);

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      {/* A skeleton, never a sentence.
          Text here reads as an extra step in signing in -- "Completing
          sign-in…" invites the user to wonder what else is required of them --
          and it flashed up and vanished on perfectly normal logins. A shape
          says "this is loading" without claiming anything is being asked of
          them. The one sentence on this page stays where it was: the bail-out,
          which is the only moment something genuinely changed. */}
      {slow && !stalled && (
        <div className="w-full max-w-sm space-y-3" aria-busy="true">
          <span className="sr-only">Completing sign-in</span>
          <SkeletonBlock className="h-10 w-full" />
          <SkeletonBlock className="h-4 w-2/3" />
          <SkeletonBlock className="h-4 w-1/2" />
        </div>
      )}
      {stalled && (
        <p className="text-ink-dim text-sm font-mono">Taking you to the dashboard…</p>
      )}
    </main>
  );
}
