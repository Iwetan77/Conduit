"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import type { PaymentDeclaration } from "@conduit/sdk";
import { Nav, MobileNav } from "@/components/Shared/Nav";
import { WalletConnect } from "@/components/Shared/WalletConnect";
import { LinkCard } from "@/components/CreateFlow/LinkOutput/LinkCard";
import { QRDisplay } from "@/components/CreateFlow/QROutput/QRDisplay";
import { formatAmount, shortenAddress } from "@/lib/format";
import { TokenBadge } from "@/components/Shared/TokenBadge";
import { addressToCurrency } from "@conduit/sdk";

export default function LinksPage() {
  const { address, isConnected } = useAccount();
  const [declarations, setDeclarations] = useState<PaymentDeclaration[]>([]);
  const [paymentCounts, setPaymentCounts] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [deactivating, setDeactivating] = useState<string | null>(null);
  const [selectedDecl, setSelectedDecl] = useState<PaymentDeclaration | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const loadDeclarations = async () => {
    if (!address) return;
    setIsLoading(true);
    try {
      const [{ ConduitClient, ReceiptClient, ARC_TESTNET }, { ethers }] = await Promise.all([
        import("@conduit/sdk"),
        import("ethers"),
      ]);

      const provider = new ethers.JsonRpcProvider(ARC_TESTNET.rpc, {
        chainId: ARC_TESTNET.chainId,
        name: "arc-testnet",
      });
      const mockSigner = {
        getAddress: async () => address,
        sendTransaction: async () => ({ hash: "0x", wait: async () => ({ status: 1, blockNumber: 0 }) }),
      };

      const receiptClient = new ReceiptClient(provider);
      const conduitClient = new ConduitClient({ signer: mockSigner });

      const [decls, receipts] = await Promise.all([
        conduitClient.getDeclarations(address as `0x${string}`),
        receiptClient.getHistory(address as `0x${string}`, { limit: 200 }),
      ]);

      setDeclarations(decls);

      // Count payments received per declaration
      const counts: Record<string, number> = {};
      for (const r of receipts) {
        if (r.recipient.toLowerCase() === address.toLowerCase()) {
          counts[r.declarationId] = (counts[r.declarationId] ?? 0) + 1;
        }
      }
      setPaymentCounts(counts);
    } catch (err) {
      console.error("Failed to load declarations:", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (mounted && isConnected && address) {
      loadDeclarations();
    }
  }, [mounted, isConnected, address]);

  const handleDeactivate = async (declarationId: string) => {
    if (!window.confirm("Deactivate this link? It cannot be reactivated.")) return;
    setDeactivating(declarationId);
    try {
      const { ConduitClient } = await import("@conduit/sdk");
      const { ethers } = await import("ethers");
      const browserProvider = new ethers.BrowserProvider(
        (window as unknown as { ethereum: unknown }).ethereum
      );
      const client = ConduitClient.fromBrowserProvider(browserProvider, "");
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
                       text-sm font-mono hover:bg-brand-green/90 transition-colors"
          >
            + New Link
          </a>
        </div>

        {!mounted || !isConnected ? (
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
            <a href="/create" className="px-6 py-3 rounded-xl bg-brand-green text-brand-black font-mono">
              Create your first link
            </a>
          </div>
        ) : (
          <div className="space-y-3">
            {declarations.map((decl) => {
              const currency = addressToCurrency(decl.recipientToken);
              const count = paymentCounts[decl.declarationId] ?? 0;

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
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full ${decl.active ? "bg-brand-green" : "bg-brand-muted"}`} />
                        <span className="text-sm font-anton text-brand-white">
                          {decl.amount > 0n ? formatAmount(decl.amount, currency) : `Open · ${currency}`}
                        </span>
                        <TokenBadge currency={currency} size="sm" />
                        {count > 0 && (
                          <span className="px-2 py-0.5 rounded-full bg-brand-green/10 border border-brand-green/20 text-brand-green text-xs font-mono">
                            {count} payment{count !== 1 ? "s" : ""}
                          </span>
                        )}
                      </div>
                      <p className="text-xs font-mono text-brand-muted truncate">
                        {typeof window !== "undefined"
                          ? `${window.location.origin}/pay/${decl.declarationId}`
                          : decl.paymentUrl}
                      </p>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => {
                          const url = typeof window !== "undefined"
                            ? `${window.location.origin}/pay/${decl.declarationId}`
                            : decl.paymentUrl;
                          navigator.clipboard.writeText(url);
                        }}
                        className="px-3 py-1.5 rounded-lg text-xs border border-brand-border
                                   text-brand-muted hover:text-brand-white hover:border-brand-white/20 transition-colors"
                      >
                        Copy
                      </button>
                      <button
                        onClick={() => setSelectedDecl(decl)}
                        className="px-3 py-1.5 rounded-lg text-xs border border-brand-border
                                   text-brand-muted hover:text-brand-white hover:border-brand-white/20 transition-colors"
                      >
                        View
                      </button>
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

      {/* Link card modal */}
      {selectedDecl && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto"
          onClick={(e) => { if (e.target === e.currentTarget) setSelectedDecl(null); }}
        >
          <div className="w-full max-w-4xl my-8">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-anton text-brand-white">Payment Link</h2>
              <button
                onClick={() => setSelectedDecl(null)}
                className="text-brand-muted hover:text-brand-white text-3xl leading-none transition-colors"
              >
                ×
              </button>
            </div>

            <div className="grid md:grid-cols-2 gap-6 md:items-stretch">
              <div className="flex flex-col">
                <p className="text-xs font-mono text-brand-muted uppercase tracking-wider mb-3">
                  Payment Link — Digital sharing
                </p>
                <LinkCard
                  declarationId={selectedDecl.declarationId}
                  paymentUrl={typeof window !== "undefined"
                    ? `${window.location.origin}/pay/${selectedDecl.declarationId}`
                    : selectedDecl.paymentUrl}
                  amount={selectedDecl.amount}
                  currency={selectedDecl.currency}
                  recipientAddress={selectedDecl.recipient}
                />
              </div>
              <div className="flex flex-col">
                <p className="text-xs font-mono text-brand-muted uppercase tracking-wider mb-3">
                  QR Code — Physical commerce
                </p>
                <QRDisplay
                  declarationId={selectedDecl.declarationId}
                  paymentUrl={typeof window !== "undefined"
                    ? `${window.location.origin}/pay/${selectedDecl.declarationId}`
                    : selectedDecl.paymentUrl}
                  amount={selectedDecl.amount}
                  currency={selectedDecl.currency}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
