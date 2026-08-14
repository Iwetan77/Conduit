"use client";

import { createContext, useContext } from "react";

// Coordination between the always-loaded shell (providers.tsx, the Google
// button in WalletConnect.tsx, the dashboard layout) and the lazily-loaded
// Circle stack (app/circle-stack.tsx).
//
// Was `lib/privy-gate.tsx`. The shape survived the migration from Privy to
// Circle unchanged, because it never described Privy — it describes "the
// identity provider boots asynchronously and the shell has to wait for it",
// which is true of any of them. Only the Privy-specific helpers were dropped:
//
//   hasPrivySession()  — scanned localStorage for `privy:` keys, so the stack
//                        could be mounted for a returning user. Circle needs no
//                        equivalent: it is a wagmi connector, its setup() runs
//                        on every load, and hasPersistedSession() in
//                        lib/circle/browser.ts answers the same question for
//                        the code that still asks it.
//   hasOAuthCallback() — looked for ?privy_oauth_code / ?privy_oauth_state.
//                        Circle returns to a dedicated route
//                        (/auth/circle/callback) with the payload in the URL
//                        hash, consumed by the connector's setup(), so there is
//                        nothing for the shell to detect.
//
// The event names are deliberately unchanged from the Privy era. They are an
// internal protocol between the button and the stack, and renaming them would
// have meant touching every listener during a migration whose whole strategy
// was to leave call sites alone.

export const GOOGLE_LOGIN_EVENT = "conduit:google-login";
export const GOOGLE_LOGIN_FLAG = "conduit:google-login-pending";
// Dispatched when sign-in can't start, carrying the reason as event.detail so
// the button can stop saying "Opening…" and say what actually broke.
export const GOOGLE_LOGIN_FAILED = "conduit:google-login-failed";
// Dispatched the moment the redirect to Google is actually under way — i.e.
// the lazily-loaded Circle chunk has downloaded AND the SDK has minted a device
// token. The button uses this to tell "still booting" apart from "redirect
// isn't happening", which need very different timeouts on a phone.
export const GOOGLE_LOGIN_STARTED = "conduit:google-login-started";
// Dispatched when the click is a no-op because a session already exists.
export const GOOGLE_LOGIN_ALREADY = "conduit:google-login-already";

export interface WalletGate {
  // True once the identity stack is mounted.
  mounted: boolean;
  // Ask providers.tsx to mount the stack (idempotent).
  requestMount: () => void;
  // True when useAccount()'s address can be trusted as final.
  //
  // A browser extension auto-connects on page load, while the Circle session is
  // restored asynchronously and only then adopted by wagmi. For roughly a
  // second, useAccount() therefore reports whichever wallet won the race —
  // which is how signing in with Google briefly showed a MetaMask address
  // before swapping to the Conduit one. Anything that DISPLAYS an address (and
  // offers to copy it) or reads a balance must wait for this, or it shows the
  // user an account that isn't theirs and invites them to send funds to it.
  //
  // The race is identical under Circle; only the thing that wins it late
  // changed.
  walletSettled: boolean;
}

export const WalletGateContext = createContext<WalletGate>({
  mounted: false,
  requestMount: () => {},
  walletSettled: true,
});

export function useWalletGate(): WalletGate {
  return useContext(WalletGateContext);
}

// Fired by the Google sign-in button: flags intent (in case the stack isn't
// mounted yet) and pokes both providers.tsx (to mount) and circle-stack (to
// start sign-in if already mounted).
export function requestGoogleLogin() {
  try {
    sessionStorage.setItem(GOOGLE_LOGIN_FLAG, "1");
  } catch {
    // Storage unavailable (private browsing). The event below still fires; the
    // flag is only a hint for a stack that hasn't mounted yet.
  }
  window.dispatchEvent(new Event(GOOGLE_LOGIN_EVENT));
}

// Signing out has to tear down BOTH halves, and in the right order.
//
// wagmi's disconnect() only tears down the wagmi side; the Circle session
// survives in localStorage, so the connector's isAuthorized() still says yes
// and the next page load silently signs the user back in. Under Privy this was
// the same dead end for a different reason (@privy-io/wagmi re-synced the
// connection), and the escape was the same: clear site data. Handled inside
// circle-stack.tsx, which does disconnectAsync() then clearCircleSession().
export const SIGN_OUT_EVENT = "conduit:sign-out";

export function requestSignOut() {
  window.dispatchEvent(new Event(SIGN_OUT_EVENT));
}
