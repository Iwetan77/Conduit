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
  // chainId, not chain.
  //
  // wagmi only resolves `chain` to an object when the connected network is one
  // of the configured chains, and the only configured chain is Arc. So on
  // Ethereum -- or any network not in the config -- `chain` is undefined, the
  // "not connected" branch below returned early, and this guard passed the
  // wallet straight through to a send it could not complete. It caught only
  // the chains already known to the config, which are the ones least likely to
  // be a problem.
  //
  // `chainId` is the raw number the wallet reports, whatever it is, and wagmi
  // keeps it current by listening for the wallet's own chainChanged event, so
  // switching networks re-renders this without a reload.
  const { chain, chainId, isConnected } = useAccount();
  const { switchChain } = useSwitchChain();

  // Pay page is public-facing — payers may be on any chain, and paying from
  // one is a feature rather than a mistake (see CrossChainBridge), so this
  // must not gate it. A payer also needs to read the declaration before being
  // asked to connect anything.
  //
  // This used to say enforcement happened inside PayConfirm instead. It does
  // not -- PayConfirm has no chain check of any kind. Left accurate rather
  // than reassuring: the same-currency Arc settle path on this page still
  // needs its own guard at send time, which is a separate piece of work to
  // the one that fixed this component.
  if (pathname.startsWith("/pay/")) return <>{children}</>;

  // /send is the same surface with a different entry point, and it was being
  // walled for the exact reason it exists.
  //
  // The page offers "Pay with USDC from another chain", backed by Circle
  // Gateway across twelve source chains (see lib/unified-balance.ts). Ethereum
  // is one of them. So a payer arriving on Ethereum -- holding the balance the
  // feature is built to spend -- was told they were on the wrong network and
  // asked to switch away from it. The guard was refusing the supported case.
  //
  // A chain is an INPUT to routing here, not a precondition: Arc settles
  // directly, the Gateway chains settle by depositing where the payer already
  // is, and only a chain in neither set is actually a problem. A page cannot
  // know which route the payer will pick, so it is the wrong place to decide.
  // SendConfirm now switches the chain itself at send time, which is the point
  // where the requirement is actually known.
  if (pathname.startsWith("/send")) return <>{children}</>;

  // Dashboard work — creating payment links, viewing settlements/
  // reconciliation, editing settings — is pure Conduit API traffic and never
  // signs an Arc transaction, so it must NOT be network-gated: a merchant
  // signed in with Google/email (or on any wallet network) was hitting the
  // "Wrong Network" wall and could not create links at all. Only the Send
  // flow actually submits an Arc tx; it guards its own chain at send time.
  // The whole dashboard passes now, /dashboard/send included. That route
  // renders the same SendConfirm, which switches the chain at send time, so
  // the wall bought nothing except hiding the page from a merchant whose
  // wallet happened to be pointed elsewhere -- including a Google sign in,
  // whose Circle wallet switches silently anyway.
  if (pathname.startsWith("/dashboard")) return <>{children}</>;

  // Not connected — let the page handle its own connect state
  if (!isConnected || !chainId) return <>{children}</>;

  // Correct chain — render normally
  if (chainId === arcTestnet.id) return <>{children}</>;

  // `chain?.name` is only there for configured chains; for everything else fall
  // back to the id, so the message says which network rather than "undefined".
  const chainName =
    SUPPORTED_EXTERNAL_CHAINS[chainId] ?? chain?.name ?? `chain ${chainId}`;
  const isCCTPSupported = chainId in SUPPORTED_EXTERNAL_CHAINS;

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
