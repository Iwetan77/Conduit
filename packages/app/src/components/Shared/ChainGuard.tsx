"use client";

import { usePathname } from "next/navigation";
import { useAccount, useSwitchChain } from "wagmi";
import { arcTestnet } from "@/lib/wagmi";

interface ChainGuardProps {
  children: React.ReactNode;
}

// CCTP-supported chains where we can give a helpful bridge message
const SUPPORTED_EXTERNAL_CHAINS: Record<number, string> = {
  1:     "Ethereum",
  42161: "Arbitrum",
  8453:  "Base",
  10:    "Optimism",
  137:   "Polygon",
};

export function ChainGuard({ children }: ChainGuardProps) {
  const pathname = usePathname();
  const { chain, isConnected } = useAccount();
  const { switchChain } = useSwitchChain();

  // Pay page is public-facing — payers may be on any chain.
  // They need to see the declaration before being asked to connect.
  // Chain enforcement is handled inside PayConfirm.tsx instead.
  if (pathname.startsWith("/pay/")) return <>{children}</>;

  // Dashboard work — creating payment links, viewing settlements/
  // reconciliation, editing settings — is pure Conduit API traffic and never
  // signs an Arc transaction, so it must NOT be network-gated: a merchant
  // signed in with Google/email (or on any wallet network) was hitting the
  // "Wrong Network" wall and could not create links at all. Only the Send
  // flow actually submits an Arc tx; it guards its own chain at send time.
  if (pathname.startsWith("/dashboard") && !pathname.startsWith("/dashboard/send")) {
    return <>{children}</>;
  }

  // Not connected — let the page handle its own connect state
  if (!isConnected || !chain) return <>{children}</>;

  // Correct chain — render normally
  if (chain.id === arcTestnet.id) return <>{children}</>;

  const chainName = SUPPORTED_EXTERNAL_CHAINS[chain.id] ?? chain.name;
  const isCCTPSupported = chain.id in SUPPORTED_EXTERNAL_CHAINS;

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="max-w-sm w-full bg-surface border border-border
                      p-8 space-y-6 text-center">
        {/* Network indicator */}
        <div className="flex items-center justify-center gap-2">
          <span className="w-2 h-2 bg-danger" />
          <span className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider">
            Wrong Network
          </span>
        </div>

        <div className="space-y-2">
          <p className="text-ink font-semibold text-scale-4">
            You&apos;re on {chainName}
          </p>
          <p className="text-ink-dim text-scale-2 leading-relaxed">
            Conduit runs on Arc Testnet (Chain ID 5042002).
            Switch your wallet to Arc to continue.
          </p>
        </div>

        {/* Switch network button */}
        <button
          onClick={() => switchChain({ chainId: arcTestnet.id })}
          className="w-full py-3 bg-signal text-signal-ink
                     font-mono hover:opacity-90 transition-opacity"
        >
          Switch to Arc Testnet
        </button>

        {/* Bridge hint for CCTP-supported chains */}
        {isCCTPSupported && (
          <div className="pt-2 border-t border-border space-y-2">
            <p className="text-scale-1 text-ink-dim">
              Need to move USDC from {chainName} to Arc?
            </p>
            <a
              href="https://www.circle.com/en/multichain-usdc"
              target="_blank"
              rel="noopener noreferrer"
              className="text-scale-1 text-signal hover:underline"
            >
              Bridge via Circle →
            </a>
          </div>
        )}

        {/* Faucet link */}
        <p className="text-scale-1 text-ink-dim">
          Need Arc testnet tokens?{" "}
          <a
            href="https://faucet.circle.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-signal hover:underline"
          >
            Get from faucet →
          </a>
        </p>
      </div>
    </div>
  );
}
