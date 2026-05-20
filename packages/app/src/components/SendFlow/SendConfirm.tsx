"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import type { Currency, PaymentReceipt } from "@conduit/sdk";
import { parseAmount, formatAmount, shortenAddress } from "@/lib/format";
import { RoutePreview } from "./RoutePreview";
import { ReceiptCard } from "@/components/Shared/ReceiptCard";
import { StepProgress } from "@/components/Shared/StepProgress";
import { motion, AnimatePresence } from "framer-motion";

interface SendConfirmProps {
  recipient: string;
  amount: string;
  recipientCurrency: Currency;
  payerCurrency: Currency;
  onBack: () => void;
  onReset: () => void;
}

export function SendConfirm({
  recipient,
  amount,
  recipientCurrency,
  payerCurrency,
  onBack,
  onReset,
}: SendConfirmProps) {
  const { address } = useAccount();
  const [step, setStep] = useState<"confirm" | "pending" | "success" | "error">("confirm");
  const [receipt, setReceipt] = useState<PaymentReceipt | null>(null);
  const [error, setError] = useState<string>("");

  const parsedAmount = parseAmount(amount);

  const handleSend = async () => {
    if (!address) return;
    setStep("pending");

    try {
      // Dynamic import to avoid SSR issues
      const { ConduitClient } = await import("@conduit/sdk");
      const { ethers } = await import("ethers");

      // Use browser provider
      const browserProvider = new ethers.BrowserProvider(
        (window as unknown as { ethereum: unknown }).ethereum
      );
      const client = ConduitClient.fromBrowserProvider(browserProvider, "");

      const result = await client.pay({
        recipient: recipient as `0x${string}`,
        amount: parsedAmount,
        currency: recipientCurrency,
        payerToken: payerCurrency,
      });

      setReceipt(result);
      setStep("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transaction failed");
      setStep("error");
    }
  };

  return (
    <div className="space-y-6">
      <StepProgress
        steps={["Enter details", "Confirm", "Done"]}
        current={step === "confirm" ? 1 : step === "pending" ? 1 : 2}
      />

      <AnimatePresence mode="wait">
        {step === "confirm" && (
          <motion.div
            key="confirm"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            className="space-y-4"
          >
            <div className="bg-brand-surface border border-brand-border rounded-xl p-5 space-y-4">
              <h3 className="text-sm font-mono text-brand-muted uppercase tracking-wider">
                Confirm Payment
              </h3>

              <div className="space-y-3">
                <Row label="To" value={shortenAddress(recipient)} mono />
                <Row
                  label="Amount"
                  value={formatAmount(parsedAmount, recipientCurrency)}
                />
              </div>
            </div>

            <RoutePreview
              payerCurrency={payerCurrency}
              recipientCurrency={recipientCurrency}
              recipientAmount={amount}
            />

            <div className="flex gap-3">
              <button
                onClick={onBack}
                className="flex-1 py-3 rounded-xl border border-brand-border
                           text-brand-muted hover:text-brand-white hover:border-brand-white/20
                           transition-colors font-mono"
              >
                Back
              </button>
              <button
                onClick={handleSend}
                className="flex-1 py-3 rounded-xl bg-brand-green text-brand-black
                           font-mono hover:bg-brand-green/90 transition-colors"
              >
                Send Payment
              </button>
            </div>
          </motion.div>
        )}

        {step === "pending" && (
          <motion.div
            key="pending"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-center py-16 space-y-4"
          >
            <div className="w-16 h-16 rounded-full border-2 border-brand-green border-t-transparent
                            animate-spin mx-auto" />
            <p className="text-brand-white font-mono">Settling on-chain...</p>
            <p className="text-brand-muted text-sm font-mono">
              Arc finalizes in under a second
            </p>
          </motion.div>
        )}

        {step === "success" && receipt && (
          <motion.div
            key="success"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-4"
          >
            <ReceiptCard receipt={receipt} />
            <button
              onClick={onReset}
              className="w-full py-3 rounded-xl border border-brand-border
                         text-brand-white hover:border-brand-green/30 transition-colors font-mono"
            >
              Send Another
            </button>
          </motion.div>
        )}

        {step === "error" && (
          <motion.div
            key="error"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="space-y-4"
          >
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-5">
              <p className="text-red-400 font-mono mb-2">Transaction Failed</p>
              <p className="text-red-400/70 text-sm font-mono">{error}</p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setStep("confirm")}
                className="flex-1 py-3 rounded-xl border border-brand-border
                           text-brand-white hover:border-brand-white/20 transition-colors"
              >
                Try Again
              </button>
              <button
                onClick={onReset}
                className="flex-1 py-3 rounded-xl bg-brand-surface border border-brand-border
                           text-brand-muted hover:text-brand-white transition-colors"
              >
                Start Over
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-brand-muted text-sm">{label}</span>
      <span className={`text-brand-white text-sm ${mono ? "font-mono" : "font-medium"}`}>
        {value}
      </span>
    </div>
  );
}
