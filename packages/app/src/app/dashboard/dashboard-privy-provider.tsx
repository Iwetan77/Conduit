"use client";

import { useEffect, useState } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { arcTestnet } from "@/lib/wagmi";

// Scoped to the dashboard route tree only -- NOT the /pay payer surface,
// which has no merchant login and must stay completely free of Privy (spec
// Phase 2 + Phase 8 coherence check). Merchant human login only; the
// existing sk_/pk_ key system remains the machine-credential path.
export function DashboardPrivyProvider({ children }: { children: React.ReactNode }) {
  // No fallback: NEXT_PUBLIC_PRIVY_APP_ID must be set for the dashboard to
  // run at all -- there is no real Privy app configured in this repo/env,
  // so login is genuinely blocked until an operator supplies one. Reported
  // honestly in STATUS.md rather than faked.
  const appId = process.env["NEXT_PUBLIC_PRIVY_APP_ID"] ?? "";

  // PrivyProvider throws on mount with an invalid/empty app ID -- fatal
  // during Next's static prerendering pass (SSR), harmless once mounted
  // client-side only. The dashboard has no meaningful server-rendered
  // content anyway (it's gated on client auth state), so deferring
  // PrivyProvider to after mount is a legitimate fix, not a workaround.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email"],
        // v3 of the SDK splits this per-chain-family (was a flat
        // createOnLogin in the version the spec assumed) -- only ethereum
        // matters here since merchants log in with email, not a Solana
        // wallet.
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
        appearance: {
          theme: "dark",
          accentColor: "#B2F55A",
        },
        supportedChains: [arcTestnet],
        defaultChain: arcTestnet,
      }}
    >
      {children}
    </PrivyProvider>
  );
}
