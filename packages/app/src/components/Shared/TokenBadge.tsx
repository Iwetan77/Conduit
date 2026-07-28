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
  color: string;
  bg: string;
}

// Visual styling for every currency in CURRENCIES (@conduit/sdk). Only USDC and
// EURC have real logo artwork today (public/usdc.svg, public/eurc.svg) — the
// rest render a colored monogram rather than an <Image> pointing at a file that
// doesn't exist. This was a closed Record<Currency,...> keyed to exactly USDC
// and EURC before (audit finding #20: TOKEN_CONFIG[currency] was undefined —
// and crashed on `.symbol` — for any third currency).
const TOKEN_CONFIG: Record<string, TokenVisual> = {
  USDC: { symbol: "USDC", logo: "/usdc.svg", color: "#2775CA", bg: "rgba(39, 117, 202, 0.15)" },
  EURC: { symbol: "EURC", logo: "/eurc.svg", color: "#2775CA", bg: "rgba(39, 117, 202, 0.10)" },
  BRLA: { symbol: "BRLA", color: "#2E9E5B", bg: "rgba(46, 158, 91, 0.12)" },
  AUDF: { symbol: "AUDF", color: "#C99A2E", bg: "rgba(201, 154, 46, 0.12)" },
  MXNB: { symbol: "MXNB", color: "#B3492D", bg: "rgba(179, 73, 45, 0.12)" },
  QCAD: { symbol: "QCAD", color: "#5C4EA6", bg: "rgba(92, 78, 166, 0.12)" },
  GBPA: { symbol: "GBPA", color: "#7A3E9D", bg: "rgba(122, 62, 157, 0.12)" },
  ZARU: { symbol: "ZARU", color: "#2E7D9E", bg: "rgba(46, 125, 158, 0.12)" },
};

function visualFor(currency: Currency): TokenVisual {
  return TOKEN_CONFIG[currency] ?? { symbol: currency, color: "#888", bg: "rgba(136,136,136,0.12)" };
}

function TokenIcon({ currency, px }: { currency: Currency; px: number }) {
  const config = visualFor(currency);
  if (config.logo) {
    return <Image src={config.logo} alt={config.symbol} width={px} height={px} className="rounded-full" />;
  }
  return (
    <span
      className="flex items-center justify-center rounded-full font-mono font-bold shrink-0"
      style={{ width: px, height: px, fontSize: px * 0.4, color: config.color, backgroundColor: config.bg }}
    >
      {config.symbol.slice(0, 1)}
    </span>
  );
}

export function TokenBadge({ currency, size = "md" }: TokenBadgeProps) {
  const config = visualFor(currency);
  const sizes = {
    sm: "px-2 py-0.5 text-xs",
    md: "px-3 py-1 text-sm",
    lg: "px-4 py-1.5 text-base",
  };
  const px = { sm: 20, md: 26, lg: 32 }[size];

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-mono font-medium ${sizes[size]}`}
      style={{ color: config.color, backgroundColor: config.bg }}
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
        <label className="text-xs font-mono text-brand-muted uppercase tracking-wider">
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
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-mono
                          border transition-all ${
                            isSelected
                              ? "border-brand-green/50 bg-brand-green/5 text-brand-white"
                              : "border-brand-border text-brand-muted hover:border-brand-white/20"
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
