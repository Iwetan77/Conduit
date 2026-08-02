"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { Nav, MobileNav } from "@/components/Shared/Nav";
import { CreateForm } from "@/components/CreateFlow/CreateForm";
import { LinkCard } from "@/components/CreateFlow/LinkOutput/LinkCard";
import { parseAmount } from "@/lib/format";
import { motion } from "framer-motion";
import type { Currency } from "@conduit/sdk/lite";


export default function CreatePage() {
  const { address } = useAccount();
  const [result, setResult] = useState<{
    declarationId: string;
    paymentUrl: string;
    amount: string;
    currency: Currency;
    label: string;
  } | null>(null);

  const handleSuccess = (declarationId: string, paymentUrl: string, amount: string, currency: Currency, label: string) => {
    setResult({ declarationId, paymentUrl, amount, currency, label });
  };

  const currency = result?.currency ?? "USDC";
  const amount = result?.amount ? parseAmount(result.amount, currency) : 0n;

  return (
    <div className="min-h-screen">
      <Nav />

      <main className="max-w-2xl mx-auto px-4 pt-24 pb-24">
        <div className="mb-8">
          <h1 className="text-3xl font-anton text-ink">
            Create Payment
          </h1>
          <p className="text-ink-dim text-sm mt-1">
            Generate a link you can send to anyone.
          </p>
        </div>

        {!result ? (
          <div className="bg-surface border border-border p-6">
            <CreateForm onSuccess={handleSuccess} />
          </div>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-6"
          >
            {/* Payer surface creates links only. QR codes are a merchant
                feature (physical point of sale) and live on the dashboard. */}
            <div className="flex flex-col">
              <div className="flex flex-col">
                <p className="text-xs font-mono text-ink-dim uppercase tracking-wider mb-3">
                  Payment Link — Digital sharing
                </p>
                <LinkCard
                  declarationId={result.declarationId}
                  paymentUrl={result.paymentUrl}
                  amount={amount}
                  currency={currency}
                  recipientAddress={address ?? "0x"}
                  label={result?.label || undefined}
                />
              </div>

            </div>

            <div className="flex gap-3">
              <a
                href={result.paymentUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 py-3 text-center border border-border
                           text-sm text-ink-dim hover:text-ink
                           hover:border-ink-dim/20 transition-colors"
              >
                Preview payment page →
              </a>
              <button
                onClick={() => {
                  setResult(null);
                }}
                className="flex-1 py-3 bg-signal text-signal-ink
                           text-sm font-mono hover:bg-signal/90 transition-colors"
              >
                Create Another
              </button>
            </div>
          </motion.div>
        )}
      </main>

      <MobileNav />
    </div>
  );
}
