"use client";

import { useState, useEffect } from "react";
import { useAccount } from "wagmi";
import type { Currency } from "@conduit/sdk";
import type { Eip1193Provider } from "ethers";
import { AmountInput } from "@/components/SendFlow/AmountInput";
import { WalletConnect } from "@/components/Shared/WalletConnect";

interface CreateFormProps {
  onSuccess: (declarationId: string, paymentUrl: string, amount: string, currency: Currency, label: string) => void;
}

export function CreateForm({ onSuccess }: CreateFormProps) {
  const { address, isConnected } = useAccount();
  const [createFlow, setCreateFlowState] = useState<{ amount: string; currency: Currency; label: string }>({
    amount: "",
    currency: "USDC",
    label: "",
  });
  const setCreateFlow = (patch: Partial<typeof createFlow>) => setCreateFlowState((s) => ({ ...s, ...patch }));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string>("");
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!address || !isConnected) return;
    setIsSubmitting(true);
    setError("");

    try {
      const { ConduitClient } = await import("@conduit/sdk");
      const { ethers } = await import("ethers");
      const { parseAmount } = await import("@/lib/format");

      const browserProvider = new ethers.BrowserProvider(
        (window as unknown as { ethereum: Eip1193Provider }).ethereum
      );
      const client = ConduitClient.fromBrowserProvider(browserProvider, "");

      const amount = createFlow.amount ? parseAmount(createFlow.amount, createFlow.currency) : 0n;

      const result = await client.createLink({
        amount,
        currency: createFlow.currency,
        recipient: address as `0x${string}`,
        label: createFlow.label || undefined,
      });

      onSuccess(result.declarationId, result.paymentUrl, createFlow.amount, createFlow.currency, createFlow.label);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create payment link");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!mounted || !isConnected) {
    return (
      <div className="text-center py-12 space-y-4">
        <p className="text-ink-dim">Connect your wallet to create a payment link.</p>
        <WalletConnect />
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <AmountInput
        value={createFlow.amount}
        onChange={(v) => setCreateFlow({ amount: v })}
        currency={createFlow.currency}
        onCurrencyChange={(c) => setCreateFlow({ currency: c as Currency })}
        label="Request Amount (leave 0 for open amount)"
      />

      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-mono text-ink-dim uppercase tracking-wider">
          Label (optional)
        </label>
        <input
          type="text"
          value={createFlow.label}
          onChange={(e) => setCreateFlow({ label: e.target.value })}
          placeholder="e.g. Table 7, Invoice #42, Coffee"
          maxLength={80}
          className="w-full px-4 py-3 bg-surface border border-border
                     text-ink placeholder:text-ink-dim outline-none
                     focus:border-ink-dim/30 transition-colors"
        />
      </div>

      {error && (
        <div className="p-3 bg-danger/10 border border-danger/30">
          <p className="text-danger text-sm font-mono">{error}</p>
        </div>
      )}

      <button
        type="submit"
        disabled={isSubmitting}
        className="w-full py-4 bg-signal text-signal-ink
                   font-mono text-lg hover:bg-signal/90 transition-colors
                   disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isSubmitting ? "Creating on-chain..." : "Create Payment Link"}
      </button>

      <p className="text-xs text-ink-dim text-center">
        Creates a declaration on Arc Testnet. Anyone with the link can pay you.
      </p>
    </form>
  );
}
