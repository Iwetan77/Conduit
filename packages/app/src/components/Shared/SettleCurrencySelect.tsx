"use client";

// The settle-currency picker, with each stablecoin's own logo in the list.
//
// This replaces four copies of a native <select> whose <option> labels carried
// a flag emoji ("🇪🇺 EURC"). An <option> can hold text and nothing else, so a
// real token logo is not expressible inside one — the control itself had to
// change for the mark to be visible where the choice is actually made.
//
// Deliberately the same shape as TokenSelector in TokenBadge.tsx (button +
// listbox, click-outside to close) rather than a second pattern. The two differ
// only in what they are keyed on: TokenSelector speaks TOKEN symbols (USDC),
// this speaks the ISO codes the API expects (USD), with isoToToken bridging.
//
// The value submitted is unchanged. Only the control is different.
import { useEffect, useRef, useState } from "react";
import type { Currency } from "@conduit/sdk/lite";
import { TokenIcon } from "./TokenBadge";
import { SETTLE_CURRENCIES, isoToToken } from "@/lib/currencies";

export function SettleCurrencySelect({
  value,
  onChange,
  className = "",
  label,
}: {
  value: string;
  onChange: (iso: string) => void;
  className?: string;
  label?: string;
}) {
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
    <div className={`relative ${className}`} ref={ref}>
      <button
        // type="button" matters: three of the four call sites sit inside a
        // <form>, where a bare button submits it.
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label ?? "Settle currency"}
        className="flex w-full items-center justify-between gap-2 bg-surface border border-border
                   px-3 py-2 text-sm text-ink hover:border-ink-dim focus:border-signal
                   focus:outline-none transition-colors"
      >
        <span className="flex items-center gap-2 min-w-0">
          <TokenIcon currency={isoToToken(value) as Currency} px={18} />
          <span className="truncate font-mono">{isoToToken(value)}</span>
        </span>
        <svg
          className={`w-3 h-3 shrink-0 text-ink-dim transition-transform ${open ? "rotate-180" : ""}`}
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
          {SETTLE_CURRENCIES.map((iso) => (
            <button
              key={iso}
              type="button"
              role="option"
              aria-selected={value === iso}
              onClick={() => { onChange(iso); setOpen(false); }}
              className={`flex w-full items-center gap-2 px-3 py-2 text-sm font-mono text-left
                          transition-colors ${
                            value === iso
                              ? "text-signal bg-signal/5"
                              : "text-ink-dim hover:text-ink hover:bg-bg/40"
                          }`}
            >
              <TokenIcon currency={isoToToken(iso) as Currency} px={18} />
              {isoToToken(iso)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
