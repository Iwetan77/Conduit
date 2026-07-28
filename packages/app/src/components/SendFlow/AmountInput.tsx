"use client";

import { useState } from "react";
import type { Currency } from "@conduit/sdk";
import { currencyDecimals, toHumanAmount } from "@conduit/sdk";
import { TokenSelector } from "@/components/Shared/TokenBadge";

interface AmountInputProps {
  value: string;
  onChange: (value: string) => void;
  currency: Currency;
  onCurrencyChange: (currency: Currency) => void;
  label?: string;
  max?: bigint;
}

const SYMBOLS: Record<string, string> = { USDC: "$", EURC: "€", BRLA: "R$", AUDF: "A$", MXNB: "MX$", QCAD: "C$" };

export function AmountInput({
  value,
  onChange,
  currency,
  onCurrencyChange,
  label = "Amount",
  max,
}: AmountInputProps) {
  const [touched, setTouched] = useState(false);
  const decimals = currencyDecimals(currency);
  const numericValue = parseFloat(value || "0");
  const isValid = !value || numericValue > 0;
  const showError = touched && value && !isValid;
  const decimalRegex = new RegExp(`^\\d*\\.?\\d{0,${decimals}}$`);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    // Only allow numbers and one decimal point, up to this currency's own decimals
    if (decimalRegex.test(v) || v === "") {
      onChange(v);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <label className="text-xs font-mono text-brand-muted uppercase tracking-wider">
        {label}
      </label>

      {/* Large amount display */}
      <div
        className={`relative bg-brand-surface border rounded-xl overflow-hidden transition-colors
                    ${showError ? "border-red-500/50" : "border-brand-border focus-within:border-brand-white/30"}`}
      >
        <div className="flex items-center px-4 py-4 gap-3">
          <span className="text-brand-muted text-2xl font-display select-none">
            {SYMBOLS[currency] ?? ""}
          </span>
          <input
            type="number"
            value={value}
            onChange={handleChange}
            onBlur={() => setTouched(true)}
            placeholder="0.00"
            className="flex-1 bg-transparent text-3xl font-display font-bold
                       text-brand-white outline-none placeholder:text-brand-border"
            min="0"
            step={(1 / 10 ** decimals).toFixed(decimals)}
          />
        </div>

        {max !== undefined && (
          <div className="px-4 pb-3 flex justify-between items-center">
            <span className="text-xs text-brand-muted font-mono">
              Balance: {toHumanAmount(max, decimals)} {currency}
            </span>
            <button
              onClick={() => onChange(toHumanAmount(max, decimals))}
              className="text-xs text-brand-green font-mono hover:text-brand-green/70 transition-colors"
            >
              MAX
            </button>
          </div>
        )}
      </div>

      <TokenSelector value={currency} onChange={onCurrencyChange} label="Currency" />

      {showError && (
        <p className="text-xs text-red-400 font-mono">
          Enter a valid amount greater than 0
        </p>
      )}
    </div>
  );
}
