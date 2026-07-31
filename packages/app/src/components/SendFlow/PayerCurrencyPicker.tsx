"use client";

// Phase 5.1, applied here too: the payer never picks from a list of
// currencies they don't hold. Real on-chain balances (a single multicall
// across every Arc-testnet token Conduit knows about) decide what's shown --
// exactly one routable balance -> shown as a confirmed fact, not a choice;
// several -> pick among what's actually held; none -> an honest message,
// never a static list of every currency that exists.
import { useEffect, useState } from "react";
import { useAccount, useReadContracts } from "wagmi";
import type { Currency } from "@conduit/sdk";
import { CURRENCIES } from "@conduit/sdk";
import { TokenIcon } from "@web3icons/react/dynamic";

const CURRENCY_LIST = Object.keys(CURRENCIES) as Currency[];

const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

interface PayerCurrencyPickerProps {
  value: Currency;
  onChange: (currency: Currency) => void;
}

export function PayerCurrencyPicker({ value, onChange }: PayerCurrencyPickerProps) {
  const { address, isConnected } = useAccount();

  // Hydration guard: wagmi's connection/query state differs between the
  // server render (never connected) and the first client render (wallet
  // auto-reconnects), which made React throw a hydration mismatch here.
  // Render nothing until mounted; everything below is client-state-driven.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const { data, isLoading } = useReadContracts({
    contracts: CURRENCY_LIST.map((c) => ({
      address: CURRENCIES[c].token as `0x${string}`,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: address ? [address] : undefined,
    })),
    query: { enabled: isConnected && !!address, refetchInterval: 10000 },
  });

  if (!mounted || !isConnected) return null;

  if (isLoading || !data) {
    return (
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-mono text-ink-dim uppercase tracking-wider">Checking your balances...</label>
      </div>
    );
  }

  const held = CURRENCY_LIST
    .map((currency, i) => ({ currency, balance: (data[i]?.result as bigint | undefined) ?? 0n }))
    .filter((c) => c.balance > 0n);

  if (held.length === 0) {
    // Honest, but not an error — an empty wallet is a normal state, not a
    // failure. Dim informational text, with the obvious next step.
    return (
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-mono text-ink-dim uppercase tracking-wider">Pay with</label>
        <p className="text-ink-dim text-sm">
          This wallet holds no stablecoins on Arc Testnet yet. Fund it with
          USDC from{" "}
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
    if (value !== only) onChange(only);
    return (
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-mono text-ink-dim uppercase tracking-wider">Paying with</label>
        <div className="flex items-center gap-2 border border-signal/50 bg-signal/5 px-3 py-2 text-sm font-mono text-ink">
          <TokenIcon symbol={only} variant="mono" size={18} color="currentColor" />
          {only}
        </div>
      </div>
    );
  }

  // Several routable assets held -> pick among only those.
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-mono text-ink-dim uppercase tracking-wider">Pay with</label>
      <div className="flex gap-2 flex-wrap">
        {held.map(({ currency }) => (
          <button
            key={currency}
            onClick={() => onChange(currency)}
            className={`flex items-center gap-2 py-2 px-3 text-sm font-mono border transition-all ${
              value === currency ? "border-signal/50 text-ink bg-signal/5" : "border-border text-ink-dim hover:border-ink-dim/20"
            }`}
          >
            <TokenIcon symbol={currency} variant="mono" size={16} color="currentColor" />
            {currency}
          </button>
        ))}
      </div>
    </div>
  );
}
