"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import type { PaymentDeclaration } from "@conduit/sdk";
import { Nav, MobileNav } from "@/components/Shared/Nav";
import { WalletConnect } from "@/components/Shared/WalletConnect";
import { formatAmount, shortenAddress } from "@/lib/format";
import { TokenBadge } from "@/components/Shared/TokenBadge";
import type { Currency } from "@conduit/sdk";

function addressToCurrency(address: string): Currency {
  return address.toLowerCase() === "0x3600000000000000000000000000000000000000"
    ? "USDC"
    : "EURC";
}

export default function LinksPage() {
  const { address, isConnected } = useAccount();
  const [declarations, setDeclarations] = useState<PaymentDeclaration[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [deactivating, setDeactivating] = useState<string | null>(null);

  const loadDeclarations = async () => {
    if (!address) return;
    setIsLoading(true);
    try {
      const { ConduitClient } = await import("@conduit/sdk");
      const { ethers } = await import("ethers");
      const provider = new ethers.JsonRpcProvider("https://rpc.testnet.arc.network");
      const mockSigner = {
        getAddress: async () => address,
        sendTransaction: async () => ({ hash: "0x", wait: async () => ({ status: 1, blockNumber: 0 }) }),
      };
      const client = new ConduitClient({ signer: mockSigner });
      const decls = await client.getDeclarations(address as `0x${string}`);
      setDeclarations(decls);
    } catch (err) {
      console.error("Failed to load declarations:", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isConnected && address) {
      loadDeclarations();
    }
  }, [isConnected, address]);

  const handleDeactivate = async (declarationId: string) => {
    if (!window.confirm("Deactivate this link? It cannot be reactivated.")) return;
    setDeactivating(declarationId);
    try {
      const { ConduitClient } = await import("@conduit/sdk");
      const { ethers } = await import("ethers");
      const browserProvider = new ethers.BrowserProvider(
        (window as unknown as { ethereum: unknown }).ethereum
      );
      const client = ConduitClient.fromBrowserProvider(browserProvider);
      await client.deactivateLink(declarationId as `0x${string}`);
      await loadDeclarations();
    } catch (err) {
      console.error("Failed to deactivate:", err);
    } finally {
      setDeactivating(null);
    }
  };

  return (
    <div className="min-h-screen bg-brand-black">
      <Nav />
      <main className="max-w-2xl mx-auto px-4 pt-24 pb-24">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-anton text-brand-white">My Links</h1>
            <p className="text-brand-muted text-sm mt-1">Manage your payment declarations</p>
          </div>
          <a
            href="/create"
            className="px-4 py-2 rounded-xl bg-brand-green text-brand-black
                       text-sm font-anton tracking-wide hover:bg-brand-green/90 transition-colors"
          >
            + New Link
          </a>
        </div>

        {!isConnected ? (
          <div className="text-center py-16 space-y-4">
            <p className="text-brand-muted">Connect your wallet to see your links.</p>
            <WalletConnect />
          </div>
        ) : isLoading ? (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-20 bg-brand-surface rounded-xl animate-pulse border border-brand-border" />
            ))}
          </div>
        ) : declarations.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-brand-muted mb-4">No payment links yet.</p>
            <a
              href="/create"
              className="px-6 py-3 rounded-xl bg-brand-green text-brand-black font-anton tracking-wide"
            >
              Create your first link
            </a>
          </div>
        ) : (
          <div className="space-y-3">
            {declarations.map((decl) => {
              const currency = addressToCurrency(decl.recipientToken);
              const appUrl = process.env["NEXT_PUBLIC_APP_URL"] ?? "https://app.conduit.xyz";
              const paymentUrl = `${appUrl}/pay/${decl.declarationId}`;

              return (
                <div
                  key={decl.declarationId}
                  className={`p-5 rounded-xl border transition-all ${
                    decl.active
                      ? "bg-brand-surface border-brand-border"
                      : "bg-brand-surface/50 border-brand-border/50 opacity-60"
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-2">
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${decl.active ? "bg-brand-green" : "bg-brand-muted"}`}
                        />
                        <span className="text-sm font-anton text-brand-white">
                          {decl.amount > 0n ? formatAmount(decl.amount, currency) : `Open · ${currency}`}
                        </span>
                        <TokenBadge currency={currency} size="sm" />
                      </div>
                      <p className="text-xs font-mono text-brand-muted truncate">
                        {paymentUrl}
                      </p>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => navigator.clipboard.writeText(paymentUrl)}
                        className="px-3 py-1.5 rounded-lg text-xs border border-brand-border
                                   text-brand-muted hover:text-brand-white hover:border-brand-white/20 transition-colors"
                      >
                        Copy
                      </button>
                      <a
                        href={paymentUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-3 py-1.5 rounded-lg text-xs border border-brand-border
                                   text-brand-muted hover:text-brand-white hover:border-brand-white/20 transition-colors"
                      >
                        View
                      </a>
                      {decl.active && (
                        <button
                          onClick={() => handleDeactivate(decl.declarationId)}
                          disabled={deactivating === decl.declarationId}
                          className="px-3 py-1.5 rounded-lg text-xs border border-red-500/20
                                     text-red-400/70 hover:text-red-400 hover:border-red-500/40 transition-colors
                                     disabled:opacity-50"
                        >
                          {deactivating === decl.declarationId ? "..." : "Deactivate"}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
      <MobileNav />
    </div>
  );
}
