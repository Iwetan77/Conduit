"use client";

import { useState } from "react";
import type { Currency } from "@conduit/sdk/lite";
import { currencyDecimals, toHumanAmount } from "@conduit/sdk/lite";
import { TokenIcon, TokenSelector } from "@/components/Shared/TokenBadge";

interface AmountInputProps {
  value: string;
  onChange: (value: string) => void;
  currency: Currency;
  onCurrencyChange: (currency: Currency) => void;
  label?: string;
  max?: bigint;
}

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
      <label className="text-xs font-mono text-ink-dim uppercase tracking-wider">
        {label}
      </label>

      {/* Large amount display */}
      <div
        className={`relative bg-surface border overflow-hidden transition-colors
                    ${showError ? "border-danger/50" : "border-border focus-within:border-ink-dim/30"}`}
      >
        <div className="flex items-center px-4 py-4 gap-3">
          {/* The token's own logo, not a fiat glyph. A "$" in front of a USDC
              amount named the currency USDC tracks rather than the asset being
              sent, "£" said the same thing for GBPA, and KRW1 had no entry at
              all and so showed nothing. */}
          <TokenIcon currency={currency} px={26} />
          <input
            type="number"
            value={value}
            onChange={handleChange}
            onBlur={() => setTouched(true)}
            placeholder="0.00"
            className="flex-1 bg-transparent text-3xl font-display font-bold
                       text-ink outline-none placeholder:text-ink-dim"
            min="0"
            step={(1 / 10 ** decimals).toFixed(decimals)}
          />
        </div>

        {max !== undefined && (
          <div className="px-4 pb-3 flex justify-between items-center">
            <span className="text-xs text-ink-dim font-mono">
              Balance: {toHumanAmount(max, decimals)} {currency}
            </span>
            <button
              onClick={() => onChange(toHumanAmount(max, decimals))}
              className="text-xs text-signal font-mono hover:text-signal/70 transition-colors"
            >
              MAX
            </button>
          </div>
        )}
      </div>

      <TokenSelector value={currency} onChange={onCurrencyChange} label="Currency" />

      {showError && (
        <p className="text-xs text-danger font-mono">
          Enter a valid amount greater than 0
        </p>
      )}
    </div>
  );
}
