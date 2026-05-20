"use client";

// /pay/[declarationId] — The most public-facing page.
// Someone who has never heard of Conduit lands here after clicking a link or scanning a QR.
// Rules: no crypto jargon, mobile-first, works without wallet connected, 3 taps to pay.

import { useEffect, useState } from "react";
import type { PaymentDeclaration, Currency } from "@conduit/sdk";
import { DeclarationDisplay } from "@/components/PayFlow/DeclarationDisplay";
import { PayConfirm } from "@/components/PayFlow/PayConfirm";
import { TokenSelector } from "@/components/Shared/TokenBadge";
import { Logo, Wordmark } from "@/components/Shared/Logo";
import { motion } from "framer-motion";

interface PageParams {
  params: { declarationId: string };
}

export default function PayPage({ params }: PageParams) {
  const { declarationId } = params;
  const [declaration, setDeclaration] = useState<PaymentDeclaration | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [payerCurrency, setPayerCurrency] = useState<Currency>("USDC");

  useEffect(() => {
    const load = async () => {
      try {
        const { ConduitClient } = await import("@conduit/sdk");
        const { ethers } = await import("ethers");

        const provider = new ethers.JsonRpcProvider("https://rpc.testnet.arc.network", {
          chainId: 5042002,
          name: "arc-testnet",
        });

        const mockSigner = {
          getAddress: async () => "0x0000000000000000000000000000000000000000",
          sendTransaction: async () => ({ hash: "0x", wait: async () => ({ status: 1, blockNumber: 0 }) }),
        };

        const client = new ConduitClient({ signer: mockSigner });
        const decl = await client.resolveDeclaration(declarationId as `0x${string}`);

        if (!decl.active) {
          setError("This payment link is no longer active.");
          return;
        }

        setDeclaration(decl);
      } catch {
        setError("Payment link not found or invalid.");
      } finally {
        setIsLoading(false);
      }
    };

    load();
  }, [declarationId]);

  return (
    <div className="min-h-screen bg-brand-black flex flex-col">
      {/* Minimal header */}
      <header className="px-6 py-4 border-b border-brand-border flex justify-center">
        <Logo size="sm" />
      </header>

      <main className="flex-1 max-w-sm mx-auto w-full px-4 py-8 space-y-8">
        {isLoading && (
          <div className="space-y-6 animate-pulse">
            <div className="h-8 bg-brand-surface rounded-xl" />
            <div className="h-32 bg-brand-surface rounded-2xl" />
            <div className="h-14 bg-brand-surface rounded-2xl" />
          </div>
        )}

        {error && (
          <div className="text-center py-16 space-y-3">
            <p className="text-4xl">⚠</p>
            <p className="text-brand-white font-medium">{error}</p>
            <a href="/" className="text-brand-green text-sm hover:underline">
              Go to Conduit →
            </a>
          </div>
        )}

        {declaration && !isLoading && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-8"
          >
            {/* Who is requesting */}
            <DeclarationDisplay declaration={declaration} />

            {/* Payer currency selector */}
            <div className="bg-brand-surface border border-brand-border rounded-xl p-4">
              <p className="text-sm text-brand-white mb-3 font-medium">
                What do you want to pay with?
              </p>
              <TokenSelector
                value={payerCurrency}
                onChange={setPayerCurrency}
              />
            </div>

            {/* Pay button and wallet connect */}
            <PayConfirm
              declaration={declaration}
              payerCurrency={payerCurrency}
            />
          </motion.div>
        )}
      </main>

      {/* Footer */}
      <footer className="px-6 py-4 border-t border-brand-border flex justify-center">
        <div className="flex items-center gap-2 text-brand-muted text-xs font-mono">
          <span>Powered by</span>
          <Wordmark size="sm" />
          <span>·</span>
          <span>Arc Testnet</span>
        </div>
      </footer>
    </div>
  );
}
