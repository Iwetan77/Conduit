"use client";

import { useEffect, useRef, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import { PrivyProvider, useLoginWithOAuth, usePrivy } from "@privy-io/react-auth";
import {
  WagmiProvider as PrivyWagmiProvider,
  createConfig as createPrivyWagmiConfig,
} from "@privy-io/wagmi";
import { wagmiConfigParams, arcTestnet } from "@/lib/wagmi";
import { logAuth } from "@/lib/auth-debug";
import {
  GOOGLE_LOGIN_ALREADY,
  GOOGLE_LOGIN_EVENT,
  GOOGLE_LOGIN_FAILED,
  GOOGLE_LOGIN_FLAG,
  GOOGLE_LOGIN_STARTED,
  hasOAuthCallback,
} from "@/lib/privy-gate";

// Privy-synced wagmi config: same chains/connectors as the plain one, but
// Privy-managed wallets (Google-login embedded wallets included) are synced
// in as wagmi connectors, so `useAccount` etc. see them like any injected
// wallet. Built here so @privy-io/wagmi stays in this lazy chunk.
const privyWagmiConfig = createPrivyWagmiConfig(wagmiConfigParams);

// The heavy half of the provider stack (~700 kB of @privy-io/*), loaded
// lazily by providers.tsx only when something actually needs Privy: a
// returning Privy session, a dashboard route, or a "Sign in with Google"
// click. Everything else ships the plain wagmi stack.
export default function PrivyStack({
  appId,
  queryClient,
  children,
}: {
  appId: string;
  queryClient: QueryClient;
  children: React.ReactNode;
}) {
  return (
    <PrivyProvider
      appId={appId}
      config={{
        // Google bypasses the OTP step; email falls back to OTP.
        loginMethods: ["email", "google"],
        // v3 splits embedded-wallet creation per chain family.
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
        appearance: {
          theme: "dark",
          accentColor: "#B2F55A",
        },
        supportedChains: [arcTestnet],
        defaultChain: arcTestnet,
      }}
    >
      <QueryClientProvider client={queryClient}>
        <PrivyWagmiProvider config={privyWagmiConfig}>
          <StartGoogleOAuth />
          <SyncSessionToken />
          {children}
        </PrivyWagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}

// The Google button (WalletConnect.tsx) may have been clicked BEFORE this
// stack was mounted — it sets a sessionStorage flag and fires an event.
// Consume the flag on mount, and answer the event when already mounted.
function StartGoogleOAuth() {
  const { initOAuth } = useLoginWithOAuth();
  const { ready, authenticated } = usePrivy();

  // A click can land before Privy has finished bootstrapping — this whole
  // stack is a lazy chunk, so on a phone the download plus init easily
  // outlives the click. Calling initOAuth against a not-yet-ready Privy is
  // what made sign-in intermittent: sometimes init won the race, sometimes it
  // didn't and the call went nowhere while the button sat on "Opening…".
  // Hold the request until `ready`, then fire it.
  //
  // `pending` MUST be state, not a ref. A ref assignment doesn't re-render, so
  // when the stack was already mounted and Privy already ready — the common
  // case once a session exists — the click set the flag and nothing ever
  // re-ran the effect that reads it. That hung every time, not just sometimes.
  const [pending, setPending] = useState(false);
  const fired = useRef(false);

  useEffect(() => {
    const request = () => {
      // Never restart OAuth while consuming a callback — that would bounce
      // the user back to Google in a loop.
      if (hasOAuthCallback()) {
        logAuth("stack: request ignored, consuming OAuth callback");
        return;
      }
      logAuth("stack: OAuth request queued");
      setPending(true);
    };
    try {
      if (sessionStorage.getItem(GOOGLE_LOGIN_FLAG)) request();
    } catch {}
    logAuth("stack: mounted, listening");
    window.addEventListener(GOOGLE_LOGIN_EVENT, request);
    return () => window.removeEventListener(GOOGLE_LOGIN_EVENT, request);
  }, []);

  // A queued request that never reaches `ready` means Privy itself failed to
  // bootstrap — a different failure from "the redirect didn't happen", and the
  // one that leaves the button on "Loading…" indefinitely. Name it instead of
  // waiting out the button's generic budget.
  useEffect(() => {
    if (!pending || ready) return;
    const t = setTimeout(() => {
      logAuth("stack: Privy never became ready");
      setPending(false);
      window.dispatchEvent(
        new CustomEvent(GOOGLE_LOGIN_FAILED, {
          detail: "Sign-in service didn't load. Reload the page and try again.",
        })
      );
    }, 20000);
    return () => clearTimeout(t);
  }, [pending, ready]);

  useEffect(() => {
    logAuth(`stack: ready=${ready} authed=${authenticated} pending=${pending}`);
    if (!pending || !ready || hasOAuthCallback()) return;
    if (fired.current) return;
    fired.current = true;
    setPending(false);
    try {
      sessionStorage.removeItem(GOOGLE_LOGIN_FLAG);
    } catch {}

    // Already signed in: initOAuth would reject, which used to surface as a
    // generic failure on a button the user clicked for no reason.
    if (authenticated) {
      fired.current = false;
      logAuth("stack: already authenticated, nothing to open");
      window.dispatchEvent(new Event(GOOGLE_LOGIN_ALREADY));
      return;
    }

    logAuth("stack: calling initOAuth(google)");
    window.dispatchEvent(new Event(GOOGLE_LOGIN_STARTED));
    // initOAuth rejects when the provider isn't enabled on the Privy app.
    // Unhandled, that left the button stuck on "Opening…" forever.
    Promise.resolve(initOAuth({ provider: "google" })).catch((err: unknown) => {
      fired.current = false;
      logAuth(`stack: initOAuth REJECTED: ${err instanceof Error ? err.message : String(err)}`);
      window.dispatchEvent(
        new CustomEvent(GOOGLE_LOGIN_FAILED, {
          detail: err instanceof Error ? err.message : "Google sign-in is unavailable.",
        })
      );
    });
  }, [pending, ready, authenticated, initOAuth]);

  return null;
}

// Keep the API bearer token in sync with Privy's (short-lived, rotating)
// access token for ANY signed-in page, not just the dashboard. /send needs it
// to create a settlement intent for a cross-currency payment, and previously
// only dashboard/layout.tsx did this — so a user who signed in on the landing
// page had no usable token anywhere else.
function SyncSessionToken() {
  const { authenticated, getAccessToken } = usePrivy();

  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    const refresh = async () => {
      const { setSessionToken } = await import("@/lib/conduit-api");
      const token = await getAccessToken();
      if (token && !cancelled) setSessionToken(token);
    };
    refresh();
    const id = setInterval(refresh, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [authenticated, getAccessToken]);

  return null;
}
