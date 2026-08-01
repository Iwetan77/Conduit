"use client";

// Phase 5.1, applied here too: the payer never picks from a list of
// currencies they don't hold. Real on-chain balances (a single multicall
// across every Arc-testnet token Conduit knows about) decide what's shown --
// exactly one routable balance -> shown as a confirmed fact, not a choice;
// several -> pick among what's actually held; none -> an honest message,
// never a static list of every currency that exists.
import { useEffect, useState } from "react";
import { useAccount, useReadContracts } from "wagmi";
import { keepPreviousData } from "@tanstack/react-query";
import type { Currency } from "@conduit/sdk";
import { CURRENCIES } from "@conduit/sdk";
import { TokenIcon } from "@/components/Shared/TokenBadge";

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
  onBalancesChange?: (balances: Partial<Record<Currency, bigint>>) => void;
}

// Last-known balances per address, so a returning payer sees their held
// currencies instantly instead of "Checking your balances…" while the
// (rate-limited) RPC round-trip happens in the background.
function readSnapshot(address: string): Partial<Record<Currency, bigint>> | null {
  try {
    const raw = localStorage.getItem(`conduit.balances.${address.toLowerCase()}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, string>;
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, BigInt(v)]));
  } catch {
    return null;
  }
}

function writeSnapshot(address: string, balances: Partial<Record<Currency, bigint>>) {
  try {
    localStorage.setItem(
      `conduit.balances.${address.toLowerCase()}`,
      JSON.stringify(Object.fromEntries(Object.entries(balances).map(([k, v]) => [k, String(v)])))
    );
  } catch {}
}

export function PayerCurrencyPicker({ value, onChange, onBalancesChange }: PayerCurrencyPickerProps) {
  const { address, isConnected } = useAccount();

  // Hydration guard: wagmi's connection/query state differs between the
  // server render (never connected) and the first client render (wallet
  // auto-reconnects), which made React throw a hydration mismatch here.
  // Render nothing until mounted; everything below is client-state-driven.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const { data } = useReadContracts({
    contracts: CURRENCY_LIST.map((c) => ({
      address: CURRENCIES[c].token as `0x${string}`,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: address ? [address] : undefined,
    })),
    query: {
      enabled: isConnected && !!address,
      refetchInterval: 30000,
      // Arc's public RPC rate-limits; without retries + kept data a single
      // failed refetch made real balances vanish from the UI. Two quick
      // retries, not slow exponential ones — the snapshot below covers the
      // wait, so long backoffs only make the UI feel broken.
      retry: 2,
      retryDelay: (attempt: number) => 300 * (attempt + 1),
      placeholderData: keepPreviousData,
    },
  });

  // A failed read is UNKNOWN, never zero. Claiming "you hold nothing" off a
  // rate-limited RPC response was a real user-visible bug.
  const fresh = !!data && data.some((d) => d.status === "success");
  const allKnown = !!data && data.every((d) => d.status === "success");
  const snapshot = !fresh && mounted && address ? readSnapshot(address) : null;
  const balances: Partial<Record<Currency, bigint>> = fresh
    ? Object.fromEntries(
        (data ?? []).flatMap((d, i) =>
          d.status === "success" ? [[CURRENCY_LIST[i] as Currency, d.result as bigint]] : []
        )
      )
    : snapshot ?? {};

  const held = (Object.entries(balances) as [Currency, bigint][])
    .filter(([, b]) => b > 0n)
    .map(([currency, balance]) => ({ currency, balance }))
    .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));

  // Keep the selected currency inside the held set (prefer the largest
  // balance), persist the snapshot, and report balances up to the page for
  // sufficiency checks. Effects, never during render.
  const heldKey = held.map((h) => h.currency).join(",");
  useEffect(() => {
    if (held.length > 0 && !held.some((h) => h.currency === value)) {
      onChange(held[0]!.currency);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heldKey]);
  useEffect(() => {
    if (fresh && address && allKnown) writeSnapshot(address, balances);
    onBalancesChange?.(balances);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh, allKnown, address, heldKey]);

  if (!mounted || !isConnected) return null;

  // Nothing to show yet and results not conclusive → "checking". A snapshot
  // (or partial success) skips this entirely; a conclusive all-zero result
  // falls through to the honest empty-wallet message below.
  if (held.length === 0 && !allKnown) {
    // Includes the partially-failed case: better to say "checking" a beat
    // longer than to tell someone with money that they're broke.
    return (
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-mono text-ink-dim uppercase tracking-wider">Checking your balances...</label>
      </div>
    );
  }

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
            <TokenIcon currency={currency} px={16} />
            {currency}
          </button>
        ))}
      </div>
    </div>
  );
}
