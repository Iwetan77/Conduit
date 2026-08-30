"use client";

import { useEffect, useRef, useState } from "react";
import type { Currency } from "@conduit/sdk/lite";
import { CURRENCIES } from "@conduit/sdk/lite";
import { tokenLogoPath } from "@/lib/currencies";

interface TokenBadgeProps {
  currency: Currency;
  size?: "sm" | "md" | "lg";
}

// Every token's OWN logo, from its issuer.
//
// This used to be a country flag per currency plus a drawn "$"/"€" disc for
// USDC and EURC, because no icon library carries artwork for Circle's regional
// stablecoins. A flag is the wrong object: BRLA is not Brazil, and CHFAU and a
// hypothetical second Swiss token would have shown the identical mark. These
// are the issuers' real marks, so the icon now identifies the ASSET rather than
// the country it tracks.
//
// Served from /public rather than bundled as React components: the share card
// (app/pay/[declarationId]/opengraph-image.tsx) reads these same files off disk
// for satori, so one copy feeds both surfaces and they cannot drift apart. The
// allowlist of which tokens have artwork lives in lib/currencies for the same
// reason.

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
  // A missing file must cost the mark, never leave a broken-image glyph on a
  // payment screen. The allowlist above makes this unreachable in a healthy
  // deploy; it exists for the one where /public did not ship.
  const [failed, setFailed] = useState(false);
  const src = tokenLogoPath(currency);

  if (!src || failed) return <MonogramFallback symbol={currency} px={px} />;

  // Plain <img>, not next/image: these are SVGs, which the image optimizer
  // refuses without dangerouslyAllowSVG, and LinkCard rasterises this subtree
  // with html-to-image — which inlines a same-origin <img> and would choke on
  // an optimizer URL.
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      aria-hidden="true"
      width={px}
      height={px}
      onError={() => setFailed(true)}
      className="shrink-0"
      // objectFit because not every issuer's mark is exactly square (GBPA's is
      // 85×84); letterboxing beats a 1% stretch.
      style={{ width: px, height: px, objectFit: "contain" }}
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
