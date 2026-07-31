"use client";

// Treasury send — the merchant paying someone else a one-off amount.
// This lives INSIDE the authenticated dashboard (spec: "the merchant
// sending a one-off payment themselves (treasury) lives inside the
// dashboard as 'Send', not on the public surface"). It was previously the
// public app homepage — a pre-split consumer leftover.

import { useState, useEffect } from "react";
import { useAccount } from "wagmi";
import { isAddress } from "viem";
import { AddressInput } from "@/components/SendFlow/AddressInput";
import { AmountInput } from "@/components/SendFlow/AmountInput";
import { RoutePreview } from "@/components/SendFlow/RoutePreview";
import { SendConfirm } from "@/components/SendFlow/SendConfirm";
import { PayerCurrencyPicker } from "@/components/SendFlow/PayerCurrencyPicker";
import { WalletConnect } from "@/components/Shared/WalletConnect";
import type { Currency } from "@conduit/sdk";

type Step = "input" | "confirm";

export default function SendPage() {
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
    <div className="max-w-lg">
      <h1 className="font-display text-3xl font-bold mb-6">Send</h1>

      {step === "input" && (
        <div className="space-y-6">
          <div className="bg-surface border border-border p-6 space-y-6">
            <AddressInput value={recipient} onChange={setRecipient} />

            <AmountInput
              value={amount}
              onChange={setAmount}
              currency={recipientCurrency}
              onCurrencyChange={(c) => setRecipientCurrency(c)}
              label="They receive"
            />

            {/* Balance-aware: shows only currencies this treasury wallet
                actually holds, never a static list. */}
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
            <div className="space-y-3">
              <p className="text-ink-dim text-sm">
                Connect the wallet you want to send from. This is your on-chain
                treasury wallet — separate from your dashboard login.
              </p>
              <WalletConnect />
            </div>
          ) : (
            <button
              onClick={() => setStep("confirm")}
              disabled={!canProceed}
              className="w-full py-3 bg-signal text-signal-ink
                         font-mono text-sm hover:bg-signal/90 transition-colors
                         disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Review payment →
            </button>
          )}
        </div>
      )}

      {step === "confirm" && (
        <div className="bg-surface border border-border p-6">
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
        </div>
      )}
    </div>
  );
}
