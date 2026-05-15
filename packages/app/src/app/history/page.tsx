"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import type { PaymentReceipt } from "@conduit/sdk";
import { Nav, MobileNav } from "@/components/Shared/Nav";
import { HistoryTable } from "@/components/Shared/HistoryTable";
import { WalletConnect } from "@/components/Shared/WalletConnect";

export default function HistoryPage() {
  const { address, isConnected } = useAccount();
  const [history, setHistory] = useState<PaymentReceipt[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!isConnected || !address) return;

    const load = async () => {
      setIsLoading(true);
      try {
        const { ConduitClient } = await import("@conduit/sdk");
        const mockSigner = {
          getAddress: async () => address,
          sendTransaction: async () => ({ hash: "0x", wait: async () => ({ status: 1, blockNumber: 0 }) }),
        };
        const client = new ConduitClient({ signer: mockSigner });
        const receipts = await client.getHistory(address as `0x${string}`, { limit: 50 });
        setHistory(receipts);
      } catch (err) {
        console.error("Failed to load history:", err);
      } finally {
        setIsLoading(false);
      }
    };

    load();
  }, [isConnected, address]);

  return (
    <div className="min-h-screen bg-brand-black">
      <Nav />
      <main className="max-w-2xl mx-auto px-4 pt-24 pb-24">
        <div className="mb-8">
          <h1 className="text-3xl font-display font-black text-brand-white">History</h1>
          <p className="text-brand-muted text-sm mt-1">All settled payments from this wallet</p>
        </div>

        {!isConnected ? (
          <div className="text-center py-16 space-y-4">
            <p className="text-brand-muted">Connect your wallet to see your history.</p>
            <WalletConnect />
          </div>
        ) : (
          <HistoryTable
            receipts={history}
            walletAddress={address}
            isLoading={isLoading}
          />
        )}
      </main>
      <MobileNav />
    </div>
  );
}
