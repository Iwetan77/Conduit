"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { wagmiConfig } from "@/lib/wagmi";
import { logAuth } from "@/lib/auth-debug";
import { AuthDebug } from "@/components/Shared/AuthDebug";
import {
  GOOGLE_LOGIN_EVENT,
  PrivyGateContext,
  hasOAuthCallback,
  hasPrivySession,
} from "@/lib/privy-gate";

const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";

// ~700 kB of @privy-io/* kept out of the payer-page bundle: loaded only for
// a returning Privy session, a dashboard route, or a Google sign-in click.
const PrivyStack = dynamic(() => import("./privy-stack"), { ssr: false });

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
    logAuth(
      `providers mount: session=${hasPrivySession()} callback=${hasOAuthCallback()} path=${window.location.pathname}`
    );
    if (hasPrivySession() || hasOAuthCallback()) setWantPrivy(true);
    const onLoginRequest = () => {
      logAuth("providers: login requested -> mounting Privy stack");
      setWantPrivy(true);
    };
    window.addEventListener(GOOGLE_LOGIN_EVENT, onLoginRequest);
    return () => window.removeEventListener(GOOGLE_LOGIN_EVENT, onLoginRequest);
  }, []);

  // Dashboard always needs Privy (merchant auth). Checked in render so the
  // stack starts loading on first client render, not after an effect tick.
  const privyOn =
    Boolean(PRIVY_APP_ID) && (wantPrivy || Boolean(pathname?.startsWith("/dashboard")));

  if (!privyOn) {
    return (
      <PrivyGateContext.Provider value={{ mounted: false, requestMount }}>
        <WagmiProvider config={wagmiConfig}>
          <QueryClientProvider client={queryClient}>
            {children}
            <AuthDebug />
          </QueryClientProvider>
        </WagmiProvider>
      </PrivyGateContext.Provider>
    );
  }

  return (
    <PrivyGateContext.Provider value={{ mounted: true, requestMount }}>
      <PrivyStack appId={PRIVY_APP_ID} queryClient={queryClient}>
        {children}
        <AuthDebug />
      </PrivyStack>
    </PrivyGateContext.Provider>
  );
}
