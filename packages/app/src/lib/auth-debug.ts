"use client";

// A visible trace of the Google sign-in handshake.
//
// Sign-in spans three pieces that can't see each other: the button
// (WalletConnect), the lazy mount decision (providers.tsx) and the Privy stack
// itself (privy-stack.tsx). When it hangs, the button can only report "still
// waiting" — it has no idea whether the chunk failed to download, Privy never
// finished booting, or initOAuth was called and the redirect didn't happen.
// Diagnosing that by reading code has been guesswork; this makes each step say
// so out loud.
//
// Off unless the URL carries ?debug=auth, so it costs nothing normally.

export interface AuthLogEntry {
  t: number;
  msg: string;
}

const LOG: AuthLogEntry[] = [];
export const AUTH_LOG_EVENT = "conduit:auth-log";

export function authDebugEnabled(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("debug") === "auth";
  } catch {
    return false;
  }
}

export function logAuth(msg: string) {
  if (typeof window === "undefined") return;
  LOG.push({ t: Date.now(), msg });
  // Always goes to the console — free, and survives a redirect if the browser
  // is set to preserve logs.
  console.info("[conduit:auth]", msg);
  try {
    window.dispatchEvent(new Event(AUTH_LOG_EVENT));
  } catch {}
}

export function readAuthLog(): AuthLogEntry[] {
  return LOG;
}
