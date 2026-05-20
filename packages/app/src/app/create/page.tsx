"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { Nav, MobileNav } from "@/components/Shared/Nav";
import { CreateForm } from "@/components/CreateFlow/CreateForm";
import { LinkCard } from "@/components/CreateFlow/LinkOutput/LinkCard";
import { QRDisplay } from "@/components/CreateFlow/QROutput/QRDisplay";
import { useConduitStore } from "@/store/useConduitStore";
import { parseAmount } from "@/lib/format";
import { motion } from "framer-motion";
import type { Currency } from "@conduit/sdk";

type OutputTab = "link" | "qr";

export default function CreatePage() {
  const { address } = useAccount();
  const { createFlow, resetCreateFlow } = useConduitStore();
  const [activeTab, setActiveTab] = useState<OutputTab>("link");
  const [result, setResult] = useState<{
    declarationId: string;
    paymentUrl: string;
  } | null>(null);

  const handleSuccess = (declarationId: string, paymentUrl: string) => {
    setResult({ declarationId, paymentUrl });
  };

  const amount = createFlow.amount ? parseAmount(createFlow.amount) : 0n;
  const currency = createFlow.currency as Currency;

  return (
    <div className="min-h-screen bg-brand-black">
      <Nav />

      <main className="max-w-2xl mx-auto px-4 pt-24 pb-24">
        <div className="mb-8">
          <h1 className="text-3xl font-anton text-brand-white">
            Create Payment
          </h1>
          <p className="text-brand-muted text-sm mt-1">
            Generate a link for digital sharing and a QR for physical locations.
          </p>
        </div>

        {!result ? (
          <div className="bg-brand-surface border border-brand-border rounded-2xl p-6">
            <CreateForm onSuccess={handleSuccess} />
          </div>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-6"
          >
            {/* Tab switcher — only needed on mobile; desktop shows both columns */}
            <div className="md:hidden flex bg-brand-surface border border-brand-border rounded-xl p-1 gap-1">
              <button
                onClick={() => setActiveTab("link")}
                className={`flex-1 py-2.5 rounded-lg text-sm font-mono transition-all ${
                  activeTab === "link"
                    ? "bg-brand-black text-brand-white"
                    : "text-brand-muted hover:text-brand-white"
                }`}
              >
                Payment Link
              </button>
              <button
                onClick={() => setActiveTab("qr")}
                className={`flex-1 py-2.5 rounded-lg text-sm font-mono transition-all ${
                  activeTab === "qr"
                    ? "bg-brand-black text-brand-white"
                    : "text-brand-muted hover:text-brand-white"
                }`}
              >
                QR Code
              </button>
            </div>

            {/* Outputs side by side on desktop, tabs on mobile */}
            <div className="grid md:grid-cols-2 gap-6 md:items-stretch">
              <div className={`${activeTab === "link" ? "block" : "hidden md:block"} flex flex-col`}>
                <p className="text-xs font-mono text-brand-muted uppercase tracking-wider mb-3">
                  Payment Link — Digital sharing
                </p>
                <LinkCard
                  declarationId={result.declarationId}
                  paymentUrl={result.paymentUrl}
                  amount={amount}
                  currency={currency}
                  recipientAddress={address ?? "0x"}
                  label={createFlow.label || undefined}
                />
              </div>

              <div className={`${activeTab === "qr" ? "block" : "hidden md:block"} flex flex-col`}>
                <p className="text-xs font-mono text-brand-muted uppercase tracking-wider mb-3">
                  QR Code — Physical commerce
                </p>
                <QRDisplay
                  declarationId={result.declarationId}
                  paymentUrl={result.paymentUrl}
                  amount={amount}
                  currency={currency}
                  label={createFlow.label || undefined}
                />
              </div>
            </div>

            <div className="flex gap-3">
              <a
                href={result.paymentUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 py-3 text-center rounded-xl border border-brand-border
                           text-sm text-brand-muted hover:text-brand-white
                           hover:border-brand-white/20 transition-colors"
              >
                Preview payment page →
              </a>
              <button
                onClick={() => {
                  setResult(null);
                  resetCreateFlow();
                }}
                className="flex-1 py-3 rounded-xl bg-brand-green text-brand-black
                           text-sm font-mono hover:bg-brand-green/90 transition-colors"
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
