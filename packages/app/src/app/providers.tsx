"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { wagmiConfig } from "@/lib/wagmi";
import {
  GOOGLE_LOGIN_EVENT,
  PrivyGateContext,
  hasOAuthCallback,
  hasPrivySession,
} from "@/lib/privy-gate";

const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";

// Which identity provider is live. Defaults to privy so an unset variable
// changes nothing.
//
// This switches the whole provider tree, and it has to: @privy-io/wagmi's
// createConfig does `connectors: e.connectors?.filter((o) => "mock" === o.type)`
// and disables EIP-6963 discovery, so mounting the Privy stack removes every
// custom connector -- including Circle's -- from wagmi no matter what
// lib/wagmi declares. The two cannot run side by side in one config, so this
// is a switch rather than an addition.
const AUTH_PROVIDER = process.env.NEXT_PUBLIC_AUTH_PROVIDER ?? "privy";
const CIRCLE_AUTH = AUTH_PROVIDER === "circle";

// ~700 kB of @privy-io/* kept out of the payer-page bundle: loaded only for
// a returning Privy session, a dashboard route, or a Google sign-in click.
const PrivyStack = dynamic(() => import("./privy-stack"), { ssr: false });
const CircleStack = dynamic(() => import("./circle-stack"), { ssr: false });

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  const pathname = usePathname();
  const [wantPrivy, setWantPrivy] = useState(false);
  const requestMount = useCallback(() => setWantPrivy(true), []);

  useEffect(() => {
    // hasOAuthCallback: we're returning from Google. Without this the stack
    // stays unmounted, the callback is never consumed, and Google sign-in
    // appears to do nothing on a first login.
    if (hasPrivySession() || hasOAuthCallback()) setWantPrivy(true);
    const onLoginRequest = () => setWantPrivy(true);
    window.addEventListener(GOOGLE_LOGIN_EVENT, onLoginRequest);
    return () => window.removeEventListener(GOOGLE_LOGIN_EVENT, onLoginRequest);
  }, []);

  // The /dev spike routes must never mount Privy, and this is not a
  // preference — the two stacks cannot share a wagmi config.
  //
  // @privy-io/wagmi's createConfig does:
  //
  //   connectors: e.connectors?.filter((o) => "mock" === o.type)
  //
  // i.e. it discards every connector that is not a mock, and turns off
  // EIP-6963 discovery, supplying wallets through its own sync instead. So
  // whenever the Privy stack is mounted, injected(), walletConnect() and the
  // Circle connector are all absent from wagmi, whatever lib/wagmi declares.
  // A returning Privy session mounts that stack on EVERY route, which is what
  // left the Circle gate page looking at a connector list of one Privy-synced
  // wallet and no "circle" at all.
  const isDevRoute = Boolean(pathname?.startsWith("/dev/"));

  // Dashboard always needs Privy (merchant auth). Checked in render so the
  // stack starts loading on first client render, not after an effect tick.
  const privyOn =
    !CIRCLE_AUTH &&
    Boolean(PRIVY_APP_ID) &&
    !isDevRoute &&
    (wantPrivy || Boolean(pathname?.startsWith("/dashboard")));

  if (!privyOn) {
    return (
      <PrivyGateContext.Provider value={{ mounted: false, requestMount, walletSettled: true }}>
        <WagmiProvider config={wagmiConfig}>
          <QueryClientProvider client={queryClient}>
            {/* Circle needs no provider tree of its own -- it is a wagmi
                connector. This only translates the app's existing sign-in and
                sign-out events into connect/disconnect on it. */}
            {CIRCLE_AUTH && <CircleStack />}
            {children}
          </QueryClientProvider>
        </WagmiProvider>
      </PrivyGateContext.Provider>
    );
  }

  return (
    <PrivyGateContext.Provider value={{ mounted: true, requestMount, walletSettled: false }}>
      <PrivyStack appId={PRIVY_APP_ID} queryClient={queryClient}>
        {children}
      </PrivyStack>
    </PrivyGateContext.Provider>
  );
}
