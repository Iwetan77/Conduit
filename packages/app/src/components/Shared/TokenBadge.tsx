"use client";

import Image from "next/image";
import type { Currency } from "@conduit/sdk";
import { CURRENCIES } from "@conduit/sdk";

interface TokenBadgeProps {
  currency: Currency;
  size?: "sm" | "md" | "lg";
}

interface TokenVisual {
  symbol: string;
  logo?: string; // undefined = no artwork yet, render a monogram instead
}

// Visual styling for every currency in CURRENCIES (@conduit/sdk). Only USDC and
// EURC have real logo artwork today (public/usdc.svg, public/eurc.svg) — the
// rest render a monogram. One accent system: no per-currency hues (that was
// audit finding — 8 distinct colors, the "third hue" the design spec bans).
const TOKEN_CONFIG: Record<string, TokenVisual> = {
  USDC: { symbol: "USDC", logo: "/usdc.svg" },
  EURC: { symbol: "EURC", logo: "/eurc.svg" },
  BRLA: { symbol: "BRLA" },
  AUDF: { symbol: "AUDF" },
  MXNB: { symbol: "MXNB" },
  QCAD: { symbol: "QCAD" },
  GBPA: { symbol: "GBPA" },
  ZARU: { symbol: "ZARU" },
};

function visualFor(currency: Currency): TokenVisual {
  return TOKEN_CONFIG[currency] ?? { symbol: currency };
}

function TokenIcon({ currency, px }: { currency: Currency; px: number }) {
  const config = visualFor(currency);
  if (config.logo) {
    return <Image src={config.logo} alt={config.symbol} width={px} height={px} />;
  }
  return (
    <span
      className="flex items-center justify-center font-mono font-bold shrink-0 border border-border text-ink-dim"
      style={{ width: px, height: px, fontSize: px * 0.4 }}
    >
      {config.symbol.slice(0, 1)}
    </span>
  );
}

export function TokenBadge({ currency, size = "md" }: TokenBadgeProps) {
  const config = visualFor(currency);
  const sizes = {
    sm: "px-2 py-0.5 text-scale-1",
    md: "px-3 py-1 text-scale-2",
    lg: "px-4 py-1.5 text-scale-3",
  };
  const px = { sm: 20, md: 26, lg: 32 }[size];

  return (
    <span
      className={`inline-flex items-center gap-1.5 font-mono font-medium border border-border text-ink ${sizes[size]}`}
    >
      <TokenIcon currency={currency} px={px} />
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
  const currencies: Currency[] = Object.keys(CURRENCIES);

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider">
          {label}
        </label>
      )}
      <div className="flex gap-2 flex-wrap">
        {currencies.map((currency) => {
          const isSelected = value === currency;
          return (
            <button
              key={currency}
              onClick={() => onChange(currency)}
              className={`flex items-center gap-2 px-3 py-2 text-scale-2 font-mono
                          border transition-colors ${
                            isSelected
                              ? "border-signal text-ink"
                              : "border-border text-ink-dim hover:border-ink-dim"
                          }`}
            >
              <TokenIcon currency={currency} px={22} />
              {currency}
            </button>
          );
        })}
      </div>
    </div>
  );
}
