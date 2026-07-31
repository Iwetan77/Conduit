"use client";

import { createContext, useContext } from "react";

// Coordination between the always-loaded shell (providers.tsx, the Google
// button in WalletConnect.tsx, the dashboard layout) and the lazily-loaded
// Privy stack (app/privy-stack.tsx).

export const GOOGLE_LOGIN_EVENT = "conduit:google-login";
export const GOOGLE_LOGIN_FLAG = "conduit:google-login-pending";

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
