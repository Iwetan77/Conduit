"use client";

// Phase 5.1: the payer never picks from a list of currencies they don't hold.
// Real balances decide what's shown — exactly one routable balance is stated
// as a fact, not offered as a choice; several means pick among what's actually
// held; none gets an honest message, never a static list of every currency
// that exists.
//
// Balances come from the Conduit API's cached Multicall3 endpoint rather than
// from this browser, so a hundred payers cost the RPC one read (see
// lib/use-balances.ts).
import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import type { Currency } from "@conduit/sdk/lite";
import { TokenIcon } from "@/components/Shared/TokenBadge";
import { useBalances, type BalanceMap } from "@/lib/use-balances";

interface PayerCurrencyPickerProps {
  value: Currency;
  onChange: (currency: Currency) => void;
  onBalancesChange?: (balances: BalanceMap) => void;
}

export function PayerCurrencyPicker({ value, onChange, onBalancesChange }: PayerCurrencyPickerProps) {
  const { address, isConnected } = useAccount();

  // Hydration guard: wagmi's connection state differs between the server
  // render (never connected) and the first client render (wallet
  // auto-reconnects), which threw a hydration mismatch here.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const { balances, settled } = useBalances(address, isConnected);

  const held = (Object.entries(balances) as [Currency, bigint][])
    .filter(([, b]) => b > 0n)
    .map(([currency, balance]) => ({ currency, balance }))
    .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));

  // Keep the selection inside the held set (largest balance wins) and report
  // balances up for the sufficiency check. Effects, never during render.
  const heldKey = held.map((h) => h.currency).join(",");
  useEffect(() => {
    if (held.length > 0 && !held.some((h) => h.currency === value)) {
      onChange(held[0]!.currency);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heldKey]);
  useEffect(() => {
    onBalancesChange?.(balances);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heldKey, settled]);

  if (!mounted || !isConnected) return null;

  // Nothing held AND no successful read yet — say "checking", never "empty".
  if (held.length === 0 && !settled) {
    return (
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-mono text-ink-dim uppercase tracking-wider">
          Checking your balances...
        </label>
      </div>
    );
  }

  if (held.length === 0) {
    // Honest, but not an error — an empty wallet is a normal state.
    return (
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-mono text-ink-dim uppercase tracking-wider">Pay with</label>
        <p className="text-ink-dim text-sm">
          This wallet holds no stablecoins on Arc Testnet yet. Fund it with USDC from{" "}
          <a href="https://faucet.circle.com" target="_blank" rel="noreferrer" className="text-signal hover:underline">
            faucet.circle.com
          </a>{" "}
          to send.
        </p>
      </div>
    );
  }

  // Exactly one routable asset -> a confirmed fact, not a picker.
  if (held.length === 1 && held[0]) {
    const only = held[0].currency;
    return (
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-mono text-ink-dim uppercase tracking-wider">Paying with</label>
        <div className="flex items-center gap-2 border border-signal/50 bg-signal/5 px-3 py-2 text-sm font-mono text-ink">
          <TokenIcon currency={only} px={18} />
          {only}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-mono text-ink-dim uppercase tracking-wider">Pay with</label>
      <div className="flex gap-2 flex-wrap">
        {held.map(({ currency }) => (
          <button
            key={currency}
            onClick={() => onChange(currency)}
            className={`flex items-center gap-2 py-2 px-3 text-sm font-mono border transition-all ${
              value === currency
                ? "border-signal/50 text-ink bg-signal/5"
                : "border-border text-ink-dim hover:border-ink-dim/20"
            }`}
          >
            <TokenIcon currency={currency} px={16} />
            {currency}
          </button>
        ))}
      </div>
    </div>
  );
}
