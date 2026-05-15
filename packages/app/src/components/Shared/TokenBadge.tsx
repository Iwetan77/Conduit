"use client";

import Image from "next/image";
import type { Currency } from "@conduit/sdk";

interface TokenBadgeProps {
  currency: Currency;
  size?: "sm" | "md" | "lg";
}

const TOKEN_CONFIG: Record<Currency, { symbol: string; logo: string; color: string; bg: string }> = {
  USDC: { symbol: "USDC", logo: "/usdc.svg",  color: "#2775CA", bg: "rgba(39, 117, 202, 0.15)" },
  EURC: { symbol: "EURC", logo: "/eurc.svg",  color: "#2775CA", bg: "rgba(39, 117, 202, 0.10)" },
};

const ICON_PX: Record<"sm" | "md" | "lg", number> = { sm: 20, md: 26, lg: 32 };

export function TokenBadge({ currency, size = "md" }: TokenBadgeProps) {
  const config = TOKEN_CONFIG[currency];
  const sizes = {
    sm: "px-2 py-0.5 text-xs",
    md: "px-3 py-1 text-sm",
    lg: "px-4 py-1.5 text-base",
  };
  const px = ICON_PX[size];

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-mono font-medium ${sizes[size]}`}
      style={{ color: config.color, backgroundColor: config.bg }}
    >
      <Image src={config.logo} alt={config.symbol} width={px} height={px} className="rounded-full" />
      {config.symbol}
    </span>
  );
}

// Inline currency selector
interface TokenSelectorProps {
  value: Currency;
  onChange: (currency: Currency) => void;
  label?: string;
}

export function TokenSelector({ value, onChange, label }: TokenSelectorProps) {
  const currencies: Currency[] = ["USDC", "EURC"];

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label className="text-xs font-mono text-brand-muted uppercase tracking-wider">
          {label}
        </label>
      )}
      <div className="flex gap-2">
        {currencies.map((currency) => {
          const config = TOKEN_CONFIG[currency];
          const isSelected = value === currency;
          return (
            <button
              key={currency}
              onClick={() => onChange(currency)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-mono
                          border transition-all ${
                            isSelected
                              ? "border-brand-green/50 bg-brand-green/5 text-brand-white"
                              : "border-brand-border text-brand-muted hover:border-brand-white/20"
                          }`}
            >
              <Image src={config.logo} alt={currency} width={26} height={26} className="rounded-full" />
              {currency}
            </button>
          );
        })}
      </div>
    </div>
  );
}
