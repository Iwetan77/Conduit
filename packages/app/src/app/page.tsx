"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { isAddress } from "viem";
import { ConduitMark } from "@/components/Shared/Logo";
import { Nav, MobileNav } from "@/components/Shared/Nav";
import { AddressInput } from "@/components/SendFlow/AddressInput";
import { AmountInput } from "@/components/SendFlow/AmountInput";
import { RoutePreview } from "@/components/SendFlow/RoutePreview";
import { SendConfirm } from "@/components/SendFlow/SendConfirm";
import { WalletConnect } from "@/components/Shared/WalletConnect";
import type { Currency } from "@conduit/sdk";
import { motion, AnimatePresence } from "framer-motion";

type Step = "input" | "confirm";

export default function HomePage() {
  const { isConnected } = useAccount();
  const [step, setStep] = useState<Step>("input");

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [recipientCurrency, setRecipientCurrency] = useState<Currency>("USDC");
  const [payerCurrency, setPayerCurrency] = useState<Currency>("USDC");

  const canProceed = isAddress(recipient) && parseFloat(amount) > 0 && isConnected;

  return (
    <div className="min-h-screen bg-brand-black">
      <Nav />

      <main className="max-w-lg mx-auto px-4 pt-24 pb-24">
        {/* Hero */}
        <div className="text-center mb-10">
          <div className="flex justify-center mb-4">
            <ConduitMark height={72} />
          </div>
          <p className="text-brand-muted mt-3 text-sm font-mono">
            Arc&apos;s native agent payment protocol
          </p>
          <div className="flex items-center justify-center gap-2 mt-2">
            <span className="w-1.5 h-1.5 rounded-full bg-brand-green animate-pulse" />
            <span className="text-xs font-mono text-brand-green">
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
              <div className="bg-brand-surface border border-brand-border rounded-2xl p-6 space-y-6">
                <h2 className="text-xs font-mono text-brand-muted uppercase tracking-widest">
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

                {/* Payer currency toggle */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-mono text-brand-muted uppercase tracking-wider">
                    You pay with
                  </label>
                  <div className="flex gap-2">
                    {(["USDC", "EURC"] as Currency[]).map((c) => (
                      <button
                        key={c}
                        onClick={() => setPayerCurrency(c)}
                        className={`flex-1 py-2 rounded-lg text-sm font-mono border transition-all ${
                          payerCurrency === c
                            ? "border-brand-green/50 text-brand-white bg-brand-green/5"
                            : "border-brand-border text-brand-muted hover:border-brand-white/20"
                        }`}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                </div>

                {amount && recipient && (
                  <RoutePreview
                    payerCurrency={payerCurrency}
                    recipientCurrency={recipientCurrency}
                    recipientAmount={amount}
                  />
                )}
              </div>

              {!isConnected ? (
                <div className="text-center space-y-3">
                  <p className="text-brand-muted text-sm">Connect your wallet to send</p>
                  <WalletConnect />
                </div>
              ) : (
                <button
                  onClick={() => setStep("confirm")}
                  disabled={!canProceed}
                  className="w-full py-4 rounded-2xl bg-brand-green text-brand-black
                             font-bold text-xl hover:bg-brand-green/90 transition-colors
                             disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Review Payment →
                </button>
              )}

              {/* Links CTA */}
              <div className="text-center">
                <p className="text-brand-muted text-sm">
                  Need a payment link or QR?{" "}
                  <a href="/create" className="text-brand-green hover:underline">
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
              className="bg-brand-surface border border-brand-border rounded-2xl p-6"
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
