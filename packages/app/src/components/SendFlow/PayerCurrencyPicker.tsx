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
import { currencyDecimals } from "@conduit/sdk/lite";
import { formatAmountRaw } from "@/lib/format";
import { TokenIcon } from "@/components/Shared/TokenBadge";
import { useBalances, type BalanceMap } from "@/lib/use-balances";

interface PayerCurrencyPickerProps {
  value: Currency;
  onChange: (currency: Currency) => void;
  onBalancesChange?: (balances: BalanceMap) => void;
  /**
   * The payer's USDC spendable ACROSS chains, when it exceeds their Arc balance.
   *
   * This picker reads Arc balances, which is right for every settle currency
   * except one. USDC also exists on the Gateway source chains, pooled behind a
   * single signature, and a payment can draw on that pool -- so a payer holding
   * 12 on Arc and 40 across Polygon and Base can spend 40, not 12. Showing the
   * Arc figure alone understated what they had and, worse, dropped USDC out of
   * the list entirely for anyone holding none on Arc.
   *
   * Only USDC. Gateway moves USDC and nothing else, so EURC and the rest are
   * correctly Arc-only.
   */
  usdcSpendableMinor?: bigint;
}

export function PayerCurrencyPicker({
  value,
  onChange,
  onBalancesChange,
  usdcSpendableMinor,
}: PayerCurrencyPickerProps) {
  const { address, isConnected } = useAccount();

  // Hydration guard: wagmi's connection state differs between the server
  // render (never connected) and the first client render (wallet
  // auto-reconnects), which threw a hydration mismatch here.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const { balances, settled } = useBalances(address, isConnected);

  // What each currency is actually worth to this payment.
  //
  // Arc balance for everything, except USDC where the cross-chain pool is
  // larger -- see usdcSpendableMinor. Applied BEFORE the `> 0` filter on
  // purpose: a payer with nothing on Arc but 40 on Base holds a spendable USDC
  // balance, and filtering on the Arc figure removed USDC from the picker
  // altogether, leaving them unable to select the one currency they could pay
  // with.
  const spendableOf = (currency: Currency, arcBalance: bigint) =>
    currency === "USDC" && usdcSpendableMinor !== undefined && usdcSpendableMinor > arcBalance
      ? usdcSpendableMinor
      : arcBalance;

  const allCurrencies = new Set<Currency>(Object.keys(balances) as Currency[]);
  if (usdcSpendableMinor !== undefined && usdcSpendableMinor > 0n) allCurrencies.add("USDC");

  const held = [...allCurrencies]
    .map((currency) => ({ currency, balance: spendableOf(currency, balances[currency] ?? 0n) }))
    .filter(({ balance }) => balance > 0n)
    .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));

  // A payer choosing what to pay with couldn't see how much they actually
  // held -- the picker named the currencies but not the amounts, so "do I even
  // have enough?" was unanswerable on the /pay screen. Show the balance
  // alongside each option.
  const fmtBalance = (currency: Currency, balance: bigint) =>
    formatAmountRaw(balance, currencyDecimals(currency));

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
    // Raw ARC balances, deliberately. The caller uses this to decide whether the
    // payment can settle directly on Arc, and folding the cross-chain pool in
    // here would tell it Arc holds money it does not.
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
          <span className="ml-auto text-ink-dim">
            Balance {fmtBalance(only, held[0].balance)}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-mono text-ink-dim uppercase tracking-wider">Pay with</label>
      <div className="flex gap-2 flex-wrap">
        {held.map(({ currency, balance }) => (
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
            <span className="text-ink-dim text-xs">{fmtBalance(currency, balance)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
