"use client";

import { createContext, useContext } from "react";

// Coordination between the always-loaded shell (providers.tsx, the Google
// button in WalletConnect.tsx, the dashboard layout) and the lazily-loaded
// Privy stack (app/privy-stack.tsx).

export const GOOGLE_LOGIN_EVENT = "conduit:google-login";
export const GOOGLE_LOGIN_FLAG = "conduit:google-login-pending";
// Dispatched when OAuth can't start (e.g. the provider isn't enabled on the
// Privy app) so the button can stop saying "Opening…" and say what broke.
export const GOOGLE_LOGIN_FAILED = "conduit:google-login-failed";
// Dispatched the moment initOAuth is actually called — i.e. the ~700 kB Privy
// chunk has downloaded AND Privy has finished bootstrapping. The button uses
// this to tell "still booting" apart from "redirect isn't happening", which
// need very different timeouts on a phone.
export const GOOGLE_LOGIN_STARTED = "conduit:google-login-started";
// Dispatched when the click is a no-op because Privy already has a session.
export const GOOGLE_LOGIN_ALREADY = "conduit:google-login-already";

export interface PrivyGate {
  // True once the Privy provider stack is mounted (hooks like usePrivy are
  // only safe to call from components rendered under it).
  mounted: boolean;
  // Ask providers.tsx to mount the Privy stack (idempotent).
  requestMount: () => void;
}

export const PrivyGateContext = createContext<PrivyGate>({
  mounted: false,
  requestMount: () => {},
});

export function usePrivyGate(): PrivyGate {
  return useContext(PrivyGateContext);
}

// Fired by the Google sign-in button: flags intent (in case the stack isn't
// mounted yet) and pokes both providers.tsx (to mount) and privy-stack
// (to start OAuth if already mounted).
export function requestGoogleLogin() {
  try {
    sessionStorage.setItem(GOOGLE_LOGIN_FLAG, "1");
  } catch {}
  window.dispatchEvent(new Event(GOOGLE_LOGIN_EVENT));
}

// True when we've just been redirected back from an OAuth provider. Privy's
// initOAuth() sends the browser to Google and returns to the app with these
// query params; the Privy stack MUST be mounted for that callback to be
// consumed, or the sign-in silently does nothing. On a first-ever login
// there is no privy: localStorage key yet and the sessionStorage intent flag
// is already spent, so this is the only signal that a login is in flight.
export function hasOAuthCallback(): boolean {
  try {
    const q = new URLSearchParams(window.location.search);
    return q.has("privy_oauth_code") || q.has("privy_oauth_state");
  } catch {
    return false;
  }
}

// Heuristic for "this browser has a Privy session worth restoring" — Privy
// persists its auth state under privy: keys in localStorage.
export function hasPrivySession(): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("privy:")) return true;
    }
  } catch {}
  return false;
}
