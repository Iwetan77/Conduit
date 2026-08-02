"use client";

import Link from "next/link";

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
import type { Currency } from "@conduit/sdk/lite";
import { motion, AnimatePresence } from "framer-motion";
import { useRequiredPayerAmount } from "@/lib/use-required-payer-amount";
import { formatAmount } from "@/lib/format";
import type { BalanceMap } from "@/lib/use-balances";

type Step = "input" | "confirm";

// The real send flow, on its own route. The landing page at / shows a
// scripted demo of this instead, so a first-time visitor sees how it works
// without a wallet, and only lands here once they've chosen to pay.
export default function SendPage() {
  const [mounted, setMounted] = useState(false);
  const { isConnected } = useAccount();
  const [step, setStep] = useState<Step>("input");

  useEffect(() => { setMounted(true); }, []);

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [recipientCurrency, setRecipientCurrency] = useState<Currency>("USDC");
  const [payerCurrency, setPayerCurrency] = useState<Currency>("USDC");
  const [payerBalances, setPayerBalances] = useState<BalanceMap>({});

  // What this send actually costs in the payer's currency (AMM exact-out
  // quote for cross-currency, 1:1 for same), checked against their real
  // balance BEFORE the confirm step so nobody walks into a revert.
  const required = useRequiredPayerAmount(payerCurrency, recipientCurrency, amount);
  const payerBalance = payerBalances[payerCurrency];
  const insufficient =
    required.data !== undefined && payerBalance !== undefined && payerBalance < required.data;

  // Cross-currency is a first-class send, not a merchant-only feature: it
  // settles through Circle StableFX against a settlement intent that /send
  // creates against its own personal account. No payment link, no merchant
  // dashboard. SendConfirm drives it end to end.
  const crossCurrency = payerCurrency !== recipientCurrency;
  const canProceed =
    isAddress(recipient) &&
    parseFloat(amount) > 0 &&
    isConnected &&
    !insufficient;

  return (
    <div className="min-h-screen">
      <Nav />

      <main className="max-w-lg mx-auto px-4 pt-24 pb-24">
        <div className="text-center mb-8">
          <h1 className="font-display font-bold text-3xl text-ink">Send</h1>
          <p className="text-ink-dim text-sm mt-1">
            Pay anyone in the currency they want, from whatever you hold.
          </p>
          <div className="flex justify-center mt-5">
            <ScanToPay />
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
              <div className="bg-surface border border-border p-6 space-y-6">
                <h2 className="text-xs font-mono text-ink-dim uppercase tracking-widest">
                  Direct Send
                </h2>

                <AddressInput value={recipient} onChange={setRecipient} />

                <AmountInput
                  value={amount}
                  onChange={setAmount}
                  currency={recipientCurrency}
                  onCurrencyChange={(c) => setRecipientCurrency(c)}
                  label="They receive"
                />

                {/* Balance-aware: only what this wallet actually holds. */}
                <PayerCurrencyPicker
                  value={payerCurrency}
                  onChange={setPayerCurrency}
                  onBalancesChange={setPayerBalances}
                />

                {crossCurrency && (
                  <div className="border border-border bg-surface p-3 space-y-1">
                    <p className="text-ink text-sm font-mono">
                      Converting {payerCurrency} → {recipientCurrency}
                    </p>
                    <p className="text-ink-dim text-sm">
                      Circle StableFX prices this at payment time. You&apos;ll see the exact
                      rate and what it costs you before you sign anything.
                    </p>
                  </div>
                )}

                {!crossCurrency && insufficient && required.data !== undefined && payerBalance !== undefined && (
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
                      // Cross-currency has no pre-quote (Circle prices it at
                      // pay time), so show nothing rather than a fabricated
                      // 0.00 — the real rate appears before you sign.
                      payerCurrency === recipientCurrency && required.data !== undefined
                        ? formatAmount(required.data, payerCurrency)
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

              <div className="text-center">
                <p className="text-ink-dim text-sm">
                  Running a business?{" "}
                  <Link href="/dashboard" className="text-signal hover:underline">
                    Sign in as a merchant →
                  </Link>
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
