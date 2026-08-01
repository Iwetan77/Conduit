"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import type { PaymentReceipt } from "@conduit/sdk/lite";
import { Nav, MobileNav } from "@/components/Shared/Nav";
import { HistoryTable } from "@/components/Shared/HistoryTable";
import { WalletConnect } from "@/components/Shared/WalletConnect";

export default function HistoryPage() {
  const { address, isConnected } = useAccount();
  const [history, setHistory] = useState<PaymentReceipt[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const load = async () => {
    if (!isConnected || !address) return;
    setIsLoading(true);
    setError("");
    try {
      const { ReceiptClient } = await import("@conduit/sdk");
      const { arcReadProvider } = await import("@/lib/arc-provider");

      const receiptClient = new ReceiptClient(arcReadProvider());
      const receipts = await receiptClient.getHistory(address as `0x${string}`, { limit: 50 });
      setHistory(receipts);
    } catch (err) {
      console.error("Failed to load history:", err);
      // "Failed to fetch" = Arc's public RPC rate-limiting the browser —
      // say that, not a bare fetch error.
      setError("Arc's public RPC is rate-limiting right now. Wait a few seconds and retry.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!mounted || !isConnected || !address) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, isConnected, address]);

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="max-w-2xl mx-auto px-4 pt-24 pb-24">
        <div className="mb-8">
          <h1 className="text-3xl font-anton text-brand-white">History</h1>
          <p className="text-brand-muted text-sm mt-1">All settled payments from this wallet</p>
        </div>

        {!mounted || !isConnected ? (
          <div className="text-center py-16 space-y-4">
            <p className="text-brand-muted">Connect your wallet to see your history.</p>
            <WalletConnect />
          </div>
        ) : (
          <>
            {error && (
              <div className="mb-4 p-3 bg-danger/10 border border-danger/30 flex items-center justify-between gap-3">
                <p className="text-danger text-sm font-mono">{error}</p>
                <button
                  onClick={load}
                  disabled={isLoading}
                  className="shrink-0 px-3 py-1.5 text-scale-2 font-mono border border-danger/40
                             text-danger hover:bg-danger/10 transition-colors disabled:opacity-50"
                >
                  {isLoading ? "Retrying…" : "Retry"}
                </button>
              </div>
            )}
            <HistoryTable
              receipts={history}
              walletAddress={address}
              isLoading={isLoading}
            />
          </>
        )}
      </main>
      <MobileNav />
    </div>
  );
}
