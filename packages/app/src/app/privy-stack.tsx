"use client";

import { useEffect, useRef, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import { PrivyProvider, useLoginWithOAuth, usePrivy } from "@privy-io/react-auth";
import type { ConnectedWallet, User } from "@privy-io/react-auth";
import {
  WagmiProvider as PrivyWagmiProvider,
  createConfig as createPrivyWagmiConfig,
} from "@privy-io/wagmi";
import { useDisconnect } from "wagmi";
import { wagmiConfigParams, arcTestnet } from "@/lib/wagmi";
import {
  GOOGLE_LOGIN_ALREADY,
  GOOGLE_LOGIN_EVENT,
  GOOGLE_LOGIN_FAILED,
  GOOGLE_LOGIN_FLAG,
  GOOGLE_LOGIN_STARTED,
  SIGN_OUT_EVENT,
  hasOAuthCallback,
} from "@/lib/privy-gate";

// Privy-synced wagmi config: same chains/connectors as the plain one, but
// Privy-managed wallets (Google-login embedded wallets included) are synced
// in as wagmi connectors, so `useAccount` etc. see them like any injected
// wallet. Built here so @privy-io/wagmi stays in this lazy chunk.
const privyWagmiConfig = createPrivyWagmiConfig(wagmiConfigParams);

// Which of Privy's wallets wagmi should treat as the connected account.
//
// This prop is what finally made Google sign-in usable. Without it,
// @privy-io/wagmi drives the connection through wagmi's connect(), which
// performs an eth_requestAccounts handshake against the wallet's provider.
// For the Privy embedded wallet that handshake failed: wagmi went
// `connecting` -> `disconnected` within a millisecond, leaving useAccount()
// empty and every surface rendering the signed-out "Sign in with Google"
// button to a user who was fully signed in.
//
// With this prop set, @privy-io/wagmi takes its other code path and writes
// the connected state directly (connector, accounts, chainId), skipping the
// handshake entirely.
//
// The embedded wallet wins whenever the user has one.
//
// This used to prefer an EXTERNAL wallet, on the reasoning that someone who
// deliberately connected MetaMask should pay from it. The reasoning was wrong,
// because "connected" isn't deliberate: a browser extension auto-connects on
// page load. So signing in with Google gave you your Conduit wallet on a phone
// and MetaMask on a laptop that happened to have the extension installed --
// same account, same login, two different addresses, and the laptop one empty.
// The result was a user staring at a 0.00 balance for funds they were holding.
//
// Someone who has no embedded wallet -- a payer who connected a real wallet
// instead of signing in -- still gets that wallet, because it's the only one
// in the list. Nothing about that path changes.
//
// The trade-off this accepts: a Privy-signed-in user cannot currently choose to
// pay from an external wallet on Arc. That needs an explicit wallet switcher,
// which is a feature; being silently handed the wrong wallet is a bug.
const pickWalletForWagmi = ({ wallets }: { wallets: ConnectedWallet[]; user: User | null }) =>
  wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];

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
        // NOTE: showWalletUIs:false was tried here to hide Privy's raw-EIP-712
        // confirmation modal (scary JSON for a normie), but it broke the send
        // path -- with the network proven healthy (/debug/net all green),
        // embedded-wallet transactions started failing with "Load failed" only
        // after it was set. The raw EIP-1193 send path we use (wagmi connector
        // -> ethers -> sendTransaction) needs Privy's UI flow to complete the
        // transaction, so leave the default (UI shown). Hiding the JSON is a
        // separate UX task to solve without disabling the send UI.
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
        <PrivyWagmiProvider config={privyWagmiConfig} setActiveWalletForWagmi={pickWalletForWagmi}>
          <StartGoogleOAuth />
          <HandleSignOut />
          <EnsureEmbeddedWallet />
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

  useEffect(() => {
    const request = () => {
      // Never restart OAuth while consuming a callback — that would bounce
      // the user back to Google in a loop.
      if (hasOAuthCallback()) {
        return;
      }
      setPending(true);
    };
    try {
      if (sessionStorage.getItem(GOOGLE_LOGIN_FLAG)) request();
    } catch {}
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
    if (!pending || !ready || hasOAuthCallback()) return;
    setPending(false);
    try {
      sessionStorage.removeItem(GOOGLE_LOGIN_FLAG);
    } catch {}

    // Already signed in: initOAuth would reject, which used to surface as a
    // generic failure on a button the user clicked for no reason.
    if (authenticated) {
      window.dispatchEvent(new Event(GOOGLE_LOGIN_ALREADY));
      return;
    }

    window.dispatchEvent(new Event(GOOGLE_LOGIN_STARTED));
    // initOAuth rejects when the provider isn't enabled on the Privy app.
    // Unhandled, that left the button stuck on "Opening…" forever.
    Promise.resolve(initOAuth({ provider: "google" })).catch((err: unknown) => {
      window.dispatchEvent(
        new CustomEvent(GOOGLE_LOGIN_FAILED, {
          detail: err instanceof Error ? err.message : "Google sign-in is unavailable.",
        })
      );
    });
  }, [pending, ready, authenticated, initOAuth]);

  return null;
}

// Signing out, done in the one order that actually leaves a clean slate:
// Privy first (it owns the session and the embedded wallet), then wagmi.
//
// Doing only the wagmi half is what stranded the app in an unrecoverable
// state -- see SIGN_OUT_EVENT in privy-gate.tsx.
function HandleSignOut() {
  const { logout } = usePrivy();
  const { disconnect } = useDisconnect();

  useEffect(() => {
    const onSignOut = () => {
      Promise.resolve(logout())
        .catch(() => {})
        .finally(() => disconnect());
    };
    window.addEventListener(SIGN_OUT_EVENT, onSignOut);
    return () => window.removeEventListener(SIGN_OUT_EVENT, onSignOut);
  }, [logout, disconnect]);

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
      return;
    }

    attempted.current = true;
    Promise.resolve(createWallet())
      .catch((err: unknown) => {
        attempted.current = false;
      });
  }, [ready, authenticated, user, createWallet]);

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
