"use client";

import { useState } from "react";
import type { PaymentDeclaration, PaymentReceipt, Currency } from "@conduit/sdk";
import { formatAmount } from "@/lib/format";
import { ReceiptCard } from "@/components/Shared/ReceiptCard";
import { QuotePreview } from "./QuotePreview";
import { motion, AnimatePresence } from "framer-motion";
import { WalletConnectCompact } from "@/components/Shared/WalletConnect";
import { useAccount } from "wagmi";

interface PayConfirmProps {
  declaration: PaymentDeclaration;
  payerCurrency: Currency;
  openAmount?: string; // for open-amount declarations
}

export function PayConfirm({ declaration, payerCurrency, openAmount }: PayConfirmProps) {
  const { address, isConnected } = useAccount();
  const [step, setStep] = useState<"confirm" | "pending" | "success" | "error">("confirm");
  const [receipt, setReceipt] = useState<PaymentReceipt | null>(null);
  const [error, setError] = useState<string>("");

  const amount = declaration.amount > 0n ? declaration.amount : undefined;

  const handlePay = async () => {
    if (!address || !isConnected) return;
    setStep("pending");
    setError("");

    try {
      const { ConduitClient } = await import("@conduit/sdk");
      const { ethers } = await import("ethers");

      const browserProvider = new ethers.BrowserProvider(
        (window as unknown as { ethereum: unknown }).ethereum
      );
      const kitKey = process.env.NEXT_PUBLIC_KIT_KEY ?? "";
      const client = ConduitClient.fromBrowserProvider(browserProvider, kitKey);

      const result = await client.fulfill(declaration, { payerToken: payerCurrency });

      setReceipt(result);
      setStep("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transaction failed");
      setStep("error");
    }
  };

  if (!isConnected) {
    return (
      <div className="space-y-4">
        <p className="text-center text-brand-muted text-sm">
          Connect your wallet to pay
        </p>
        <WalletConnectCompact />
      </div>
    );
  }

  return (
    <AnimatePresence mode="wait">
      {step === "confirm" && (
        <motion.div
          key="confirm"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          className="space-y-4"
        >
          {amount && (
            <QuotePreview
              payerCurrency={payerCurrency}
              recipientCurrency={declaration.currency}
              recipientAmount={(Number(amount) / 1e6).toFixed(2)}
            />
          )}

          <button
            onClick={handlePay}
            className="w-full py-4 rounded-2xl bg-brand-green text-brand-black
                       font-mono text-xl hover:bg-brand-green/90 transition-colors"
          >
            {amount
              ? `Pay ${formatAmount(amount, declaration.currency)}`
              : "Pay"}
          </button>

          <p className="text-xs text-center text-brand-muted">
            Settles in under a second on Arc · No hidden fees
          </p>
        </motion.div>
      )}

      {step === "pending" && (
        <motion.div
          key="pending"
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="text-center py-12 space-y-4"
        >
          <div
            className="w-14 h-14 rounded-full border-2 border-brand-green border-t-transparent
                          animate-spin mx-auto"
          />
          <p className="text-brand-white font-mono">Settling on Arc...</p>
          <p className="text-brand-muted text-sm font-mono">Sub-second finality</p>
        </motion.div>
      )}

      {step === "success" && receipt && (
        <motion.div
          key="success"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-4"
        >
          <ReceiptCard receipt={receipt} />
        </motion.div>
      )}

      {step === "error" && (
        <motion.div
          key="error"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="space-y-4"
        >
          <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30">
            <p className="text-red-400 font-mono text-sm mb-1">Payment failed</p>
            <p className="text-red-400/70 text-xs font-mono">{error}</p>
          </div>
          <button
            onClick={() => setStep("confirm")}
            className="w-full py-3 rounded-xl border border-brand-border
                       text-brand-white hover:border-brand-white/20 transition-colors"
          >
            Try Again
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
