"use client";

import { useState, useEffect } from "react";
import { useAccount } from "wagmi";
import { isAddress } from "viem";
import { Nav, MobileNav } from "@/components/Shared/Nav";
import { AddressInput } from "@/components/SendFlow/AddressInput";
import { AmountInput } from "@/components/SendFlow/AmountInput";
import { RoutePreview } from "@/components/SendFlow/RoutePreview";
import { SendConfirm } from "@/components/SendFlow/SendConfirm";
import { PayerCurrencyPicker } from "@/components/SendFlow/PayerCurrencyPicker";
import { WalletConnect } from "@/components/Shared/WalletConnect";
import { ScanToPay } from "@/components/PayFlow/ScanToPay";
import type { Currency } from "@conduit/sdk";
import { motion, AnimatePresence } from "framer-motion";
import { useRequiredPayerAmount } from "@/lib/use-required-payer-amount";
import { formatAmount } from "@/lib/format";
import {
  Hero,
  Features,
  HowItWorks,
  WaitlistSection,
  EcosystemBadge,
  Footer,
} from "@/components/Landing/LandingSections";

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
  const [payerBalances, setPayerBalances] = useState<Partial<Record<Currency, bigint>>>({});

  // What this send actually costs in the payer's currency (AMM exact-out
  // quote for cross-currency, 1:1 for same). Validated against the payer's
  // real balance BEFORE the confirm step — no more walking into a revert.
  const required = useRequiredPayerAmount(payerCurrency, recipientCurrency, amount);
  const payerBalance = payerBalances[payerCurrency];
  const insufficient =
    required.data !== undefined && payerBalance !== undefined && payerBalance < required.data;

  const canProceed =
    isAddress(recipient) && parseFloat(amount) > 0 && isConnected && !insufficient;

  return (
    <div className="min-h-screen">
      <Nav />

      {/* Landing hero — moved in from the former marketing site so the whole
          product is one app: this page introduces Conduit AND lets a payer
          act immediately, instead of being a separate site that links away. */}
      <Hero />

      <main id="send" className="max-w-lg mx-auto px-4 pt-4 pb-24 scroll-mt-20">
        {/* Scan-to-pay: the fastest path for someone standing in front of
            a merchant's printed QR. */}
        <div className="flex justify-center mb-8">
          <ScanToPay />
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
                <PayerCurrencyPicker
                  value={payerCurrency}
                  onChange={setPayerCurrency}
                  onBalancesChange={setPayerBalances}
                />

                {insufficient && required.data !== undefined && payerBalance !== undefined && (
                  <p className="text-danger text-sm font-mono">
                    Insufficient {payerCurrency}: this payment needs ~
                    {formatAmount(required.data, payerCurrency)} {payerCurrency}, you have{" "}
                    {formatAmount(payerBalance, payerCurrency)}.
                  </p>
                )}

                {amount && recipient && (
                  <RoutePreview
                    payerCurrency={payerCurrency}
                    recipientCurrency={recipientCurrency}
                    recipientAmount={amount}
                    payerAmount={
                      required.data !== undefined
                        ? `${payerCurrency === recipientCurrency ? "" : "~"}${formatAmount(required.data, payerCurrency)}`
                        : undefined
                    }
                    isLoading={required.isLoading}
                  />
                )}
              </div>

              {!mounted || !isConnected ? (
                <div className="text-center space-y-3">
                  <p className="text-ink-dim text-sm">Connect your wallet to send</p>
                  <div className="flex justify-center">
                    <WalletConnect />
                  </div>
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

              {/* Merchant entry — the other half of the product. */}
              <div className="text-center">
                <p className="text-ink-dim text-sm">
                  Running a business?{" "}
                  <a href="/dashboard" className="text-signal hover:underline">
                    Sign in as a merchant →
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

      {/* The rest of the former marketing site, below the working send card:
          what Conduit is, how the pipe works, and the waitlist. */}
      <Features />
      <HowItWorks />
      <WaitlistSection />
      <EcosystemBadge />
      <Footer />

      <MobileNav />
    </div>
  );
}
