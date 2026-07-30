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
  const [error, setError] = useState<string>("");
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!mounted || !isConnected || !address) return;

    const load = async () => {
      setIsLoading(true);
      setError("");
      try {
        const { ReceiptClient, ARC_TESTNET } = await import("@conduit/sdk");
        const { ethers } = await import("ethers");

        const provider = new ethers.JsonRpcProvider(ARC_TESTNET.rpc, {
          chainId: ARC_TESTNET.chainId,
          name: "arc-testnet",
        });
        const receiptClient = new ReceiptClient(provider);
        const receipts = await receiptClient.getHistory(address as `0x${string}`, { limit: 50 });
        setHistory(receipts);
      } catch (err) {
        console.error("Failed to load history:", err);
        setError(err instanceof Error ? err.message : "Failed to load history");
      } finally {
        setIsLoading(false);
      }
    };

    load();
  }, [mounted, isConnected, address]);

  return (
    <div className="min-h-screen bg-brand-black">
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
              <div className="mb-4 p-3 bg-danger/10 border border-danger/30">
                <p className="text-danger text-sm font-mono">{error}</p>
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
