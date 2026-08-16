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

export default function CircleCallbackPage() {
  const router = useRouter();
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    // If the return-to redirect has not happened by now, the login either
    // failed or there was nowhere to go back to. Send them somewhere real
    // rather than leaving them on a page that only ever meant "in transit".
    const t = setTimeout(() => {
      setStalled(true);
      router.replace("/dashboard");
    }, 8000);
    return () => clearTimeout(t);
  }, [router]);

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      {stalled && (
        <p className="text-ink-dim text-sm font-mono">Taking you to the dashboard…</p>
      )}
    </main>
  );
}
