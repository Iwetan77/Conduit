"use client";

import { useEffect, useRef, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import { PrivyProvider, useLoginWithOAuth, usePrivy, useWallets } from "@privy-io/react-auth";
import {
  WagmiProvider as PrivyWagmiProvider,
  createConfig as createPrivyWagmiConfig,
  useSetActiveWallet,
} from "@privy-io/wagmi";
import { useAccount } from "wagmi";
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
          <EnsureEmbeddedWallet />
          <SyncActiveWallet />
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

// Google sign-in only counts once the user has a wallet — an authenticated
// Privy session with no wallet syncs nothing into wagmi, so `useAccount` stays
// empty and every surface keeps showing "Sign in with Google" to someone who
// is already signed in. Clicking it then does nothing, correctly but
// uselessly, which is exactly the hang that looked like broken OAuth.
//
// The PrivyProvider config below asks for createOnLogin, but the Privy
// dashboard's embedded_wallet_config is authoritative and was set to "off",
// so no wallet was ever provisioned. Creating it here makes sign-in work
// regardless of that setting rather than depending on remote config we don't
// control from the repo.
function EnsureEmbeddedWallet() {
  const { ready, authenticated, user, createWallet } = usePrivy();
  const attempted = useRef(false);

  useEffect(() => {
    if (!ready || !authenticated || attempted.current) return;

    const hasWallet = (user?.linkedAccounts ?? []).some(
      (a) => a.type === "wallet" && (a as { walletClientType?: string }).walletClientType === "privy"
    );
    if (hasWallet) {
      logAuth("stack: embedded wallet present");
      return;
    }

    attempted.current = true;
    logAuth("stack: no embedded wallet, creating one");
    Promise.resolve(createWallet())
      .then(() => logAuth("stack: embedded wallet created"))
      .catch((err: unknown) => {
        attempted.current = false;
        logAuth(`stack: createWallet failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  }, [ready, authenticated, user, createWallet]);

  return null;
}

// Make Privy's wallet the active wagmi connection.
//
// This is the step that was missing entirely. @privy-io/wagmi does NOT adopt a
// wallet on its own — its WagmiProvider picks an active wallet from the ones
// Privy reports, and with only an embedded wallet present it left wagmi
// disconnected. The ?debug=auth trace showed the end state precisely:
// `authed=true`, `embedded wallet present`, and yet useAccount() had no
// address, so every surface kept rendering the signed-out "Sign in with
// Google" button to a fully signed-in user. Clicking it then correctly did
// nothing, which is what made this look like an OAuth failure for days.
//
// Prefer the embedded wallet, fall back to whatever Privy has connected.
function SyncActiveWallet() {
  const { ready, authenticated } = usePrivy();
  const { wallets } = useWallets();
  const { setActiveWallet } = useSetActiveWallet();
  const { isConnected } = useAccount();
  const activating = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!ready || !authenticated || isConnected) return;
    if (wallets.length === 0) {
      logAuth("stack: authenticated but Privy reports no wallets yet");
      return;
    }

    const wallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
    if (!wallet || activating.current === wallet.address) return;

    activating.current = wallet.address;
    logAuth(`stack: activating ${wallet.walletClientType} wallet ${wallet.address}`);
    Promise.resolve(setActiveWallet(wallet))
      .then(() => logAuth("stack: wallet is now active in wagmi"))
      .catch((err: unknown) => {
        activating.current = undefined;
        logAuth(
          `stack: setActiveWallet failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
  }, [ready, authenticated, isConnected, wallets, setActiveWallet]);

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
