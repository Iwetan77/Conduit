"use client";

import { useState, useEffect } from "react";
import { useAccount } from "wagmi";
import { isAddress } from "viem";
import { ConduitMark } from "@/components/Shared/Logo";
import { Nav, MobileNav } from "@/components/Shared/Nav";
import { AddressInput } from "@/components/SendFlow/AddressInput";
import { AmountInput } from "@/components/SendFlow/AmountInput";
import { RoutePreview } from "@/components/SendFlow/RoutePreview";
import { SendConfirm } from "@/components/SendFlow/SendConfirm";
import { PayerCurrencyPicker } from "@/components/SendFlow/PayerCurrencyPicker";
import { WalletConnect } from "@/components/Shared/WalletConnect";
import type { Currency } from "@conduit/sdk";
import { motion, AnimatePresence } from "framer-motion";

type Step = "input" | "confirm";

export default function HomePage() {
  const [mounted, setMounted] = useState(false);
  const { isConnected } = useAccount();
  const [step, setStep] = useState<Step>("input");

  useEffect(() => { setMounted(true); }, []);

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [recipientCurrency, setRecipientCurrency] = useState<Currency>("USDC");
  const [payerCurrency, setPayerCurrency] = useState<Currency>("USDC");

  const canProceed = isAddress(recipient) && parseFloat(amount) > 0 && isConnected;

  return (
    <div className="min-h-screen bg-bg">
      <Nav />

      <main className="max-w-lg mx-auto px-4 pt-24 pb-24">
        {/* Hero */}
        <div className="text-center mb-10">
          <div className="flex justify-center mb-4">
            <ConduitMark height={140} />
          </div>
          <p className="text-ink-dim mt-3 text-sm font-mono">
            Accept any stablecoin, settle in yours
          </p>
          <div className="flex items-center justify-center gap-2 mt-2">
            <span className="w-1.5 h-1.5 bg-signal animate-pulse" />
            <span className="text-xs font-mono text-signal">
              Chain ID 5042002 · Arc Testnet
            </span>
          </div>
        </div>

        <AnimatePresence mode="wait">
          {step === "input" && (
            <motion.div
              key="input"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              className="space-y-6"
            >
              {/* Card */}
              <div className="bg-surface border border-border p-6 space-y-6">
                <h2 className="text-xs font-mono text-ink-dim uppercase tracking-widest">
                  Direct Send
                </h2>

                <AddressInput
                  value={recipient}
                  onChange={setRecipient}
                />

                <AmountInput
                  value={amount}
                  onChange={setAmount}
                  currency={recipientCurrency}
                  onCurrencyChange={(c) => setRecipientCurrency(c)}
                  label="They receive"
                />

                {/* Balance-aware payer currency (Phase 5.1): only what this
                    wallet actually holds, never a static list of every
                    currency that exists. */}
                <PayerCurrencyPicker value={payerCurrency} onChange={setPayerCurrency} />

                {amount && recipient && (
                  <RoutePreview
                    payerCurrency={payerCurrency}
                    recipientCurrency={recipientCurrency}
                    recipientAmount={amount}
                  />
                )}
              </div>

              {!mounted || !isConnected ? (
                <div className="text-center space-y-3">
                  <p className="text-ink-dim text-sm">Connect your wallet to send</p>
                  <WalletConnect />
                </div>
              ) : (
                <button
                  onClick={() => setStep("confirm")}
                  disabled={!canProceed}
                  className="w-full py-4 bg-signal text-signal-ink
                             font-mono text-xl hover:bg-signal/90 transition-colors
                             disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Review Payment →
                </button>
              )}

              {/* Links CTA */}
              <div className="text-center">
                <p className="text-ink-dim text-sm">
                  Need a payment link or QR?{" "}
                  <a href="/create" className="text-signal hover:underline">
                    Create one →
                  </a>
                </p>
              </div>
            </motion.div>
          )}

          {step === "confirm" && (
            <motion.div
              key="confirm"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              className="bg-surface border border-border p-6"
            >
              <SendConfirm
                recipient={recipient}
                amount={amount}
                recipientCurrency={recipientCurrency}
                payerCurrency={payerCurrency}
                onBack={() => setStep("input")}
                onReset={() => {
                  setStep("input");
                  setRecipient("");
                  setAmount("");
                }}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <MobileNav />
    </div>
  );
}
