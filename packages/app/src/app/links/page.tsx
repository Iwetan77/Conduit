"use client";

import { ARC_RPC_URL } from "@/lib/wagmi";

import Link from "next/link";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import type { PaymentDeclaration } from "@conduit/sdk/lite";
import { Nav, MobileNav } from "@/components/Shared/Nav";
import { WalletConnect } from "@/components/Shared/WalletConnect";
import { LinkCard } from "@/components/CreateFlow/LinkOutput/LinkCard";
import { formatAmount, shortenAddress } from "@/lib/format";
import { TokenBadge } from "@/components/Shared/TokenBadge";
import { addressToCurrency } from "@conduit/sdk/lite";
import { useCopy } from "@/lib/use-copy";

export default function LinksPage() {
  const { address, isConnected, connector } = useAccount();
  const [declarations, setDeclarations] = useState<PaymentDeclaration[]>([]);
  const [paymentCounts, setPaymentCounts] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [deactivating, setDeactivating] = useState<string | null>(null);
  const [selectedDecl, setSelectedDecl] = useState<PaymentDeclaration | null>(null);
  const { copied, copy } = useCopy();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const loadDeclarations = async () => {
    if (!address) return;
    setIsLoading(true);
    try {
      const { ConduitClient, ReceiptClient } = await import("@conduit/sdk");
      const { arcReadProvider } = await import("@/lib/arc-provider");
      const provider = arcReadProvider();
      const mockSigner = {
        getAddress: async () => address,
        sendTransaction: async () => ({ hash: "0x", wait: async () => ({ status: 1, blockNumber: 0 }) }),
      };

      const receiptClient = new ReceiptClient(provider);
      const conduitClient = new ConduitClient({ signer: mockSigner, rpcUrl: ARC_RPC_URL });

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
      const { getWalletProvider } = await import("@/lib/wallet-provider");
      const browserProvider = new ethers.BrowserProvider(await getWalletProvider(connector));
      const client = ConduitClient.fromBrowserProvider(browserProvider, "", undefined, ARC_RPC_URL);
      await client.deactivateLink(declarationId as `0x${string}`);
      await loadDeclarations();
    } catch (err) {
      console.error("Failed to deactivate:", err);
    } finally {
      setDeactivating(null);
    }
  };

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="max-w-2xl mx-auto px-4 pt-24 pb-24">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-anton text-ink">My Links</h1>
            <p className="text-ink-dim text-sm mt-1">Manage your payment declarations</p>
          </div>
          <Link
            href="/create"
            className="px-4 py-2 bg-signal text-signal-ink
                       text-sm font-mono hover:bg-signal/90 transition-colors"
          >
            + New Link
          </Link>
        </div>

        {!mounted || !isConnected ? (
          <div className="text-center py-16 space-y-4">
            <p className="text-ink-dim">Connect your wallet to see your links.</p>
            <WalletConnect />
          </div>
        ) : isLoading ? (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-20 bg-surface animate-pulse border border-border" />
            ))}
          </div>
        ) : declarations.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-ink-dim mb-4">No payment links yet.</p>
            <Link href="/create" className="px-6 py-3 bg-signal text-signal-ink font-mono">
              Create your first link
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {declarations.map((decl) => {
              const currency = addressToCurrency(decl.recipientToken);
              const count = paymentCounts[decl.declarationId] ?? 0;

              return (
                <div
                  key={decl.declarationId}
                  className={`p-5 border transition-all ${
                    decl.active
                      ? "bg-surface border-border"
                      : "bg-surface/50 border-border/50 opacity-60"
                  }`}
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className={`w-1.5 h-1.5 ${decl.active ? "bg-signal" : "bg-ink-dim"}`} />
                        <span className="text-sm font-anton text-ink">
                          {decl.amount > 0n ? formatAmount(decl.amount, currency) : `Open · ${currency}`}
                        </span>
                        <TokenBadge currency={currency} size="sm" />
                        {count > 0 && (
                          <span className="px-2 py-0.5 bg-signal/10 border border-signal/20 text-signal text-xs font-mono">
                            {count} payment{count !== 1 ? "s" : ""}
                          </span>
                        )}
                      </div>
                      <p className="text-xs font-mono text-ink-dim truncate">
                        {typeof window !== "undefined"
                          ? `${window.location.origin}/pay/${decl.declarationId}`
                          : decl.paymentUrl}
                      </p>
                    </div>

                    <div className="flex items-center gap-2 shrink-0 flex-wrap">
                      <button
                        onClick={() => {
                          const url = typeof window !== "undefined"
                            ? `${window.location.origin}/pay/${decl.declarationId}`
                            : decl.paymentUrl;
                          copy(url, decl.declarationId);
                        }}
                        className={`px-3 py-1.5 text-xs border transition-colors ${
                          copied === decl.declarationId
                            ? "border-signal/40 text-signal"
                            : "border-border text-ink-dim hover:text-ink hover:border-ink-dim/20"
                        }`}
                      >
                        {copied === decl.declarationId ? "Copied!" : "Copy"}
                      </button>
                      <button
                        onClick={() => setSelectedDecl(decl)}
                        className="px-3 py-1.5 text-xs border border-border
                                   text-ink-dim hover:text-ink hover:border-ink-dim/20 transition-colors"
                      >
                        View
                      </button>
                      {decl.active && (
                        <button
                          onClick={() => handleDeactivate(decl.declarationId)}
                          disabled={deactivating === decl.declarationId}
                          className="px-3 py-1.5 text-xs border border-danger/20
                                     text-danger/70 hover:text-danger hover:border-danger/40 transition-colors
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
          className="fixed inset-0 z-50 bg-bg/90 flex items-start justify-center p-4 overflow-y-auto"
          onClick={(e) => { if (e.target === e.currentTarget) setSelectedDecl(null); }}
        >
          <div className="w-full max-w-4xl my-8">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-anton text-ink">Payment Link</h2>
              <button
                onClick={() => setSelectedDecl(null)}
                className="text-ink-dim hover:text-ink text-3xl leading-none transition-colors"
              >
                ×
              </button>
            </div>

            {/* Links only on the payer surface — QR is a merchant
                point-of-sale feature and lives on the dashboard. */}
            <div className="max-w-xl">
              <div className="flex flex-col">
                <p className="text-xs font-mono text-ink-dim uppercase tracking-wider mb-3">
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
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
