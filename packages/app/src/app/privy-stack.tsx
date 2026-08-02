"use client";

import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import { PrivyProvider, useLoginWithOAuth, usePrivy } from "@privy-io/react-auth";
import {
  WagmiProvider as PrivyWagmiProvider,
  createConfig as createPrivyWagmiConfig,
} from "@privy-io/wagmi";
import { wagmiConfigParams, arcTestnet } from "@/lib/wagmi";
import { GOOGLE_LOGIN_EVENT, GOOGLE_LOGIN_FAILED, GOOGLE_LOGIN_FLAG, hasOAuthCallback } from "@/lib/privy-gate";

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

  useEffect(() => {
    const start = () => {
      // Never restart OAuth while consuming a callback — that would bounce
      // the user back to Google in a loop.
      if (hasOAuthCallback()) return;
      try {
        sessionStorage.removeItem(GOOGLE_LOGIN_FLAG);
      } catch {}
      // initOAuth rejects when the provider isn't enabled on the Privy app.
      // Unhandled, that left the button stuck on "Opening…" forever.
      Promise.resolve(initOAuth({ provider: "google" })).catch((err: unknown) => {
        window.dispatchEvent(
          new CustomEvent(GOOGLE_LOGIN_FAILED, {
            detail: err instanceof Error ? err.message : "Google sign-in is unavailable.",
          })
        );
      });
    };
    try {
      if (sessionStorage.getItem(GOOGLE_LOGIN_FLAG)) start();
    } catch {}
    window.addEventListener(GOOGLE_LOGIN_EVENT, start);
    return () => window.removeEventListener(GOOGLE_LOGIN_EVENT, start);
  }, [initOAuth]);

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
