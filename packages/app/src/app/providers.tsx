"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import dynamic from "next/dynamic";
import { useCallback, useState } from "react";
import { wagmiConfig } from "@/lib/wagmi";
import { WalletGateContext } from "@/lib/wallet-gate";
// STATIC, not dynamic(ssr:false). This wraps every child of the root layout,
// so making it client-only made the entire application client-only: no page
// server-rendered its body, and every route shipped an empty shell that filled
// in after hydration. It lives in its own module now precisely so it can be
// imported here without dragging the Circle SDK onto the server render path.
import { CircleWalletGate } from "./circle-wallet-gate";
import { UsernameGate } from "@/components/Shared/UsernameGate";

// Identity is Circle Wallets. Privy was removed here in Phase 7 of the
// migration; what it used to do and why none of it is needed now:
//
//   - A provider stack (<PrivyProvider>, <WagmiProvider> from @privy-io/wagmi)
//     that had to wrap the whole app. Circle needs no provider tree at all: it
//     is a wagmi connector, declared in lib/wagmi.ts alongside injected() and
//     walletConnect(). One config, all connectors, no branch.
//
//   - Lazy-mounting that stack only when needed, because @privy-io/* is ~700 kB
//     and a payer paying a link should never download it. The Circle SDK is
//     lazily imported inside lib/circle/browser.ts at the point of use, so the
//     payer bundle stays small without any mounting machinery.
//
//   - A hard rule that the two could never coexist: @privy-io/wagmi's
//     createConfig does `connectors: e.connectors?.filter((o) => "mock" === o.type)`
//     and disables EIP-6963 discovery, so wherever the Privy stack was mounted
//     the Circle connector was absent from wagmi no matter what lib/wagmi
//     declared. That constraint is what made this a switch rather than an
//     addition — and it is gone with Privy.
//
// CircleStack is still dynamic, but only to keep the SDK import off the server
// render path; it is mounted unconditionally now.
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

  // Kept on the context because consumers call it, but it is now a no-op: there
  // is no stack to ask for. Left in place rather than deleted so the gate's
  // shape survives if a future provider needs mounting again — and so this
  // phase changes no call sites, which was the rule for the whole migration.
  const requestMount = useCallback(() => {}, []);

  return (
    <WalletGateContext.Provider value={{ mounted: true, requestMount, walletSettled: true }}>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          {/* Translates the app's sign-in and sign-out events into connect /
              disconnect on the Circle connector, and issues the Conduit session
              token once a session exists. */}
          <CircleStack />
          {/* Asks a newly signed-in person for a username, once. Mounted here
              because "first sign-in" is not a route -- they can arrive already
              signed in on any page. Renders null until it has something to ask,
              and its modal is loaded on demand, so the pages it does not apply
              to pay nothing for it. */}
          <UsernameGate />
          {/* Holds back anything that DISPLAYS an address until the Circle
              session has been adopted — otherwise an auto-connected extension's
              address shows first and then swaps. Children are not held back:
              they render on the server, which is the point of this being a
              static import. */}
          <CircleWalletGate>{children}</CircleWalletGate>
        </QueryClientProvider>
      </WagmiProvider>
    </WalletGateContext.Provider>
  );
}
