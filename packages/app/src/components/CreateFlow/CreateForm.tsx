"use client";

import { useState, useEffect } from "react";
import { useAccount } from "wagmi";
import type { Currency } from "@conduit/sdk/lite";
import { AmountInput } from "@/components/SendFlow/AmountInput";
import { WalletConnect } from "@/components/Shared/WalletConnect";
import { usePayerIdentity } from "@/lib/use-payer-identity";

interface CreateFormProps {
  onSuccess: (declarationId: string, paymentUrl: string, amount: string, currency: Currency, label: string) => void;
}

export function CreateForm({ onSuccess }: CreateFormProps) {
  const { address, isConnected, connector } = useAccount();
  // Who is connected, across BOTH wallet families. `isConnected` above is
  // wagmi's answer, which knows only about EVM -- so a payer on a Solana wallet
  // reads as "not connected" here even though the nav is showing their address.
  const { identity, disconnect } = usePayerIdentity();
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
      const { parseAmount } = await import("@/lib/format");
      const { createDirectSettlementIntent } = await import("@/lib/conduit-api");

      const amount = createFlow.amount ? parseAmount(createFlow.amount, createFlow.currency) : 0n;
      if (amount <= 0n) {
        setError("Enter an amount to request.");
        setIsSubmitting(false);
        return;
      }

      // Payer links now mint a server-side settlement intent (si_...) instead
      // of registering an on-chain declaration. Three problems went away at
      // once: no on-chain transaction to fail on Arc's flaky RPC (this was the
      // "could not create link" error), a short shareable id instead of a
      // 66-char declaration hash, and a real OG preview card on /pay/[id]
      // (generateMetadata only resolves pl_/si_ ids, never raw hashes). The
      // creator is both the intent's owner and its settle_address -- whoever
      // opens the link later pays it with their own wallet.
      const intent = await createDirectSettlementIntent({
        payer_wallet: address,
        amount: amount.toString(),
        settle_currency: createFlow.currency,
        settle_address: address,
      });

      const paymentUrl = `${window.location.origin}/pay/${intent.id}`;
      onSuccess(intent.id, paymentUrl, createFlow.amount, createFlow.currency, createFlow.label);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create payment link");
    } finally {
      setIsSubmitting(false);
    }
  };

  // Three states, not two.
  //
  // This gated on wagmi's `isConnected`, which is EVM-only, so a Solana wallet
  // landed in the "not connected" branch -- showing "Connect your wallet to
  // create a payment link" directly above a WalletConnect that rendered their
  // connected Solana address. A dead end: the page asked for the one thing they
  // had already done, and doing it again changed nothing.
  //
  // Solana genuinely cannot create a link, and the reason is real rather than a
  // limitation of this form: a payment link is settled ON ARC, to the merchant's
  // own address, and a Solana keypair cannot hold or sign for an Arc address.
  // That is worth saying out loud instead of hiding behind a connect prompt.
  if (!mounted || !identity) {
    return (
      <div className="text-center py-12 space-y-4">
        <p className="text-ink-dim">Connect your wallet to create a payment link.</p>
        <WalletConnect />
      </div>
    );
  }

  if (identity.kind === "solana" || !isConnected) {
    return (
      <div className="text-center py-12 space-y-4 max-w-sm mx-auto">
        <p className="text-ink font-medium">Payment links settle on Arc</p>
        <p className="text-ink-dim text-sm leading-relaxed">
          A link pays out to your own address on Arc, so it has to be created from
          a wallet that can hold one. Your Solana wallet can <em>pay</em> a link
          from any chain — it just cannot be the one receiving.
        </p>
        <p className="text-ink-dim text-sm leading-relaxed">
          Sign in with Google, or connect an EVM wallet, to create links.
        </p>
        <button
          type="button"
          onClick={() => void disconnect()}
          className="text-scale-1 font-mono text-ink-dim hover:text-ink transition-colors"
        >
          Disconnect this wallet →
        </button>
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
        label="Request Amount"
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
        {isSubmitting ? "Creating link…" : "Create Payment Link"}
      </button>

      <p className="text-xs text-ink-dim text-center">
        Anyone with the link can pay you in any stablecoin — Conduit converts to {createFlow.currency}.
      </p>
    </form>
  );
}
