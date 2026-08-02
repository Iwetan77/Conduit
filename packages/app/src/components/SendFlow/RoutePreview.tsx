"use client";

import type { Currency } from "@conduit/sdk/lite";
import { TokenBadge } from "@/components/Shared/TokenBadge";

interface RoutePreviewProps {
  payerCurrency: Currency;
  recipientCurrency: Currency;
  recipientAmount: string;
  payerAmount?: string;
  isLoading?: boolean;
}

export function RoutePreview({
  payerCurrency,
  recipientCurrency,
  recipientAmount,
  payerAmount,
  isLoading,
}: RoutePreviewProps) {
  const isSameCurrency = payerCurrency === recipientCurrency;

  return (
    <div className="bg-surface border border-border p-4 space-y-3">
      <p className="text-xs font-mono text-ink-dim uppercase tracking-wider">
        Route Preview
      </p>

      {/* Stacked on phones, side-by-side from sm up. Two columns of
          badge + amount don't fit a 390px viewport: the placeholder text
          wrapped to three lines and the recipient amount was pushed off the
          right edge. */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1 min-w-0 flex flex-col gap-1">
          <p className="text-xs text-ink-dim">You send</p>
          <div className="flex items-center gap-2 min-w-0">
            <TokenBadge currency={payerCurrency} />
            <span className="font-mono text-ink truncate">
              {isLoading ? (
                <span className="inline-block w-16 h-4 bg-border animate-pulse" />
              ) : payerAmount ? (
                payerAmount
              ) : isSameCurrency ? (
                recipientAmount
              ) : (
                <span className="text-ink-dim text-xs whitespace-nowrap">quoted at payment</span>
              )}
            </span>
          </div>
        </div>

        {/* The arrow points down when the sides are stacked. */}
        <div className="text-signal text-xl leading-none self-center sm:self-auto">
          <span className="sm:hidden">↓</span>
          <span className="hidden sm:inline">→</span>
        </div>

        <div className="flex-1 min-w-0 flex flex-col gap-1 sm:items-end">
          <p className="text-xs text-ink-dim">They receive</p>
          <div className="flex items-center gap-2 min-w-0">
            <TokenBadge currency={recipientCurrency} />
            <span className="font-mono text-ink truncate">{recipientAmount}</span>
          </div>
        </div>
      </div>

      {!isSameCurrency && (
        <div className="pt-2 border-t border-border">
          <div className="flex items-center gap-2 text-xs text-ink-dim">
            <span className="w-1.5 h-1.5 bg-signal" />
            Routed via Circle StableFX · Rate locked for 30s
          </div>
        </div>
      )}

      {isSameCurrency && (
        <div className="pt-2 border-t border-border">
          <div className="flex items-center gap-2 text-xs text-ink-dim">
            <span className="w-1.5 h-1.5 bg-signal" />
            Direct transfer · No FX conversion
          </div>
        </div>
      )}
    </div>
  );
}
