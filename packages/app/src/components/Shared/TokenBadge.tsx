"use client";

import { useEffect, useRef, useState } from "react";
import { TokenIcon as Web3TokenIcon } from "@web3icons/react/dynamic";
import type { Currency } from "@conduit/sdk";
import { CURRENCIES } from "@conduit/sdk";
// Real SVG flags — flag EMOJI render as bare letters ("BR") on Windows
// browsers, which is why the earlier emoji attempt "didn't load".
import { BR, AU, MX, CA, GB, ZA, KR, type FlagComponent } from "country-flag-icons/react/3x2";

interface TokenBadgeProps {
  currency: Currency;
  size?: "sm" | "md" | "lg";
}

// Circle's regional stablecoins have no artwork in web3icons' library —
// show the currency's COUNTRY FLAG instead (user decision: flags for any
// asset without a real coin logo). USDC/EURC keep their token icons.
const FLAG_TOKENS: Record<string, FlagComponent> = {
  BRLA: BR,
  AUDF: AU,
  MXNB: MX,
  QCAD: CA,
  GBPA: GB,
  ZARU: ZA,
  KRW1: KR,
};

function MonogramFallback({ symbol, px }: { symbol: string; px: number }) {
  return (
    <span
      className="flex items-center justify-center font-mono font-bold shrink-0 border border-border bg-surface text-ink-dim"
      style={{ width: px, height: px, fontSize: px * 0.4 }}
    >
      {symbol.slice(0, 1)}
    </span>
  );
}

export function TokenIcon({ currency, px }: { currency: Currency; px: number }) {
  const Flag = FLAG_TOKENS[currency];
  if (Flag) {
    // Circular crop so flags sit next to the round USDC/EURC coin marks as
    // equals — the 3:2 flag is center-cropped by the rounded-full clip.
    return (
      <span
        className="flex items-center justify-center shrink-0 overflow-hidden rounded-full border border-border"
        style={{ width: px, height: px }}
      >
        <Flag style={{ height: "100%", width: "auto", maxWidth: "none" }} />
      </span>
    );
  }
  return (
    <Web3TokenIcon
      symbol={currency}
      variant="mono"
      size={px}
      color="currentColor"
      fallback={<MonogramFallback symbol={currency} px={px} />}
    />
  );
}

export function TokenBadge({ currency, size = "md" }: TokenBadgeProps) {
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
      {currency}
    </span>
  );
}

// Inline currency selector
interface TokenSelectorProps {
  value: Currency;
  onChange: (currency: Currency) => void;
  label?: string;
}

// Dropdown, not a 9-chip spread — one compact control that scales as more
// currencies come online.
export function TokenSelector({ value, onChange, label }: TokenSelectorProps) {
  const currencies: Currency[] = Object.keys(CURRENCIES);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div className="flex flex-col gap-1.5" ref={ref}>
      {label && (
        <label className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider">
          {label}
        </label>
      )}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-scale-2
                     font-mono border border-border bg-surface text-ink
                     hover:border-ink-dim transition-colors"
        >
          <span className="flex items-center gap-2">
            <TokenIcon currency={value} px={20} />
            {value}
          </span>
          <svg
            className={`w-3 h-3 text-ink-dim transition-transform ${open ? "rotate-180" : ""}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {open && (
          <div
            role="listbox"
            className="absolute left-0 right-0 top-full mt-1 z-40 border border-border
                       bg-surface max-h-64 overflow-y-auto"
          >
            {currencies.map((currency) => (
              <button
                key={currency}
                type="button"
                role="option"
                aria-selected={value === currency}
                onClick={() => { onChange(currency); setOpen(false); }}
                className={`flex w-full items-center gap-2 px-3 py-2 text-scale-2 font-mono
                            text-left transition-colors ${
                              value === currency
                                ? "text-signal bg-signal/5"
                                : "text-ink-dim hover:text-ink hover:bg-bg/40"
                            }`}
              >
                <TokenIcon currency={currency} px={18} />
                {currency}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
