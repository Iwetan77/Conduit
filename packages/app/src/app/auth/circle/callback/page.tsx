"use client";

// Where Google returns after a Circle sign-in.
//
// A real product route, not a dev page. Google redirects to ONE registered
// URI, so every Circle login in the app lands here regardless of where it
// started — a payer paying a link, a merchant opening the dashboard. Pointing
// that at a spike page meant a payer mid-payment was dropped onto an internal
// test harness.
//
// There is deliberately almost nothing here. Merely loading the app completes
// the login: the Circle connector's setup() consumes the callback hash, and
// restoreSession() sends the user back where they started. This page only has
// to exist, be registered with Google, and say something honest while that
// happens.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function CircleCallbackPage() {
  const router = useRouter();
  const [slow, setSlow] = useState(false);
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    // Say nothing at first. Privy signed in through a popup, so the page never
    // navigated and there was no return trip to render; Circle's SDK navigates
    // the whole tab, and Google requires one registered redirect URI, so this
    // page has to exist. Any text on it reads as an extra step in sign-in.
    //
    // 3s, not the 1.2s this started at: the resume reattaches the SDK and
    // validates the token against Circle, which was measured at ~1s on its own
    // and is slower on a cold load. Blank for that window looks like the
    // redirect it is. Past 3s something is genuinely wrong and silence would be
    // worse than a word.
    const quiet = setTimeout(() => setSlow(true), 3000);
    // If the return-to redirect has not happened by now, the login either
    // failed or there was nowhere to go back to. Send them somewhere real
    // rather than leaving them on a page that only ever meant "in transit".
    const t = setTimeout(() => {
      setStalled(true);
      router.replace("/dashboard");
    }, 8000);
    return () => {
      clearTimeout(quiet);
      clearTimeout(t);
    };
  }, [router]);

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      {slow && (
        <p className="text-ink-dim text-sm font-mono">
          {stalled ? "Taking you to the dashboard…" : "Finishing sign-in…"}
        </p>
      )}
    </main>
  );
}
